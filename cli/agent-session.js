import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_AGENT_COMMAND, buildSpawnSpec, normalizeAgentCommand } from './bug-sweep.js';
import { assertNativeSkillAvailable, buildNativeSkillCall } from './native-skills.js';
import {
  buildFeatureSteps,
  buildStepPrompt,
  changedFiles,
  describeFeatureBuild,
  resolveFeaturePipeline
} from './feature-build.js';
import { renderSessionMarkdown, sessionRecordDir } from './session-history.js';

const MAX_BRIEF_LENGTH = 4000;
const DEFAULT_TURN_TIMEOUT_SECONDS = 1800;
const here = path.dirname(fileURLToPath(import.meta.url));

// A session is an interview with one human, driven by one skill. Every flow now
// runs on the same long-lived Claude Code stream-json process.
export const SESSION_FLOWS = {
  enhancement: {
    id: 'enhancement',
    label: 'Enhancement',
    skillName: 'enhancement',
    skillPath: path.resolve(here, '..', 'sdd', 'skills', 'enhancement', 'SKILL.md'),
    planLabel: 'plan',
    finalLabel: 'report',
    artifact: null
  },
  feature: {
    id: 'feature',
    label: 'Feature',
    skillName: 'deep-spec',
    skillPath: path.resolve(here, '..', 'sdd', 'skills', 'deep-spec', 'SKILL.md'),
    finalLabel: 'spec',
    artifact: { root: path.join('docs', 'sdd', 'features'), name: 'spec.md' },
    build: true
  },
  specIssue: {
    id: 'specIssue',
    label: 'Spec issue',
    skillName: 'deep-spec',
    skillPath: path.resolve(here, '..', 'sdd', 'skills', 'deep-spec', 'SKILL.md'),
    finalLabel: 'spec',
    artifact: { root: path.join('docs', 'sdd', 'features'), name: 'spec.md' }
  },
  merge: {
    id: 'merge',
    label: 'Merge',
    skillName: 'merge',
    skillPath: path.resolve(here, '..', 'vibecoding', 'skills', 'merge', 'SKILL.md'),
    finalLabel: 'merge report',
    mode: 'merge',
    artifact: null
  }
};

export function resolveSessionFlow(flow) {
  const config = SESSION_FLOWS[String(flow ?? '').trim()];

  if (!config) {
    const error = new Error(`Unknown session flow "${flow}". Use "enhancement", "feature", "specIssue", or "merge".`);
    error.statusCode = 400;
    throw error;
  }

  return config;
}

export function validateBrief(value) {
  const brief = String(value ?? '').trim();

  if (!brief) {
    const error = new Error('Describe what you want to change.');
    error.statusCode = 400;
    throw error;
  }

  if (brief.length > MAX_BRIEF_LENGTH) {
    const error = new Error(`The brief must be ${MAX_BRIEF_LENGTH} characters or fewer.`);
    error.statusCode = 400;
    throw error;
  }

  return brief;
}

export function validateSessionSkillArguments(flow, value = {}) {
  const config = resolveSessionFlow(flow);
  const schema = config.skillArguments ?? {};

  if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    const error = new Error('Skill arguments must be an object.');
    error.statusCode = 400;
    throw error;
  }

  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const unknown = Object.keys(input).filter((key) => !Object.hasOwn(schema, key));

  if (unknown.length) {
    const error = new Error(`Unsupported ${config.skillName} argument(s): ${unknown.join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }

  return Object.fromEntries(Object.entries(schema).map(([key, rule]) => {
    const raw = input[key] ?? rule.default;
    const number = Number(raw);

    if (!Number.isInteger(number) || number < rule.min || number > rule.max) {
      const error = new Error(`${key} must be an integer from ${rule.min} to ${rule.max}.`);
      error.statusCode = 400;
      throw error;
    }

    return [key, number];
  }));
}

export function readSessionSkill(flow) {
  const config = resolveSessionFlow(flow);

  try {
    return fs.readFileSync(config.skillPath, 'utf8');
  } catch {
    return '';
  }
}

// Every flow forwards the request straight to its skill. The skill owns the
// interview, approval rules, and output format; Studio owns side effects.
export function buildSessionInstructions(flow, { skillArguments = {} } = {}) {
  const config = resolveSessionFlow(flow);

  return buildNativeSkillCall(config.skillName, skillArguments);
}

// The first user message: the skill call plus the human's brief.
export function buildSessionOpening(flow, brief, options = {}) {
  return [
    buildSessionInstructions(flow, options),
    '',
    validateBrief(brief)
  ].join('\n');
}

// The interview ends structurally, never by reading prose. A flow with an
// artifact is over when that file is written; a flow without one is over when
// the human closes the session or the integration ref exists. Taking the
// snapshot before the first turn keeps an old spec from ending a new session.
export function snapshotArtifacts(cwd, config) {
  const snapshot = new Map();

  if (!config?.artifact) {
    return snapshot;
  }

  const root = path.resolve(cwd, config.artifact.root);
  let entries;

  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return snapshot;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const file = path.join(root, entry.name, config.artifact.name);

    try {
      snapshot.set(file, fs.statSync(file).mtimeMs);
    } catch {
      // Not written yet.
    }
  }

  return snapshot;
}

export function findSessionArtifact(cwd, config, before = new Map()) {
  if (!config?.artifact) {
    return null;
  }

  const root = path.resolve(cwd, config.artifact.root);
  let entries;

  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  let newest = null;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const file = path.join(root, entry.name, config.artifact.name);
    let stat;

    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }

    if (before.get(file) === stat.mtimeMs) {
      continue;
    }

    if (newest && stat.mtimeMs <= newest.mtimeMs) {
      continue;
    }

    newest = { path: file, mtimeMs: stat.mtimeMs };
  }

  return newest?.path ?? null;
}

// The written artifact is the better preview: the agent's last message is often
// just "spec written". Fall back to the message when the file cannot be read.
function readArtifact(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8').trim() || fallback;
  } catch {
    return fallback;
  }
}

// A merge ends when its integration branch exists. That is a structural signal,
// not a phrase in the agent's reply.
export function refExists(cwd, ref) {
  if (!ref) {
    return false;
  }

  try {
    return spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], {
      cwd,
      encoding: 'utf8',
      windowsHide: true
    }).status === 0;
  } catch {
    return false;
  }
}

// The merge skill may run git and edit conflict files, but never the target
// branch and never a remote. The Claude hook asks; this decides before a human
// is interrupted.
const MERGE_FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MERGE_GIT_SAFE = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'merge-base', 'merge-tree',
  'ls-files', 'ls-tree', 'cat-file', 'for-each-ref', 'show-ref', 'rev-list',
  'diff-tree', 'name-rev', 'describe', 'add', 'commit', 'merge', 'restore',
  'branch', 'checkout', 'switch', 'stash'
]);

function gitCommandParts(command) {
  const tokens = String(command).trim().split(/\s+/);

  if (tokens[0] !== 'git') {
    return null;
  }

  let index = 1;

  // Only harmless global flags are parsed. -C, -c, --git-dir and --work-tree
  // point at another repository or config, so those go to the human instead.
  while (index < tokens.length && tokens[index].startsWith('-')) {
    if (tokens[index] === '--no-pager' || tokens[index] === '--no-optional-locks') {
      index += 1;
      continue;
    }

    return null;
  }

  if (index >= tokens.length) {
    return null;
  }

  return { sub: tokens[index], args: tokens.slice(index + 1) };
}

export function mergePermissionDecision(request = {}, { target = '' } = {}) {
  const tool = String(request.tool ?? '');

  if (MERGE_FILE_TOOLS.has(tool)) {
    return { behavior: 'allow', reason: 'merge-edit' };
  }

  if (tool !== 'Bash') {
    return null;
  }

  const command = String(request.detail ?? '').trim().replace(/\s+/g, ' ');

  // A compound command is not parsed; it goes to the human instead of being
  // guessed at. This keeps `git status && git push` from looking safe.
  if (!command || /[;&|><\n]/.test(command)) {
    return null;
  }

  const parts = gitCommandParts(command);

  if (!parts) {
    return null;
  }

  const { sub, args } = parts;
  const deny = (rule) => ({ behavior: 'deny', reason: 'merge-guard', rule });

  if (['push', 'remote', 'update-ref', 'symbolic-ref'].includes(sub)) {
    return deny('remote');
  }

  if (args.some((arg) => arg === '--force' || arg === '--force-with-lease')) {
    return deny('force');
  }

  if (sub === 'reset' && args.includes('--hard')) {
    return deny('reset');
  }

  if (sub === 'clean' && args.some((arg) => /^-[a-z]*f/.test(arg))) {
    return deny('clean');
  }

  if (sub === 'commit' && args.includes('--amend')) {
    return deny('amend');
  }

  // Creating a branch from the target stays allowed; checking the target out
  // does not.
  if (sub === 'checkout' || sub === 'switch') {
    const createFlags = ['-b', '-B', '-c', '-C'];
    const createAt = args.findIndex((arg) => createFlags.includes(arg));

    if (createAt !== -1) {
      if (args[createAt + 1] === target) {
        return deny('target');
      }
    } else {
      const positionals = args.filter((arg) => !arg.startsWith('-'));
      const first = positionals[0] ?? '';

      if (first === target || first === '-' || first.startsWith('@{-')) {
        return deny('target');
      }
    }
  }

  if (sub === 'branch') {
    const risky = args.some((arg) => ['-D', '-d', '-m', '-M', '-f', '--delete', '--force', '--move'].includes(arg));

    if (risky && args.includes(target)) {
      return deny('target');
    }
  }

  if (MERGE_GIT_SAFE.has(sub)) {
    return { behavior: 'allow', reason: 'merge-git' };
  }

  return null;
}

// The user's argv plus the streaming flags. Reads are pre-approved; every other
// tool becomes a PermissionRequest, which the Studio forwards to the human.
export function buildLiveCommand(command, { settings, model = '', effort = '' } = {}) {
  const argv = [...command.argv];
  const has = (flag) => argv.includes(flag);
  const hasSettings = argv.some((arg) => arg === '--settings' || arg.startsWith('--settings='));
  const live = [...argv];

  if (!has('-p') && !has('--print')) {
    live.push('-p');
  }
  if (!has('--input-format')) {
    live.push('--input-format', 'stream-json');
  }
  if (!has('--output-format')) {
    live.push('--output-format', 'stream-json');
  }
  if (!has('--verbose')) {
    live.push('--verbose');
  }
  if (!has('--include-partial-messages')) {
    live.push('--include-partial-messages');
  }
  if (!has('--permission-mode') && !has('--allowedTools') && !has('--dangerously-skip-permissions')) {
    live.push('--allowedTools', 'Read,Grep,Glob');
  }
  if (model && !has('--model') && model.toLowerCase() !== 'default') {
    live.push('--model', model);
  }
  if (effort && !has('--effort') && effort.toLowerCase() !== 'default') {
    live.push('--effort', effort);
  }
  if (settings && !hasSettings) {
    live.push('--settings', settings);
  }

  return { command: live[0], args: live.slice(1) };
}

// A settings layer is the only way to add a hook without touching the user's
// configuration. `-p` sessions treat the folder as trusted, so the hook runs.
export function permissionHookSettings(dir) {
  const script = path.join(here, 'session-hook.js');
  const requestFile = path.join(dir, 'permission.json');
  const quote = (value) => `"${String(value).replace(/\\/g, '/')}"`;
  const command = [process.execPath, script, requestFile].map(quote).join(' ');

  return JSON.stringify({
    hooks: {
      PermissionRequest: [
        {
          hooks: [{ type: 'command', command, timeout: 60 }]
        }
      ]
    }
  });
}

function sessionDir(cwd, config, id) {
  const dir = sessionRecordDir(cwd, config.id, id);

  fs.mkdirSync(dir, { recursive: true });

  return dir;
}

function cancelledError() {
  const error = new Error('The session was stopped.');

  error.cancelled = true;

  return error;
}

function terminateProcess(child) {
  if (!child || child.killed) {
    return;
  }

  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
    } catch {
      // The process may already be gone.
    }
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // The process may already be gone.
  }
}

function describeTool(block) {
  const input = block?.input ?? {};
  const target = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.query ?? '';

  return target ? `${block.name} ${target}` : String(block?.name ?? 'tool');
}

function liveTurnController(emit) {
  let pending = null;

  return {
    begin() {
      return new Promise((resolve, reject) => {
        pending = { text: '', sawDelta: false, assistantText: '', resolve, reject };
      });
    },
    hasPending() {
      return Boolean(pending);
    },
    delta(text) {
      if (!pending || !text) {
        return;
      }

      pending.text += text;
      pending.sawDelta = true;
      emit({ type: 'output', stream: 'stdout', chunk: text });
    },
    assistantText(text) {
      if (!pending || !text) {
        return;
      }

      pending.assistantText += text;

      // Without partial messages the whole block arrives at once; stream it so
      // the terminal still fills in.
      if (!pending.sawDelta) {
        pending.text += text;
        emit({ type: 'output', stream: 'stdout', chunk: text });
      }
    },
    finish(resultText) {
      if (!pending) {
        return;
      }

      const turn = pending;

      pending = null;
      turn.resolve(turn.text.trim() ? turn.text : (turn.assistantText || resultText || ''));
    },
    fail(error) {
      if (!pending) {
        return;
      }

      const turn = pending;

      pending = null;
      turn.reject(error);
    }
  };
}

function parseLiveLine(line, { controller, emit }) {
  emit({ type: 'raw', line });

  let event;

  try {
    event = JSON.parse(line);
  } catch {
    // A non-JSON line is not part of the protocol; ignore it.
    return;
  }

  if (event.type === 'stream_event') {
    const inner = event.event ?? {};

    if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
      controller.delta(inner.delta.text ?? '');
    }
    return;
  }

  if (event.type === 'assistant') {
    const content = event.message?.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && block.text) {
          controller.assistantText(block.text);
        } else if (block?.type === 'tool_use') {
          emit({ type: 'activity', label: describeTool(block) });
        }
      }
    }
    return;
  }

  if (event.type === 'result') {
    if (event.is_error || String(event.subtype ?? '').startsWith('error')) {
      controller.fail(new Error(event.result || `The agent stopped: ${event.subtype || 'error'}.`));
      return;
    }

    controller.finish(event.result ?? '');
  }
}

// One long-lived agent process. Answers are written to stdin as stream-json user
// messages and each `result` marks the end of a turn.
const PERMISSION_WAIT_MS = 52_000;

// The hook gives up at 50s. The Studio must give up first, or a request nobody
// answered would leave the session parked forever.
function permissionDecision(pending) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ behavior: 'deny', expired: true }), PERMISSION_WAIT_MS);

    timer.unref?.();

    Promise.resolve(pending).then(
      (value) => {
        clearTimeout(timer);
        resolve(value ?? { behavior: 'deny' });
      },
      () => {
        clearTimeout(timer);
        resolve({ behavior: 'deny' });
      }
    );
  });
}

async function runLiveSession({ config, brief, command, cwd, id, dir, emit, deps, artifactsBefore }) {
  const permissionFile = path.join(dir, 'permission.json');
  const permissionAnswer = `${permissionFile}.answer`;

  // A stale request from an earlier run must not answer this one.
  fs.rmSync(permissionFile, { force: true });
  fs.rmSync(permissionAnswer, { force: true });

  const spec = buildSpawnSpec(buildLiveCommand(command, {
    settings: permissionHookSettings(dir),
    model: deps.model,
    effort: deps.effort
  }));
  const spawnProcess = deps.spawnProcess ?? spawn;
  const timeoutSeconds = Number(deps.turnTimeoutSeconds) > 0
    ? Number(deps.turnTimeoutSeconds)
    : DEFAULT_TURN_TIMEOUT_SECONDS;
  const timeoutMs = timeoutSeconds * 1000;
  const controller = liveTurnController(emit);
  const turns = [];
  const writeTranscript = () => {
    try {
      fs.writeFileSync(
        path.join(dir, 'session.md'),
        renderSessionMarkdown({ flow: config.id, brief, status: 'running', turns }),
        'utf8'
      );
    } catch {
      // The transcript is a convenience; the run must not fail on it.
    }
  };

  let child;

  try {
    child = spawnProcess(spec.command, spec.args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(deps.agentEnv ?? {}),
        SDD_SESSION_ID: id,
        SDD_SESSION_FLOW: config.id
      }
    });
  } catch (error) {
    throw new Error(`The agent could not be started: ${error.message}`);
  }

  let watchdog = null;
  let stderr = '';
  let buffer = '';
  let exited = null;
  let exitError = null;
  let resolveExit;
  const exitSignal = new Promise((resolve) => {
    resolveExit = resolve;
  });
  let runs = 0;
  const terminate = deps.terminate ?? terminateProcess;
  const seenPermissions = new Set();

  let permissionTimer = null;

  const stopPermissionWatch = () => {
    if (permissionTimer) {
      clearInterval(permissionTimer);
      permissionTimer = null;
    }
  };

  // The hook blocks Claude while it waits for an answer file, so a slow human
  // does not lose the turn. The request is answered once, then ignored.
  const pollPermission = async () => {
    let request;

    try {
      request = JSON.parse(fs.readFileSync(permissionFile, 'utf8'));
    } catch {
      return;
    }

    if (!request?.id || seenPermissions.has(request.id)) {
      return;
    }

    seenPermissions.add(request.id);

    // The merge guard decides file edits and safe git commands without waking
    // the human. Anything it does not understand falls through to the normal
    // approval plate.
    const guard = config.mode === 'merge'
      ? mergePermissionDecision(
        { tool: request.tool ?? 'tool', detail: request.detail ?? '' },
        { target: deps.merge?.target ?? '' }
      )
      : null;

    if (guard) {
      try {
        fs.writeFileSync(permissionAnswer, JSON.stringify({ behavior: guard.behavior }), 'utf8');
      } catch {
        // The hook falls back to denying when it cannot read an answer.
      }

      if (guard.behavior === 'deny') {
        emit({
          type: 'guard',
          behavior: 'deny',
          tool: request.tool ?? 'tool',
          detail: request.detail ?? '',
          reason: guard.rule ?? guard.reason ?? 'merge-guard'
        });
      }

      emit({
        type: 'permission-answer',
        id: request.id,
        behavior: guard.behavior,
        reason: 'merge-guard'
      });
      return;
    }

    const decision = await permissionDecision(deps.waitForPermission?.({
      id: request.id,
      tool: request.tool ?? 'tool',
      detail: request.detail ?? '',
      description: request.description ?? '',
      flow: config.id
    }));
    const behavior = decision?.behavior === 'allow' ? 'allow' : 'deny';

    try {
      fs.writeFileSync(permissionAnswer, JSON.stringify({ behavior }), 'utf8');
    } catch {
      // The hook falls back to denying when it cannot read an answer.
    }

    emit({
      type: 'permission-answer',
      id: request.id,
      behavior,
      reason: decision?.expired ? 'expired' : 'human'
    });
  };

  permissionTimer = setInterval(() => {
    void pollPermission();
  }, 250);

  const clearWatchdog = () => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };

  const writeUserMessage = (text) => {
    if (child.stdin?.destroyed || child.exitCode !== null) {
      throw new Error('The agent closed the session early.');
    }

    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] }
    });

    emit({ type: 'raw', direction: 'in', line: payload });
    child.stdin.write(`${payload}\n`);
  };

  const advanceTurn = (text) => {
    const promise = controller.begin();

    runs += 1;
    emit({ type: 'turn-started', turn: runs });

    clearWatchdog();
    watchdog = setTimeout(() => {
      controller.fail(new Error(`The agent did not finish a reply within ${timeoutSeconds} seconds.`));
    }, timeoutMs);

    writeUserMessage(text);

    return promise;
  };

  child.stdout?.setEncoding?.('utf8');
  child.stdout?.on('data', (chunk) => {
    buffer += chunk.toString();

    let index;

    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '').trim();

      buffer = buffer.slice(index + 1);

      if (line) {
        parseLiveLine(line, { controller, emit });
      }
    }
  });
  child.stderr?.setEncoding?.('utf8');
  child.stderr?.on('data', (chunk) => {
    // Keep diagnostics available if the turn fails, but never mix them into
    // the user-facing transcript (stderr can contain provider/tool details).
    stderr += chunk.toString();
  });
  child.stdin?.on?.('error', (error) => {
    exitError = error;
    controller.fail(error);
  });
  child.on?.('error', (error) => {
    exitError = error;
    controller.fail(error);
    resolveExit?.();
  });
  child.on?.('close', (code) => {
    exited = code;

    if (controller.hasPending()) {
      controller.fail(
        new Error(
          `The agent closed the session (exit ${code ?? 'unknown'}).${stderr.trim() ? ` ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`
        )
      );
    }

    resolveExit?.({ code, stderr });
  });

  const onAbort = () => {
    controller.fail(cancelledError());
    terminate(child);
    resolveExit?.({ aborted: true });
  };

  if (deps.signal) {
    if (deps.signal.aborted) {
      onAbort();
    } else {
      deps.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  // An idle process that exits (for example a provider error while waiting for
  // a human) fails the session; it is never resumed automatically.
  const whileAlive = async (promise) => {
    const outcome = await Promise.race([
      Promise.resolve(promise).then((value) => ({ value })),
      exitSignal.then((exit) => ({ exit }))
    ]);

    if (outcome.exit) {
      if (deps.signal?.aborted || outcome.exit.aborted) {
        throw cancelledError();
      }

      const detail = String(outcome.exit.stderr ?? stderr).trim().split('\n').slice(-3).join(' ');

      throw new Error(
        `The agent closed the session unexpectedly (exit ${outcome.exit.code ?? 'unknown'}).${detail ? ` ${detail}` : ''}`
      );
    }

    return outcome.value;
  };

  try {
    // A turn that ends without any assistant text is a broken agent call, not
    // a question. Fail with the agent's own diagnostic instead of showing an
    // empty "needs your answer" plate.
    const nextTurn = async (text) => {
      const reply = await advanceTurn(text);

      if (!String(reply ?? '').trim()) {
        const diagnostic = stderr.trim().split('\n').slice(-3).join(' ');

        throw new Error(
          diagnostic
            ? `The agent returned no reply: ${diagnostic}`
            : 'The agent returned no reply.'
        );
      }

      return reply;
    };

    let turnText = await nextTurn(buildSessionOpening(config.id, brief, {
      skillArguments: deps.skillArguments
    }));

    while (true) {
      clearWatchdog();
      turns.push({ role: 'assistant', text: turnText });
      writeTranscript();
      deps.onTurn?.({ turns: [...turns], text: turnText });

      const artifact = findSessionArtifact(cwd, config, artifactsBefore);

      if (artifact && config.id === 'feature') {
        const specRelative = path.relative(cwd, artifact).split(path.sep).join('/');

        turns.push({ role: 'marker', text: 'spec.md yazıldı' });
        emit({ type: 'build-ready', artifact, spec: specRelative });
        writeTranscript();

        if (!deps.waitForBuild) {
          throw new Error('This feature session cannot start a build.');
        }

        const choice = await whileAlive(deps.waitForBuild({
          sessionId: id,
          artifact,
          spec: specRelative,
          text: turnText
        }));

        if (choice?.cancelled || deps.signal?.aborted) {
          throw cancelledError();
        }

        const pipeline = resolveFeaturePipeline(choice?.pipeline);
        const verify = choice?.verify !== false;
        const described = describeFeatureBuild({ specPath: artifact, cwd });
        const steps = buildFeatureSteps({
          pipeline: pipeline.id,
          specRelative: described.specRelative,
          featureRelative: described.featureRelative,
          verify
        });

        turns.push({ role: 'marker', text: `build · ${pipeline.label}` });
        emit({
          type: 'build-started',
          pipeline: pipeline.id,
          verify,
          spec: described.specRelative,
          steps: steps.map((step) => ({ skill: step.skill, args: step.args }))
        });
        writeTranscript();

        const results = [];

        for (const [index, step] of steps.entries()) {
          emit({ type: 'build-step', index, skill: step.skill, status: 'running' });
          turns.push({ role: 'marker', text: `step ${index + 1}/${steps.length}  ${step.skill}` });
          writeTranscript();

          try {
            turnText = await nextTurn(buildStepPrompt(step));

            if (step.produces && !fs.existsSync(described.featurePath)) {
              throw new Error(`${step.skill} finished without writing ${step.produces}.`);
            }
          } catch (error) {
            // A failed step is reported where it happened, not only on the job.
            emit({
              type: 'build-step',
              index,
              skill: step.skill,
              status: 'failed',
              error: error.message
            });
            turns.push({ role: 'marker', text: `step ${index + 1}/${steps.length} failed` });
            writeTranscript();
            throw error;
          }

          turns.push({ role: 'assistant', text: turnText });
          emit({ type: 'build-step', index, skill: step.skill, status: 'done' });
          writeTranscript();
          deps.onTurn?.({ turns: [...turns], text: turnText });
          results.push({ skill: step.skill, args: step.args });
        }

        const changed = await changedFiles(cwd);

        turns.push({ role: 'marker', text: 'build done' });
        emit({ type: 'build-done', changed: changed.length });
        writeTranscript();

        return {
          output: readArtifact(artifact, turnText),
          turns,
          engine: 'live',
          stderr,
          artifact,
          build: {
            pipeline: pipeline.id,
            verify,
            specPath: described.specPath,
            featurePath: described.featurePath,
            steps: results,
            verified: verify,
            changedFiles: changed
          }
        };
      }

      if (artifact) {
        return {
          output: readArtifact(artifact, turnText),
          turns,
          engine: 'live',
          stderr,
          artifact
        };
      }

      if (deps.merge?.ref && refExists(cwd, deps.merge.ref)) {
        return { output: turnText, turns, engine: 'live', stderr, ref: deps.merge.ref };
      }

      const reply = await whileAlive(deps.waitForAnswer({ text: turnText, flow: config.id }));

      if (reply?.cancelled || deps.signal?.aborted) {
        throw cancelledError();
      }

      if (reply?.done) {
        return { output: turnText, turns, engine: 'live', stderr };
      }

      turns.push({ role: 'user', text: reply?.answer ?? '' });
      writeTranscript();
      turnText = await nextTurn(reply?.answer ?? '');
    }
  } finally {
    clearWatchdog();
    stopPermissionWatch();
    deps.signal?.removeEventListener?.('abort', onAbort);

    try {
      child.stdin?.end();
    } catch {
      // Best effort.
    }

    terminate(child);

    if (exited === null) {
      // Give the process a moment to die so the port and files are released.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    writeTranscript();
  }
}

// Run a full interview session to its structural end. The caller supplies
// `waitForAnswer` and, for features, `waitForBuild`. Answers are new user
// messages in the same process; there is no replay or resume path.
export async function runInterviewSession(request = {}, dependencies = {}) {
  const config = resolveSessionFlow(request.flow);
  const brief = validateBrief(request.brief);
  const skillArguments = {
    ...validateSessionSkillArguments(config.id, request.skillArguments),
    ...(config.mode === 'merge' && request.merge
      ? { arguments: [request.merge.source, request.merge.target].filter(Boolean).join(' ') }
      : {})
  };
  const cwd = dependencies.cwd ?? process.cwd();
  const stateCwd = dependencies.stateCwd ?? cwd;
  const id = dependencies.id ?? `session-${Date.now()}`;
  const emit = dependencies.emit ?? (() => {});
  const command = normalizeAgentCommand(DEFAULT_AGENT_COMMAND);
  const dir = sessionDir(stateCwd, config, id);
  const merge = request.merge ?? dependencies.merge ?? null;
  const sessionDeps = {
    ...dependencies,
    skillArguments,
    ...(merge ? { merge } : {})
  };
  // A spec that exists before the first turn belongs to an earlier session.
  const artifactsBefore = snapshotArtifacts(cwd, config);

  assertNativeSkillAvailable(stateCwd, config.skillName);

  emit({
    type: 'session-started',
    flow: config.id,
    engine: 'live',
    brief,
    model: dependencies.model ?? '',
    effort: dependencies.effort ?? ''
  });

  const result = await runLiveSession({
    config,
    brief,
    command,
    cwd,
    id,
    dir,
    emit,
    deps: sessionDeps,
    artifactsBefore
  });

  return {
    ...result,
    brief,
    flow: config.id,
    dir,
    skillArguments,
    ...(merge ? { merge } : {})
  };
}

export { DEFAULT_TURN_TIMEOUT_SECONDS };
