import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
import {
  NATIVE_SKILL_AGENTS,
  assertNativeSkillAvailable,
  buildNativeSkillCall
} from './native-skills.js';

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
    // The plan is an approved checkpoint; the report is the final reply.
    planLabel: 'plan',
    finalLabel: 'report',
    // The enhancement skill changes the repository after the plan is approved
    // and has no artifact, so the human closes the session after the report.
    artifact: null,
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
  },
  merge: {
    id: 'merge',
    label: 'Merge',
    skillName: 'merge',
    skillPath: path.resolve(here, '..', 'vibecoding', 'skills', 'merge', 'SKILL.md'),
    workDir: 'merges',
    finalLabel: 'merge report',
    // A merge ends structurally when the integration branch exists. No file is
    // the signal, and the human never "finishes" the interview by hand.
    mode: 'merge',
    artifact: null
  }
};

export function resolveSessionFlow(flow) {
  const config = SESSION_FLOWS[String(flow ?? '').trim()];

  if (!config) {
    const error = new Error(`Unknown session flow "${flow}". Use "enhancement", "feature", or "merge".`);
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

function isNativeSkillAgent(agentPreset) {
  return NATIVE_SKILL_AGENTS.has(String(agentPreset ?? '').trim().toLowerCase());
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
// can render: one question per turn, then the artifact, then (for enhancement)
// an approval-gated implementation loop. The skill file is never modified; this
// wrapper only changes how the turns are paced.
export function buildSessionInstructions(flow, { agentPreset, skillArguments = {} } = {}) {
  const config = resolveSessionFlow(flow);
  const nativeSkillAgent = isNativeSkillAgent(agentPreset);
  if (!nativeSkillAgent) {
    const error = new Error('A native skill-capable agent must be selected; embedded skill text is disabled in Studio sessions.');
    error.statusCode = 400;
    throw error;
  }
  const artifactRoot = config.artifact
    ? config.artifact.root.split(path.sep).join('/')
    : '';
  const lines = [
    `# ${config.label} session`,
    '',
    `You are running the \`${config.skillName}\` workflow as a guided interview with one`,
    'human. You and the human take turns in a chat.',
    ''
  ];

  if (nativeSkillAgent) {
    lines.unshift(buildNativeSkillCall(config.skillName, agentPreset, skillArguments), '');
  }

  if (config.mode === 'merge') {
    lines.push(
      '## How this session works',
      '',
      '- This session integrates one branch into another. It is not a plan-only',
      '  interview, and it is not a feature design session.',
      '- Start with the preflight checks: the working tree is clean, both branches',
      '  exist, and the integration branch does not. Then dry-run the merge without',
      '  changing the working tree.',
      '- Ask exactly one question at a time, and only when a decision is needed: a',
      '  risky conflict, or a conflict the skill says a human must decide.',
      "- The human's next message is their answer to your last question.",
      '- When a resolution table needs approval, present it and stop. After the',
      '  human approves it, build the merge.',
      '- If the merge is clean and no decision is needed, continue without asking.',
      '',
      '## Rules for this session',
      '',
      '- All work happens on the integration branch named in the request. Never',
      '  check out, modify, or delete the target branch.',
      '- Never push, force-push, or touch a remote. Never rewrite the target branch.',
      '- Resolve conflicts by editing the conflicted files. Do not invent unrelated',
      '  changes or drop either side silently.',
      '- Commit the merge on the integration branch. The session ends when that',
      '  branch exists; stop there and report.',
      '- Do not touch Jira or any external tracker.',
      '- The studio guards these rules. A denied command is final: report it and',
      '  continue a different way.',
      ''
    );
  } else if (config.planLabel) {
    lines.push(
      '## How this session works',
      '',
      'This session has two phases.',
      '',
      '### Phase 1: interview and plan',
      '',
      '- Ask exactly one question at a time and keep the reply focused on it.',
      "- The human's next message is their answer to your last question.",
      '- Avoid asking what you can infer by reading the repository.',
      '- When you have enough to decide, do NOT ask another question. Present the',
      `  ${config.planLabel} in that reply instead.`,
      `- The ${config.planLabel} is a checkpoint, not the end of the session. Stop after`,
      '  presenting it and wait for the human.',
      '- Do not change anything before the human explicitly approves the plan. If the',
      '  human asks for changes, revise the plan and wait for approval again.',
      '',
      '### Phase 2: implement and verify',
      '',
      "- This phase starts only when the human's latest message explicitly approves",
      '  the plan. An approval is not a new interview answer.',
      '- Inspect the existing code, conventions, and current behavior first.',
      '- Apply the smallest change that satisfies the approved plan, then verify the',
      '  relevant behavior and check for regressions.',
      '- Follow the skill\'s implementation-and-verification workflow.',
      '- A reply in this phase is either a question about a decision you cannot',
      `  infer, or the final ${config.finalLabel}.`,
      '- Do not expand the approved scope. If the plan must change materially, stop,',
      '  present the updated plan, and wait for approval again.',
      '',
      '## Rules for this session',
      '',
      '- You may read the repository at any time to ground your questions, the plan,',
      '  and the implementation.',
      '- Do not modify, create, or delete any file before the human approves the plan.',
      '  After approval, change only what the approved plan requires.',
      '- You may run the tests, builds, and other checks the verification needs. Do',
      '  not install or upgrade dependencies or change the environment.',
      '- Do not commit. Do not push. Do not open a pull request.',
      '- Do not touch Jira or any external tracker.',
      '- Ask only about decisions you cannot infer; state your assumptions for the rest.',
      ''
    );
  } else {
    lines.push(
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
      `- You may read the repository to ground your questions and the ${config.finalLabel}.`,
      '- You may create exactly one file: the final spec at',
      `  \`${artifactRoot}/<feature-name>/${config.artifact.name}\`. Do not create or`,
      '  modify anything else. Do not commit. Do not push.',
      '- Do not run commands that change the repository or its dependencies.',
      '- Do not touch Jira or any external tracker.',
      `- Stop at the ${config.finalLabel}. Do not implement anything yet.`,
      '- Ask only about decisions you cannot infer; state your assumptions for the rest.',
      ''
    );
  }

  if (config.mode === 'merge') {
    lines.push(
      `## What the final ${config.finalLabel} must contain`,
      '',
      '1. The source branch and the target branch.',
      '2. The integration branch name.',
      '3. The files that conflicted, and how each side was resolved.',
      '4. The checks that were run, and their result.',
      '5. Anything a human must still confirm before landing the branch.',
      '',
      'State only what was actually verified. Never claim a conflict is resolved',
      'without evidence.'
    );
  } else if (config.planLabel) {
    lines.push(
      '## What the plan must contain',
      '',
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
      'Keep it specific to this repository. Prefer existing patterns over new ones.',
      '',
      `## What the final ${config.finalLabel} must contain`,
      '',
      'The report the skill asks for after the work is done. Include:',
      '',
      '1. The changes made, in plain language.',
      '2. The files affected.',
      '3. The attempts used, against the limit.',
      '4. The verification that was run and its result.',
      '5. Unresolved issues or limitations.',
      '',
      'State only what was actually verified. Never claim success without evidence.'
    );
  } else {
    lines.push(
      `## What the final ${config.finalLabel} must contain`,
      '',
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

  lines.push('');

  return lines.join('\n');
}

// The first message of a live session: the whole contract plus the request.
export function buildSessionOpening(flow, brief, options = {}) {
  const config = resolveSessionFlow(flow);
  const closing = config.mode === 'merge'
    ? 'Start the preflight checks and the dry run now. Ask a question only when a decision is needed.'
    : 'Start the interview now. Ask your first single question.';

  return [
    buildSessionInstructions(flow, options),
    '## The request',
    '',
    validateBrief(brief),
    '',
    closing
  ].join('\n');
}

// A self-contained prompt for agents that cannot hold a live conversation: the
// accumulated transcript is replayed and the agent asks the next question.
export function buildTurnPrompt(flow, { brief, turns = [], ...options } = {}) {
  const config = resolveSessionFlow(flow);
  const lines = [
    buildSessionInstructions(flow, options),
    '## Conversation so far',
    '',
    `**Human:** ${validateBrief(brief)}`
  ];

  for (const turn of turns) {
    lines.push('', turn.role === 'assistant' ? '**You:**' : '**Human:**', '', String(turn.text ?? ''));
  }

  lines.push('', '## Now', '');

  if (turns.length === 0) {
    lines.push(
      config.mode === 'merge'
        ? 'Start the preflight checks and the dry run now. Ask a question only when a decision is needed.'
        : 'Ask your first single question.'
    );
  } else if (config.mode === 'merge') {
    lines.push(
      'Continue the merge session:',
      '',
      '- If the human approved the resolution table, build the merge on the',
      '  integration branch now.',
      '- Otherwise ask the next single question, or present the decision table.',
      '- The session ends when the integration branch exists. If it already exists,',
      '  stop and report instead of touching the target.'
    );
  } else if (config.planLabel) {
    lines.push(
      `Continue the session. The human's latest message decides the phase:`,
      '',
      `- If it approves the plan, implement and verify it now, then produce the final ${config.finalLabel}.`,
      '- If it asks for a change to the plan, present the revised plan and wait for',
      '  approval.',
      '- Otherwise, ask the next single question, or present the plan when you have',
      '  enough to decide.'
    );
  } else {
    lines.push(
      `Continue: ask the next single question, or, if you have enough, produce the final ${config.finalLabel}.`
    );
  }

  lines.push('', '');

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

// A merge ends when its integration branch exists. That is a structural signal,
// not a phrase in the agent's reply, so the studio never has to interpret prose.
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
// branch and never a remote. This is the studio-side half of that contract: the
// Claude Code hook asks, and this decides before a human is interrupted. Other
// agents keep their own permission model.
const MERGE_FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MERGE_GIT_SAFE = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'merge-base',
  'merge-tree',
  'ls-files',
  'ls-tree',
  'cat-file',
  'for-each-ref',
  'show-ref',
  'rev-list',
  'diff-tree',
  'name-rev',
  'describe',
  'add',
  'commit',
  'merge',
  'restore',
  'branch',
  'checkout',
  'switch',
  'stash'
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

  // The target branch is the one thing the agent must never move to. Creating a
  // new branch from the target is the normal way to start the integration, so
  // `checkout -b merge/... <target>` stays allowed; `checkout <target>` does not.
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
    // Keep diagnostics available if the turn fails, but never mix them into
    // the user-facing transcript (stderr can contain provider/tool details).
    stderr += chunk.toString();
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
      agentPreset: deps.agentPreset,
      skillArguments: deps.skillArguments
    }));

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

      if (deps.merge?.ref && refExists(cwd, deps.merge.ref)) {
        return { output: turnText, turns, engine: 'live', stderr, ref: deps.merge.ref };
      }

      const reply = await deps.waitForAnswer({ text: turnText, flow: config.id });

      if (reply?.cancelled || deps.signal?.aborted) {
        throw cancelledError();
      }

      if (reply?.done) {
        return { output: turnText, turns, engine: 'live', stderr };
      }

      turns.push({ role: 'user', text: reply?.answer ?? '' });
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

    writeFile(
      dir,
      'session.md',
      turns.map((turn) => `## ${turn.role === 'assistant' ? 'Agent' : 'Human'}\n\n${turn.text}`).join('\n\n')
    );
  }
}

// Replay-per-turn engine: every question is a fresh, self-contained agent call
// with the transcript so far. Works with any agent command.
export function stripAnsi(value) {
  return String(value ?? '')
    // OSC sequences (window titles, progress) end with BEL or ST.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // CSI sequences, including the colours and cursor moves progress UIs emit.
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

// Structured streams contain tool events and sometimes the contents of files
// the agent read. Only assistant text is eligible for the conversation view.
export function parseAgentReply(stdout) {
  const texts = [];
  let finalText = '';
  let textFormat = '';

  let structured = false;
  let error = '';

  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();

    if (!trimmed.startsWith('{')) {
      continue;
    }

    let event;

    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!event || typeof event !== 'object') {
      continue;
    }

    // Some agents report a fatal error as one object with no `type`, e.g.
    // { "error": { "type": "aborted", ... }, "content": [] }.
    if (typeof event.type !== 'string' && !event.error) {
      continue;
    }

    structured = true;

    if (event.error) {
      error = event.error?.data?.message
        || event.error?.message
        || event.error?.type
        || event.error?.name
        || 'The agent reported an error.';

      continue;
    }

    if (event.type === 'assistant' && event.message?.role === 'assistant') {
      // Cursor stream-json emits assistant deltas separately from tool calls.
      textFormat = 'delta';
      for (const block of event.message.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          texts.push(block.text);
        }
      }
      continue;
    }

    if (event.type === 'result' && typeof event.result === 'string') {
      // Cursor's result is the aggregated reply; prefer streamed assistant
      // deltas when present to avoid rendering it twice.
      finalText = event.result;
      continue;
    }

    if (event.type === 'text') {
      // OpenCode: { type: "text", part: { text } }.
      textFormat = 'messages';
      const text = event.part?.text ?? event.text;

      if (typeof text === 'string' && text.trim()) {
        texts.push(text);
      }
    } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      // Codex `exec --json`: completed command/tool items are intentionally
      // ignored; only the final assistant message is shown.
      textFormat = 'messages';
      const text = event.item.text;

      if (typeof text === 'string' && text.trim()) {
        texts.push(text);
      }
    } else if (event.type === 'error') {
      error = event.error?.data?.message
        || event.error?.message
        || event.error?.name
        || 'The agent reported an error.';
    }
  }

  return { text: (texts.length ? texts.join(textFormat === 'messages' ? '\n\n' : '') : finalText).trim(), error, structured };
}

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

    const prompt = buildTurnPrompt(config.id, {
      brief,
      turns,
      agentPreset: deps.agentPreset,
      skillArguments: deps.skillArguments
    });

    fs.writeFileSync(promptFile, prompt, 'utf8');
    emit({ type: 'turn-started', turn: count });

    const skillInvocation = `${buildNativeSkillCall(config.skillName, deps.agentPreset, deps.skillArguments)} `;
    const agentPrompt = count === 1
      ? `${skillInvocation}${config.mode === 'merge'
        ? `Read the interview brief at \`${promptFile}\` and follow it. Never push; commit only on the specified integration branch.`
        : `Read the interview brief at \`${promptFile}\` and follow it. Its file rules are exact; do not commit or push.`}`
      : `${skillInvocation}Read the interview brief at \`${promptFile}\` and follow it. Continue the interview; its file rules still apply.`;
    const invocation = buildAgentInvocation(command, { prompt: agentPrompt, promptFile });
    const spec = buildSpawnSpec(invocation);

    let result;
    const structuredAgent = ['codex', 'cursor', 'opencode'].includes(String(deps.agentPreset ?? '').toLowerCase());
    let structuredBuffer = '';
    let streamedAssistant = '';

    const emitStructuredLines = (chunk, flush = false) => {
      structuredBuffer += String(chunk ?? '');

      let boundary;
      while ((boundary = structuredBuffer.indexOf('\n')) !== -1 || (flush && structuredBuffer.length)) {
        const line = boundary === -1 ? structuredBuffer : structuredBuffer.slice(0, boundary);
        structuredBuffer = boundary === -1 ? '' : structuredBuffer.slice(boundary + 1);

        let event;
        try {
          event = JSON.parse(line.trim());
        } catch {
          continue;
        }

        // Cursor's terminal result repeats all assistant deltas. Prefer the
        // streamed text; use the terminal result only when no delta arrived.
        if (event.type === 'result' && streamedAssistant) continue;
        const reply = parseAgentReply(line);

        if (reply.text) {
          const separateMessages = ['codex', 'opencode'].includes(String(deps.agentPreset ?? '').toLowerCase());
          const separator = separateMessages && streamedAssistant ? '\n\n' : '';
          const visibleText = `${separator}${reply.text}`;

          streamedAssistant += visibleText;
          emit({ type: 'output', stream: 'stdout', chunk: visibleText });
        }
      }
    };

    try {
      result = await spawnImpl(spec.command, spec.args, {
        cwd,
        signal: deps.signal,
        timeoutMs: timeoutSeconds * 1000,
        onStdout: (chunk) => {
          // Codex and OpenCode emit protocol events that include tool output.
          // Their assistant text is emitted after parsing below.
          if (structuredAgent) emitStructuredLines(chunk);
          else emit({ type: 'output', stream: 'stdout', chunk });
        },
        onStderr: () => {},
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

    if (structuredAgent) emitStructuredLines('', true);

    // Parse structured output and expose only the assistant reply, never tool
    // events such as read_file results or command output.
    const parsed = parseAgentReply(result.stdout ?? '');

    if (parsed.error) {
      throw new Error(`The agent reported: ${parsed.error}`);
    }

    const text = (parsed.text || (structuredAgent ? '' : stripAnsi(result.stdout ?? ''))).trim();

    if (!text) {
      const detail = String(result.stderr ?? '').trim().split('\n').slice(-3).join(' ');
      throw new Error(`The agent finished without a reply.${detail ? ` ${detail}` : ''}`);
    }

    if (structuredAgent && !streamedAssistant) emit({ type: 'output', stream: 'stdout', chunk: text });

    turns.push({ role: 'assistant', text });

    const transcript = () => turns
      .map((turn) => `## ${turn.role === 'assistant' ? 'Agent' : 'Human'}\n\n${turn.text}`)
      .join('\n\n');
    const artifact = findSessionArtifact(cwd, config, artifactsBefore);

    if (artifact) {
      writeFile(dir, 'session.md', transcript());

      return { output: readArtifact(artifact, text), turns, engine: 'turn', artifact };
    }

    if (deps.merge?.ref && refExists(cwd, deps.merge.ref)) {
      writeFile(dir, 'session.md', transcript());

      return { output: text, turns, engine: 'turn', ref: deps.merge.ref };
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
  const skillArguments = {
    ...validateSessionSkillArguments(config.id, request.skillArguments),
    ...(config.mode === 'merge' && request.merge
      ? { source: request.merge.source, target: request.merge.target }
      : {})
  };
  const agentPreset = request.agentPreset;
  const cwd = dependencies.cwd ?? process.cwd();
  assertNativeSkillAvailable(cwd, agentPreset, config.skillName);
  const id = dependencies.id ?? `session-${Date.now()}`;
  const emit = dependencies.emit ?? (() => {});
  const command = normalizeAgentCommand(request.agentCmd ?? DEFAULT_AGENT_COMMAND);
  const engine = detectAgentEngine(command, request.agentPreset);
  const dir = sessionDir(cwd, id, config);
  const merge = request.merge ?? dependencies.merge ?? null;
  const sessionDeps = {
    ...dependencies,
    agentPreset,
    skillArguments,
    ...(merge ? { merge } : {})
  };
  // A spec that exists before the first turn belongs to an earlier session.
  const artifactsBefore = snapshotArtifacts(cwd, config);

  emit({ type: 'session-started', flow: config.id, engine, brief });

  if (engine === 'live') {
    writeFile(dir, 'opening.md', buildSessionOpening(config.id, brief, { agentPreset, skillArguments }));
  }

  const result = engine === 'live'
    ? await runLiveSession({ config, brief, command, cwd, id, dir, emit, deps: sessionDeps, artifactsBefore })
    : await runTurnBasedSession({ config, brief, command, cwd, id, dir, emit, deps: sessionDeps, artifactsBefore });

  return {
    ...result,
    brief,
    flow: config.id,
    dir,
    promptFile: path.join(dir, 'prompt.md'),
    skillArguments,
    ...(merge ? { merge } : {})
  };
}

export { DEFAULT_TURN_TIMEOUT_SECONDS };
