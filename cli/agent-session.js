import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_AGENT_COMMAND,
  DEFAULT_WORK_DIR,
  buildAgentInvocation,
  buildSpawnSpec,
  normalizeAgentCommand,
  prepareWorkDir,
  runProcess
} from './bug-sweep.js';

const MAX_BRIEF_LENGTH = 4000;
const DEFAULT_TURN_TIMEOUT_SECONDS = 1800;
const here = path.dirname(fileURLToPath(import.meta.url));

// A session is an interview with one human, driven by one skill. The skill file
// itself is never modified; the studio only wraps it in an interaction contract.
export const SESSION_FLOWS = {
  enhancement: {
    id: 'enhancement',
    label: 'Enhancement',
    skillName: 'enhancement',
    skillPath: path.resolve(here, '..', 'sdd', 'skills', 'enhancement', 'SKILL.md'),
    workDir: 'enhancements',
    finalLabel: 'plan',
    // The enhancement skill has no artifact: the human closes the session.
    artifact: null
  },
  feature: {
    id: 'feature',
    label: 'Feature',
    skillName: 'deep-spec',
    skillPath: path.resolve(here, '..', 'sdd', 'skills', 'deep-spec', 'SKILL.md'),
    workDir: 'features',
    finalLabel: 'spec',
    // deep-spec writes the spec only when the interview is over, so a new or
    // touched spec file is the structural end-of-interview signal.
    artifact: { root: path.join('docs', 'sdd', 'features'), name: 'spec.md' }
  }
};

export function resolveSessionFlow(flow) {
  const config = SESSION_FLOWS[String(flow ?? '').trim()];

  if (!config) {
    const error = new Error(`Unknown session flow "${flow}". Use "enhancement" or "feature".`);
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

export function readSessionSkill(flow) {
  const config = resolveSessionFlow(flow);

  try {
    return fs.readFileSync(config.skillPath, 'utf8');
  } catch {
    return '';
  }
}

// The contract that turns a plan-and-build skill into an interview the studio
// can render: one question per turn, then the final artifact. The skill file is
// never modified; this wrapper only changes how the turns are paced.
export function buildSessionInstructions(flow, { skillText = readSessionSkill(flow) } = {}) {
  const config = resolveSessionFlow(flow);
  const artifactRoot = config.artifact
    ? config.artifact.root.split(path.sep).join('/')
    : '';
  const lines = [
    `# ${config.label} session`,
    '',
    `You are running the \`${config.skillName}\` workflow as a guided interview with one`,
    'human. You and the human take turns in a chat.',
    '',
    '## How this session works',
    '',
    `- Every reply from you is either the next single question, or the final ${config.finalLabel}.`,
    '- Ask exactly one question at a time and keep the reply focused on it.',
    '- When you have enough to decide, do NOT ask another question. Produce the',
    `  final ${config.finalLabel} in that reply instead.`,
    "- The human's next message is their answer to your last question.",
    '- Never stop to wait on your own; always end a reply with a question or the',
    `  final ${config.finalLabel}.`,
    '',
    '## Rules for this session',
    '',
    `- You may read the repository to ground your questions and the ${config.finalLabel}.`
  ];

  if (config.artifact) {
    lines.push(
      '- You may create exactly one file: the final spec at',
      `  \`${artifactRoot}/<feature-name>/${config.artifact.name}\`. Do not create or`,
      '  modify anything else. Do not commit. Do not push.'
    );
  } else {
    lines.push('- Do not modify, create, or delete any file. Do not commit. Do not push.');
  }

  lines.push(
    '- Do not run commands that change the repository or its dependencies.',
    '- Do not touch Jira or any external tracker.',
    `- Stop at the ${config.finalLabel}. Do not implement anything yet.`,
    '- Ask only about decisions you cannot infer; state your assumptions for the rest.',
    ''
  );

  lines.push(`## What the final ${config.finalLabel} must contain`, '');

  if (config.finalLabel === 'plan') {
    lines.push(
      'A Markdown enhancement plan. Include:',
      '',
      '1. A short summary of the change in plain language.',
      '2. A Mermaid flowchart in a fenced ```mermaid block showing the flow or the',
      '   before/after shape.',
      '3. Components affected, with file paths.',
      '4. Views affected: pages, endpoints, services, or data flows.',
      '5. Implementation and verification: the smallest change, the tests or checks,',
      '   and the known risks.',
      '6. Open Questions: at most three, each one decision the human must still make.',
      '',
      'Keep it specific to this repository. Prefer existing patterns over new ones.'
    );
  } else {
    lines.push(
      'A Markdown feature spec following the deep-spec workflow. Include:',
      '',
      '1. The problem and the outcome in plain language.',
      '2. The decisions reached during the interview, and the reasoning.',
      '3. A Mermaid flowchart in a fenced ```mermaid block for the main flow.',
      '4. Components, data, and interfaces affected, with file paths.',
      '5. The verification plan.',
      '6. Open Questions: decisions that are still unresolved.',
      '',
      `Write the spec to \`${artifactRoot}/<feature-name>/${config.artifact.name}\` and`,
      'present the same content inline as your final reply. Writing that file is what',
      'ends the interview, so write it once, at the end, and only then.'
    );
  }

  lines.push(
    '',
    '## Diagrams',
    '',
    '- Wherever a diagram carries the meaning, draw it with Mermaid in a fenced',
    '  ```mermaid block — flowcharts, sequence diagrams, state diagrams, ER',
    '  diagrams, data flows. The reader renders Mermaid inline, so a real diagram',
    '  beats a text sketch.',
    "- Keep the ASCII mock preview the skill asks for when the diagram is a UI",
    '  layout or a before/after wireframe: Mermaid cannot draw a screen. Use ASCII',
    '  for anything that must line up column by column or sit at an exact position.',
    '- Do not draw the same thing twice, once as ASCII and once as Mermaid.',
    ''
  );

  if (skillText) {
    lines.push(
      '',
      '## Skill instructions',
      '',
      `Follow the ${config.skillName} skill below, adapted to this interview loop so`,
      `that this session stops at the ${config.finalLabel}.`,
      '',
      '---',
      '',
      skillText.trim(),
      '',
      '---'
    );
  } else {
    lines.push('', `Use the \`${config.skillName}\` skill when it is available.`);
  }

  lines.push('');

  return lines.join('\n');
}

// The first message of a live session: the whole contract plus the request.
export function buildSessionOpening(flow, brief) {
  return [
    buildSessionInstructions(flow),
    '## The request',
    '',
    validateBrief(brief),
    '',
    'Start the interview now. Ask your first single question.'
  ].join('\n');
}

// A self-contained prompt for agents that cannot hold a live conversation: the
// accumulated transcript is replayed and the agent asks the next question.
export function buildTurnPrompt(flow, { brief, turns = [] } = {}) {
  const config = resolveSessionFlow(flow);
  const lines = [
    buildSessionInstructions(flow),
    '## Conversation so far',
    '',
    `**Human:** ${validateBrief(brief)}`
  ];

  for (const turn of turns) {
    lines.push('', turn.role === 'assistant' ? '**You:**' : '**Human:**', '', String(turn.text ?? ''));
  }

  lines.push(
    '',
    '## Now',
    '',
    turns.length === 0
      ? 'Ask your first single question.'
      : `Continue: ask the next single question, or, if you have enough, produce the`
        + ` final ${config.finalLabel}.`,
    ''
  );

  return lines.join('\n');
}

// The interview ends structurally, never by reading the prose. A flow with an
// artifact is over when that file is written; a flow without one is over when
// the human closes the session. Taking a snapshot before the first turn is what
// keeps a spec from a past session from ending a new one.
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

// The executable decides whether the agent can hold one live conversation. Only
// Claude Code exposes the stream-json protocol the studio drives; everything
// else uses the replay-per-turn engine with the same UI.
export function agentExecutable(command) {
  const token = command?.argv?.[0] ?? '';

  return path
    .basename(String(token))
    .toLowerCase()
    .replace(/\.(cmd|exe|bat|ps1|sh)$/, '');
}

export function detectAgentEngine(command, agentPreset) {
  if (agentPreset && agentPreset !== 'claude' && agentPreset !== 'custom') {
    return 'turn';
  }

  return agentExecutable(command) === 'claude' ? 'live' : 'turn';
}

// The user's argv plus the streaming flags. Reads are pre-approved; every other
// tool becomes a PermissionRequest, which the studio forwards to the human.
export function buildLiveCommand(command, { settings } = {}) {
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

function sessionDir(cwd, id, config) {
  const workDir = path.resolve(cwd, DEFAULT_WORK_DIR);

  prepareWorkDir(workDir);

  const dir = path.join(workDir, config.workDir, id);

  fs.mkdirSync(dir, { recursive: true });

  return dir;
}

function writeFile(dir, name, text) {
  try {
    fs.writeFileSync(path.join(dir, name), `${text}\n`, 'utf8');
  } catch {
    // The session on disk is a convenience; the run must not fail on it.
  }
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

// The hook gives up at 50s. The studio must give up first, or a request nobody
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

  const spec = buildSpawnSpec(buildLiveCommand(command, { settings: permissionHookSettings(dir) }));
  const spawnProcess = deps.spawnProcess ?? spawn;
  const timeoutSeconds = Number(deps.turnTimeoutSeconds) > 0
    ? Number(deps.turnTimeoutSeconds)
    : DEFAULT_TURN_TIMEOUT_SECONDS;
  const timeoutMs = timeoutSeconds * 1000;
  const controller = liveTurnController(emit);
  const turns = [];

  let child;

  try {
    child = spawnProcess(spec.command, spec.args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
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

    // Record the decision either way, so a replayed session never shows an
    // answerable plate for a request that has already expired.
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
      throw new Error(
        'The agent closed the session early. This agent may not support interactive streaming;'
        + ' pick Claude Code, or use the replay-per-turn engine by choosing another agent.'
      );
    }

    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] }
    });

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
    const text = chunk.toString();

    stderr += text;
    emit({ type: 'output', stream: 'stderr', chunk: text });
  });
  child.stdin?.on?.('error', (error) => controller.fail(error));
  child.on?.('error', (error) => controller.fail(error));
  child.on?.('close', (code) => {
    exited = code;

    if (controller.hasPending()) {
      controller.fail(
        new Error(
          `The agent closed the session (exit ${code ?? 'unknown'}).${stderr.trim() ? ` ${stderr.trim()}` : ''}`
        )
      );
    }
  });

  const onAbort = () => {
    controller.fail(cancelledError());
    terminate(child);
  };

  if (deps.signal) {
    if (deps.signal.aborted) {
      onAbort();
    } else {
      deps.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    let turnText = await advanceTurn(buildSessionOpening(config.id, brief));

    while (true) {
      clearWatchdog();
      turns.push({ role: 'assistant', text: turnText });

      const artifact = findSessionArtifact(cwd, config, artifactsBefore);

      if (artifact) {
        return {
          output: readArtifact(artifact, turnText),
          turns,
          engine: 'live',
          stderr,
          artifact
        };
      }

      const reply = await deps.waitForAnswer({ text: turnText, flow: config.id });

      if (reply?.cancelled || deps.signal?.aborted) {
        throw cancelledError();
      }

      if (reply?.done) {
        return { output: turnText, turns, engine: 'live', stderr };
      }

      turns.push({ role: 'user', text: reply?.answer ?? '' });
      turnText = await advanceTurn(reply?.answer ?? '');
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

    writeFile(
      dir,
      'session.md',
      turns.map((turn) => `## ${turn.role === 'assistant' ? 'Agent' : 'Human'}\n\n${turn.text}`).join('\n\n')
    );
  }
}

// Replay-per-turn engine: every question is a fresh, self-contained agent call
// with the transcript so far. Works with any agent command.
async function runTurnBasedSession({ config, brief, command, cwd, id, dir, emit, deps, artifactsBefore }) {
  const spawnImpl = deps.spawnImpl ?? runProcess;
  const timeoutSeconds = Number(deps.turnTimeoutSeconds) > 0
    ? Number(deps.turnTimeoutSeconds)
    : DEFAULT_TURN_TIMEOUT_SECONDS;
  const turns = [];
  const promptFile = path.join(dir, 'prompt.md');

  let count = 0;

  while (true) {
    count += 1;

    const prompt = buildTurnPrompt(config.id, { brief, turns });

    fs.writeFileSync(promptFile, prompt, 'utf8');
    emit({ type: 'turn-started', turn: count });

    const agentPrompt = count === 1
      ? `Read the interview brief at \`${promptFile}\` and follow it. Its file rules are exact; do not commit or push.`
      : `Read the interview brief at \`${promptFile}\` and follow it. Continue the interview; its file rules still apply.`;
    const invocation = buildAgentInvocation(command, { prompt: agentPrompt, promptFile });
    const spec = buildSpawnSpec(invocation);

    let result;

    try {
      result = await spawnImpl(spec.command, spec.args, {
        cwd,
        signal: deps.signal,
        timeoutMs: timeoutSeconds * 1000,
        onStdout: (chunk) => emit({ type: 'output', stream: 'stdout', chunk }),
        onStderr: (chunk) => emit({ type: 'output', stream: 'stderr', chunk }),
        env: {
          ...process.env,
          SDD_SESSION_ID: id,
          SDD_SESSION_FLOW: config.id
        }
      });
    } catch (error) {
      if (deps.signal?.aborted) {
        throw cancelledError();
      }

      throw new Error(`The agent could not be started: ${error.message}`);
    }

    if (result.aborted || deps.signal?.aborted) {
      throw cancelledError();
    }

    if (result.timedOut) {
      throw new Error(`The agent did not finish a reply within ${timeoutSeconds} seconds.`);
    }

    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();

      throw new Error(`The agent exited with code ${result.code}.${detail ? ` ${detail}` : ''}`);
    }

    const text = `${result.stdout ?? ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim();

    if (!text) {
      throw new Error('The agent finished without a reply.');
    }

    turns.push({ role: 'assistant', text });

    const transcript = () => turns
      .map((turn) => `## ${turn.role === 'assistant' ? 'Agent' : 'Human'}\n\n${turn.text}`)
      .join('\n\n');
    const artifact = findSessionArtifact(cwd, config, artifactsBefore);

    if (artifact) {
      writeFile(dir, 'session.md', transcript());

      return { output: readArtifact(artifact, text), turns, engine: 'turn', artifact };
    }

    const reply = await deps.waitForAnswer({ text, flow: config.id });

    if (reply?.cancelled || deps.signal?.aborted) {
      throw cancelledError();
    }

    if (reply?.done) {
      writeFile(dir, 'session.md', transcript());

      return { output: text, turns, engine: 'turn' };
    }

    turns.push({ role: 'user', text: reply?.answer ?? '' });
  }
}

// Run a full interview session to the final artifact. The caller supplies
// `waitForAnswer`, which resolves with `{ answer }`, `{ done: true }` when the
// human ends the interview, or `{ cancelled: true }`.
export async function runInterviewSession(request = {}, dependencies = {}) {
  const config = resolveSessionFlow(request.flow);
  const brief = validateBrief(request.brief);
  const cwd = dependencies.cwd ?? process.cwd();
  const id = dependencies.id ?? `session-${Date.now()}`;
  const emit = dependencies.emit ?? (() => {});
  const command = normalizeAgentCommand(request.agentCmd ?? DEFAULT_AGENT_COMMAND);
  const engine = detectAgentEngine(command, request.agentPreset);
  const dir = sessionDir(cwd, id, config);
  // A spec that exists before the first turn belongs to an earlier session.
  const artifactsBefore = snapshotArtifacts(cwd, config);

  emit({ type: 'session-started', flow: config.id, engine, brief });

  if (engine === 'live') {
    writeFile(dir, 'opening.md', buildSessionOpening(config.id, brief));
  }

  const result = engine === 'live'
    ? await runLiveSession({ config, brief, command, cwd, id, dir, emit, deps: dependencies, artifactsBefore })
    : await runTurnBasedSession({ config, brief, command, cwd, id, dir, emit, deps: dependencies, artifactsBefore });

  return { ...result, brief, flow: config.id, dir, promptFile: path.join(dir, 'prompt.md') };
}

export { DEFAULT_TURN_TIMEOUT_SECONDS };
