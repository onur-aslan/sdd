import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_AGENT_COMMAND,
  DEFAULT_FETCH_LIMIT,
  DEFAULT_LIMIT,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_WORK_DIR,
  buildJiraAuthHeader,
  buildJql,
  createJiraFetch,
  fetchJiraBugs,
  fetchJiraProjects,
  normalizeAgentCommand,
  probeJira,
  runBugSweep,
  runProcess
} from './bug-sweep.js';
import { runInterviewSession, resolveSessionFlow, validateBrief } from './agent-session.js';

export const STUDIO_DEFAULT_PORT = 4321;
export const STUDIO_DEFAULT_HOST = '127.0.0.1';

// The dashboard offers a one-click agent choice. The command is still passed
// through --agent-cmd, so the sweep itself stays agent-agnostic.
export const STUDIO_AGENT_PRESETS = [
  { id: 'claude', label: 'Claude Code', command: DEFAULT_AGENT_COMMAND },
  { id: 'cursor', label: 'Cursor', command: '["cursor-agent","-p","--force"]' },
  { id: 'opencode', label: 'OpenCode', command: '["opencode","run","--format","json","--agent","build"]' },
  { id: 'codex', label: 'Codex', command: '["codex","exec"]' },
  { id: 'custom', label: 'Custom command', command: '' }
];

// One-click forge choices. GitHub uses the built-in gh path (an empty command).
// The other presets are JSON argv, so `--pr-cmd` runs them without a shell and
// the same value works on Windows and POSIX.
export const STUDIO_PR_PRESETS = [
  { id: 'github', label: 'GitHub (gh)', command: '' },
  {
    id: 'gitlab',
    label: 'GitLab (glab)',
    command: JSON.stringify([
      'glab', 'mr', 'create',
      '--title', '{title}',
      '--description-file', '{bodyFile}',
      '--source-branch', '{head}',
      '--target-branch', '{base}',
      '--yes'
    ])
  },
  { id: 'gitlab-push', label: 'GitLab (git push, no CLI)', command: '' },
  {
    id: 'gitea',
    label: 'Gitea (tea)',
    command: JSON.stringify([
      'tea', 'pulls', 'create',
      '--title', '{title}',
      '--description', '{body}',
      '--head', '{head}',
      '--base', '{base}'
    ])
  },
  { id: 'custom', label: 'Custom command', command: '' }
];

const assetsDir = fileURLToPath(new URL('../studio/', import.meta.url));

// Both session workflows expose the same shape of API under their own prefix.
const SESSION_ROUTE_PREFIXES = [
  { prefix: '/api/enhancements', flow: 'enhancement' },
  { prefix: '/api/features', flow: 'feature' }
];

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

function splitFlag(token) {
  const index = token.indexOf('=');

  return index === -1 ? [token, null] : [token.slice(0, index), token.slice(index + 1)];
}

function positiveInteger(value, flag) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${flag} expects a positive integer.`);
  }

  return number;
}

export function formatStudioHelp() {
  return `SDD Studio - local web dashboard for spec-driven work

Usage:
  sdd studio [options]

Options:
  --port <n>     Port to listen on (default: ${STUDIO_DEFAULT_PORT})
  --host <addr>  Interface to bind (default: ${STUDIO_DEFAULT_HOST}, local only)
  --open         Open the dashboard in your browser

The dashboard drives "sdd bug-sweep" from the browser: pick a Jira project,
watch each bug get fixed one at a time, and open the pull request. Later
enhancement and feature runs reuse the same job view, including the interview
steps that need your input.

Examples:
  sdd studio
  sdd studio --port 8080 --open
`;
}

export function parseStudioArgs(argv = []) {
  let port = STUDIO_DEFAULT_PORT;
  let host = STUDIO_DEFAULT_HOST;
  let open = false;

  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = splitFlag(argv[index]);

    if (name === '--help' || name === '-h') {
      return { help: true };
    }

    if (name === '--port') {
      port = positiveInteger(inline ?? argv[(index += 1)], '--port');
      continue;
    }

    if (name === '--host') {
      const value = inline ?? argv[(index += 1)];

      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --host.');
      }

      host = value;
      continue;
    }

    if (name === '--open') {
      open = true;
      continue;
    }

    throw new Error(`Unknown option ${name}. Use --help for usage.`);
  }

  return { help: false, port, host, open };
}

// Turn a dashboard request into the exact argv "sdd bug-sweep" understands.
export function buildSweepArgs(request = {}) {
  const args = [];
  const value = (flag, input) => {
    if (input !== undefined && input !== null && input !== '') {
      args.push(flag, String(input));
    }
  };

  value('--project', request.project);
  value('--jql', request.jql);
  value(
    '--issues',
    Array.isArray(request.issues) && request.issues.length > 0 ? request.issues.join(',') : ''
  );

  value('--date', request.date);
  value('--base', request.base);
  value('--branch', request.branch);
  value('--tag', request.tag);
  value('--agent-cmd', request.agentCmd);
  value('--verify-cmd', request.verifyCmd);
  value('--max-turns', request.maxTurns);
  value('--limit', request.limit);
  value('--timeout', request.timeout);
  value('--work-dir', request.workDir);
  value('--remote', request.remote);
  value('--jira-url', request.jiraUrl);
  value('--jira-email', request.jiraEmail);
  value('--jira-token', request.jiraToken);
  value('--jira-auth', request.jiraAuth);
  value('--jira-api-version', request.jiraApiVersion);
  value('--jira-ca', request.jiraCa);
  value('--pr-cmd', request.prCommand);

  if (request.gitlabPush) {
    args.push('--gitlab-push');
  }

  if (Array.isArray(request.extraFields) && request.extraFields.length > 0) {
    value('--extra-fields', request.extraFields.join(','));
  }

  if (request.dryRun) {
    args.push('--dry-run');
  }
  if (request.resume) {
    args.push('--resume');
  }
  if (request.retryFailed) {
    args.push('--retry-failed');
  }
  if (request.worktree) {
    args.push('--worktree');
  }
  if (request.fetchBase) {
    args.push('--fetch-base');
  }
  if (request.verbose) {
    args.push('--verbose');
  }
  if (request.push === false) {
    args.push('--no-push');
  }
  if (request.pr === false) {
    args.push('--no-pr');
  }
  if (request.jiraInsecure) {
    args.push('--jira-insecure');
  }

  return args;
}

function isAlive(job) {
  return (
    job.status === 'queued'
    || job.status === 'running'
    || job.status === 'waiting'
    || job.status === 'cancelling'
  );
}

export function createJobManager({ cwd, fetchImpl, spawnImpl, spawnProcess, terminate, now } = {}) {
  const jobs = new Map();
  const pendingInputs = new Map();
  const pendingPermissions = new Map();
  let activeJobId = null;

  function snapshot(job) {
    const request = { ...job.request };

    // Never echo the saved token back through the API.
    for (const key of SECRET_SETTINGS_KEYS) {
      if (request[key]) {
        request[key] = '***';
      }
    }

    return {
      id: job.id,
      type: job.type,
      flow: job.flow ?? job.type,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      request,
      result: job.result,
      error: job.error,
      events: job.events
    };
  }

  function emit(job, event) {
    // The sequence lets a reconnecting client ignore the replay it already has.
    job.sequence = (job.sequence ?? 0) + 1;
    const enriched = { ...event, at: new Date().toISOString(), seq: job.sequence };

    job.events.push(enriched);
    job.updatedAt = enriched.at;

    for (const listener of job.listeners) {
      try {
        listener(enriched);
      } catch {
        // A disconnected client must not break the run.
      }
    }
  }

  function assertIdle() {
    const active = activeJobId ? jobs.get(activeJobId) : null;

    if (active && isAlive(active)) {
      const label = active.type === 'bug-sweep' ? 'sweep' : 'session';
      const error = new Error(`A ${label} is already running (${active.id}). Wait for it or cancel it first.`);
      error.statusCode = 409;
      throw error;
    }
  }

  function startSweep(request = {}) {
    assertIdle();

    // A minimal request inherits the choices the user already made once.
    const effective = applySettings(request, readStore(cwd));

    try {
      writeSettings(cwd, effective);
    } catch {
      // Remembering settings is a convenience; never block a sweep on it.
    }

    const id = randomUUID();
    const job = {
      id,
      type: 'bug-sweep',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      request: effective,
      events: [],
      listeners: new Set(),
      result: null,
      error: null,
      cancelled: false,
      controller: new AbortController()
    };

    jobs.set(id, job);
    activeJobId = id;

    emit(job, { type: 'job-started', jobId: id, kind: 'bug-sweep' });

    runBugSweep(buildSweepArgs(effective), {
      cwd,
      fetchImpl,
      spawnImpl,
      now,
      signal: job.controller.signal,
      logger: (line) => emit(job, { type: 'log', line }),
      onEvent: (event) => emit(job, event)
    })
      .then((summary) => {
        job.result = summary;

        if (job.cancelled) {
          job.status = 'cancelled';
          emit(job, { type: 'job-cancelled', summary });
        } else {
          job.status = 'done';
          emit(job, { type: 'job-done', summary });
        }
      })
      .catch((error) => {
        job.status = 'failed';
        job.error = error.message;
        emit(job, { type: 'job-failed', message: error.message });
      })
      .finally(() => {
        if (activeJobId === id) {
          activeJobId = null;
        }
      });

    return job;
  }

  // An interview session with the agent: one question at a time, then a plan
  // (enhancement) or a spec (feature). The skill files stay untouched on disk.
  function startSession(flow, request = {}) {
    const config = resolveSessionFlow(flow);

    assertIdle();

    const brief = validateBrief(request.brief);
    const saved = readStore(cwd);
    const agentPreset = request.agentPreset ?? saved.agentPreset;
    const agentCmd = request.agentCmd ?? saved.agentCmd;

    // Validate before the job exists, so a bad agent command is a 400 instead of
    // a session that fails with no useful output.
    try {
      normalizeAgentCommand(agentCmd ?? DEFAULT_AGENT_COMMAND);
    } catch (error) {
      error.statusCode = 400;
      throw error;
    }

    try {
      // Remember the agent for next time without dropping the rest of the store
      // (project, base branch, toggles, and the saved Jira credential).
      writeSettings(cwd, { ...saved, agentPreset, agentCmd });
    } catch {
      // Remembering the agent is a convenience; never block a session on it.
    }

    const id = randomUUID();
    const job = {
      id,
      type: config.id,
      flow: config.id,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      request: { brief, agentPreset, agentCmd },
      events: [],
      listeners: new Set(),
      result: null,
      error: null,
      cancelled: false,
      controller: new AbortController()
    };

    jobs.set(id, job);
    activeJobId = id;

    emit(job, { type: 'job-started', jobId: id, kind: config.id });

    runInterviewSession(
      { flow: config.id, brief, agentPreset, agentCmd },
      {
        cwd,
        id,
        spawnImpl,
        spawnProcess,
        terminate,
        signal: job.controller.signal,
        emit: (event) => emit(job, event),
        waitForAnswer: (question) => askInput(job, question),
        waitForPermission: (request) => askPermission(job, request),
        logger: (line) => emit(job, { type: 'log', line })
      }
    )
      .then((summary) => {
        job.result = summary;

        if (job.cancelled) {
          job.status = 'cancelled';
          emit(job, { type: 'job-cancelled', summary });
        } else {
          job.status = 'done';
          emit(job, {
            type: 'job-done',
            summary: { output: summary.output, engine: summary.engine, flow: summary.flow }
          });
        }
      })
      .catch((error) => {
        job.error = error.message;

        if (job.cancelled) {
          job.status = 'cancelled';
          emit(job, { type: 'job-cancelled', summary: job.result });
        } else {
          job.status = 'failed';
          emit(job, { type: 'job-failed', message: error.message });
        }
      })
      .finally(() => {
        if (activeJobId === id) {
          activeJobId = null;
        }
      });

    return job;
  }

  function startEnhancement(request = {}) {
    return startSession('enhancement', request);
  }

  function startFeature(request = {}) {
    return startSession('feature', request);
  }

  function cancelJob(id) {
    const job = jobs.get(id);

    if (!job || !isAlive(job)) {
      return false;
    }

    job.status = 'cancelling';
    job.cancelled = true;

    // A session that is waiting for an answer must wake up before it can stop.
    const pending = pendingInputs.get(id);

    if (pending) {
      pendingInputs.delete(id);
      pending.resolve({ cancelled: true });
    }

    const permission = pendingPermissions.get(id);

    if (permission) {
      pendingPermissions.delete(id);
      permission.resolve({ behavior: 'deny' });
    }

    job.controller.abort();

    return true;
  }

  // Sessions ask through the same event stream and wait for the answer at
  // POST /api/jobs/:id/input.
  function askInput(job, question) {
    job.status = 'waiting';
    emit(job, { type: 'question', text: question?.text ?? '', flow: job.flow ?? job.type });

    return new Promise((resolve) => {
      pendingInputs.set(job.id, { job, resolve });
    });
  }

  function submitInput(jobId, payload) {
    const pending = pendingInputs.get(jobId);

    if (!pending) {
      return false;
    }

    pendingInputs.delete(jobId);

    const answer = String(payload?.answer ?? '').trim();
    const done = payload?.done === true;

    pending.job.status = 'running';

    if (done) {
      // Ending the interview is a human decision, not an answer.
      pending.resolve({ done: true, cancelled: false });

      return true;
    }

    emit(pending.job, { type: 'answer', text: answer });
    pending.resolve({ answer, cancelled: false });

    return true;
  }

  // Claude Code asks before a tool the session did not pre-approve. The hook
  // blocks that call until the browser answers.
  function askPermission(job, request) {
    emit(job, {
      type: 'permission',
      id: request?.id ?? '',
      tool: request?.tool ?? 'tool',
      detail: request?.detail ?? '',
      description: request?.description ?? '',
      flow: job.flow ?? job.type
    });

    return new Promise((resolve) => {
      pendingPermissions.set(job.id, { job, resolve });
    });
  }

  function submitPermission(jobId, payload) {
    const pending = pendingPermissions.get(jobId);

    if (!pending) {
      return false;
    }

    pendingPermissions.delete(jobId);

    const behavior = String(payload?.behavior ?? '').trim() === 'allow' ? 'allow' : 'deny';

    // The engine records the decision on the event stream once the hook has it,
    // so a timeout and a human answer look the same on replay.
    pending.resolve({ behavior });

    return true;
  }

  return {
    jobs,
    startSweep,
    startSession,
    startEnhancement,
    startFeature,
    cancelJob,
    askInput,
    submitInput,
    askPermission,
    submitPermission,
    snapshot,
    emit
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendAsset(res, file, { cache = 'no-store' } = {}) {
  const fullPath = path.join(assetsDir, file);

  if (!fullPath.startsWith(assetsDir) || !fs.existsSync(fullPath)) {
    sendJson(res, 404, { error: `Missing asset ${file}.` });
    return;
  }

  const body = fs.readFileSync(fullPath);

  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(fullPath)] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // The studio is served from local disk while the UI is being worked on;
    // stale JS is more confusing than the tiny cost of re-reading three files.
    'Cache-Control': cache
  });
  res.end(body);
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > limit) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });

    req.on('error', reject);
  });
}

function streamEvents(req, res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  for (const event of job.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const listener = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  job.listeners.add(listener);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    job.listeners.delete(listener);
  });
}

async function describeGit(cwd) {
  try {
    const inside = await runProcess('git', ['rev-parse', '--is-inside-work-tree'], { cwd });

    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      return { repo: false };
    }

    const root = (await runProcess('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim();
    const branch = (await runProcess('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim();
    let base = 'main';
    const remoteHead = await runProcess('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd });

    if (remoteHead.code === 0 && remoteHead.stdout.trim()) {
      base = remoteHead.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
    } else {
      for (const candidate of ['main', 'master']) {
        const exists = await runProcess('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], { cwd });

        if (exists.code === 0) {
          base = candidate;
          break;
        }
      }
    }

    const dirty = (await runProcess('git', ['status', '--porcelain'], { cwd })).stdout.trim() !== '';

    return { repo: true, root, branch, base, dirty };
  } catch {
    return { repo: false };
  }
}

export function todayLocal(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function detectPackageManager(cwd) {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) {
    return 'yarn';
  }
  if (fs.existsSync(path.join(cwd, 'bun.lockb'))) {
    return 'bun';
  }

  return 'npm';
}

// Guess a verification command from the project's own scripts so the user does not have to.
export function detectVerifyCommand(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const scripts = pkg.scripts ?? {};
    const manager = detectPackageManager(cwd);

    for (const name of ['test', 'lint', 'typecheck', 'build']) {
      if (typeof scripts[name] === 'string' && scripts[name].trim() !== '') {
        return name === 'test' ? `${manager} test` : `${manager} run ${name}`;
      }
    }
  } catch {
    // No package.json: no guess to make.
  }

  return '';
}

function ensureWorkDir(workDir) {
  fs.mkdirSync(workDir, { recursive: true });

  const ignorePath = path.join(workDir, '.gitignore');

  if (!fs.existsSync(ignorePath)) {
    fs.writeFileSync(ignorePath, '*\n', 'utf8');
  }
}

const SETTINGS_FILE = 'studio.settings.json';
// Only choices a human actually has to make. Dates, branch, tag, base branch, work
// directory, limits, and timeouts are derived by the command at run time.
const SETTINGS_KEYS = [
  'project',
  'base',
  'agentPreset',
  'agentCmd',
  'push',
  'pr',
  'retryFailed',
  'worktree',
  'fetchBase',
  'jiraUrl',
  'jiraEmail',
  'jiraAuth',
  'jiraApiVersion',
  'jiraCa',
  'jiraInsecure',
  'prPreset',
  'prCommand',
  // Set once the Settings drawer has been seen, so it opens on the first visit
  // and not on every reload while the project is still empty.
  'settingsSeen'
];

// The dashboard runs on localhost, so it remembers the Jira token in the same
// git-ignored file. The token is never sent back to the browser; the API only
// exposes hasSavedToken. A blank token field means "keep using the saved one".
const SECRET_SETTINGS_KEYS = ['jiraToken'];
const STORE_KEYS = [...SETTINGS_KEYS, ...SECRET_SETTINGS_KEYS];

function settingsFile(cwd) {
  return path.join(path.resolve(cwd, DEFAULT_WORK_DIR), SETTINGS_FILE);
}

function cleanKeys(raw, keys) {
  const clean = {};

  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') {
      clean[key] = raw[key];
    }
  }

  return clean;
}

// Everything on disk, including the token. Server-side only.
export function readStore(cwd) {
  try {
    return cleanKeys(JSON.parse(fs.readFileSync(settingsFile(cwd), 'utf8')), STORE_KEYS);
  } catch {
    return {};
  }
}

// The public view: safe to return to the dashboard.
export function readSettings(cwd) {
  return cleanKeys(readStore(cwd), SETTINGS_KEYS);
}

export function hasSavedToken(cwd) {
  return Boolean(readStore(cwd).jiraToken);
}

export function writeSettings(cwd, settings = {}) {
  const clean = cleanKeys(settings, STORE_KEYS);

  ensureWorkDir(path.resolve(cwd, DEFAULT_WORK_DIR));

  const file = settingsFile(cwd);

  fs.writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  try {
    // Windows ignores POSIX modes; the file also lives inside a git-ignored dir.
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }

  return clean;
}

// A short dashboard request inherits the remembered choices. A blank secret field
// means "use the saved token", so the browser never has to hold it.
export function applySettings(request = {}, settings = {}) {
  const merged = { ...request };

  for (const key of SETTINGS_KEYS) {
    if (merged[key] === undefined && settings[key] !== undefined) {
      merged[key] = settings[key];
    }
  }
  for (const key of SECRET_SETTINGS_KEYS) {
    if (!merged[key] && settings[key]) {
      merged[key] = settings[key];
    }
  }

  return merged;
}

// Read Jira connection details from the request, then the local store, then the
// environment. Entering everything in the UI is enough; env vars remain optional.
export function resolveStudioJira(input = {}, saved = {}) {
  const env = process.env;
  const pick = (inputValue, savedValue, envValue, fallback = '') => {
    if (inputValue !== undefined && inputValue !== null && inputValue !== '') {
      return inputValue;
    }
    if (savedValue !== undefined && savedValue !== null && savedValue !== '') {
      return savedValue;
    }
    return envValue ?? fallback;
  };

  const auth = pick(input.jiraAuth, saved.jiraAuth, env.JIRA_AUTH, 'auto');

  return {
    url: pick(input.jiraUrl, saved.jiraUrl, env.JIRA_BASE_URL, ''),
    // An email only matters for Basic auth; auto and bearer use the token alone.
    email: auth === 'basic' ? pick(input.jiraEmail, saved.jiraEmail, env.JIRA_EMAIL, '') : '',
    token: pick(input.jiraToken, saved.jiraToken, env.JIRA_API_TOKEN, ''),
    auth,
    apiVersion: pick(input.jiraApiVersion, saved.jiraApiVersion, env.JIRA_API_VERSION, 'auto'),
    ca: pick(input.jiraCa, saved.jiraCa, env.JIRA_CA_CERT, null),
    insecure: Boolean(input.jiraInsecure) || Boolean(saved.jiraInsecure) || env.JIRA_INSECURE === '1'
  };
}

export async function listJiraProjects(input = {}, saved = {}) {
  const jira = resolveStudioJira(input, saved);

  if (!jira.url || !jira.token) {
    return { configured: false, projects: [], error: 'Jira credentials are not configured.' };
  }

  try {
    const transport = input.fetchImpl ?? createJiraFetch({ caPath: jira.ca, insecure: jira.insecure });
    const headers = {
      Authorization: buildJiraAuthHeader({ auth: jira.auth, email: jira.email, token: jira.token }),
      Accept: 'application/json'
    };
    const projects = await fetchJiraProjects({
      baseUrl: jira.url,
      headers,
      apiVersion: jira.apiVersion,
      fetchImpl: transport
    });

    return { configured: true, projects };
  } catch (error) {
    return { configured: true, projects: [], error: error.message };
  }
}

export async function listJiraBugs(input = {}, saved = {}) {
  const jira = resolveStudioJira(input, saved);

  if (!jira.url || !jira.token) {
    return { configured: false, bugs: [], error: 'Jira credentials are not configured.' };
  }

  const project = String(input.project ?? saved.project ?? '').trim();

  if (!project) {
    return { configured: true, bugs: [], jql: '', error: 'Pick a Jira project first.' };
  }

  try {
    const transport = input.fetchImpl ?? createJiraFetch({ caPath: jira.ca, insecure: jira.insecure });
    const jql = buildJql({ project });
    const bugs = await fetchJiraBugs({
      baseUrl: jira.url,
      auth: jira.auth,
      email: jira.email,
      token: jira.token,
      apiVersion: jira.apiVersion,
      jql,
      limit: input.limit ?? DEFAULT_FETCH_LIMIT,
      fetchImpl: transport
    });

    return {
      configured: true,
      jql,
      total: bugs.length,
      bugs: bugs.map((bug) => ({
        key: bug.key,
        summary: bug.summary,
        priority: bug.priority,
        status: bug.jiraStatus,
        url: bug.url
      }))
    };
  } catch (error) {
    return { configured: true, bugs: [], error: error.message };
  }
}

export async function checkJiraHealth(input = {}, saved = {}) {
  const jira = resolveStudioJira(input, saved);

  if (!jira.url || !jira.token) {
    return { configured: false, ok: false, error: 'Jira credentials are not configured.' };
  }

  const transport = input.fetchImpl ?? createJiraFetch({ caPath: jira.ca, insecure: jira.insecure });
  const probe = await probeJira({
    baseUrl: jira.url,
    auth: jira.auth,
    email: jira.email,
    token: jira.token,
    apiVersion: jira.apiVersion,
    ca: jira.ca,
    insecure: jira.insecure,
    fetchImpl: transport
  });

  return {
    configured: true,
    ok: probe.ok,
    url: jira.url,
    auth: probe.auth,
    apiVersion: probe.apiVersion,
    user: probe.user ?? null,
    error: probe.error ?? null
  };
}

async function buildConfig({ cwd, version }) {
  const git = await describeGit(cwd);
  const date = todayLocal();

  return {
    version,
    cwd,
    git,
    jira: {
      url: process.env.JIRA_BASE_URL ?? '',
      email: process.env.JIRA_EMAIL ?? '',
      auth: process.env.JIRA_AUTH ?? 'auto',
      apiVersion: process.env.JIRA_API_VERSION ?? 'auto',
      hasCa: Boolean(process.env.JIRA_CA_CERT),
      insecure: process.env.JIRA_INSECURE === '1',
      hasToken: Boolean(process.env.JIRA_API_TOKEN),
      hasSavedToken: hasSavedToken(cwd)
    },
    settings: readSettings(cwd),
    agents: STUDIO_AGENT_PRESETS,
    prPresets: STUDIO_PR_PRESETS,
    defaults: {
      agentCmd: DEFAULT_AGENT_COMMAND,
      agentPreset: 'claude',
      prPreset: 'github',
      workDir: DEFAULT_WORK_DIR,
      maxTurns: DEFAULT_MAX_TURNS,
      limit: DEFAULT_LIMIT,
      timeout: DEFAULT_TIMEOUT_SECONDS,
      verifyCommand: detectVerifyCommand(cwd),
      base: git.base ?? '',
      fetchBase: true,
      branch: `bug-fix/${date}`,
      tag: `bug-fix-${date}`
    }
  };
}

async function handleRequest(req, res, context) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    sendAsset(res, 'index.html');
    return;
  }

  if (req.method === 'GET' && (pathname === '/app.js' || pathname === '/styles.css' || pathname === '/markdown.js')) {
    sendAsset(res, pathname.slice(1));
    return;
  }

  // Mermaid is vendored so the studio works without a CDN. The diagram bundle is
  // large, so it may be cached by the local browser; the license ships with it.
  if (req.method === 'GET' && pathname === '/vendor/mermaid/mermaid.min.js') {
    sendAsset(res, 'vendor/mermaid/mermaid.min.js', { cache: 'public, max-age=86400' });
    return;
  }

  if (req.method === 'GET' && pathname === '/vendor/mermaid/LICENSE') {
    sendAsset(res, 'vendor/mermaid/LICENSE', { cache: 'public, max-age=86400' });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, version: context.version });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    sendJson(res, 200, await buildConfig(context));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/settings') {
    sendJson(res, 200, {
      settings: readSettings(context.cwd),
      hasSavedToken: hasSavedToken(context.cwd)
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = await readJsonBody(req);
    const patch = body.settings ?? body;

    // Merge so saving the form never drops the token; an explicit "" clears a key.
    const stored = writeSettings(context.cwd, { ...readStore(context.cwd), ...patch });

    sendJson(res, 200, {
      settings: cleanKeys(stored, SETTINGS_KEYS),
      hasSavedToken: Boolean(stored.jiraToken)
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/jira/projects') {
    const body = await readJsonBody(req);
    const result = await listJiraProjects({ ...body, fetchImpl: context.fetchImpl }, readStore(context.cwd));

    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/jira/bugs') {
    const body = await readJsonBody(req);
    const result = await listJiraBugs({ ...body, fetchImpl: context.fetchImpl }, readStore(context.cwd));

    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/jira/health') {
    const body = await readJsonBody(req);
    const result = await checkJiraHealth({ ...body, fetchImpl: context.fetchImpl }, readStore(context.cwd));

    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sweeps') {
    const jobs = [...context.jobManager.jobs.values()]
      .filter((job) => job.type === 'bug-sweep')
      .map(context.jobManager.snapshot);

    sendJson(res, 200, { jobs });
    return;
  }

  // Enhancement and feature sessions share one interview engine; only the skill
  // and the final artifact differ.
  for (const route of SESSION_ROUTE_PREFIXES) {
    if (req.method === 'GET' && pathname === route.prefix) {
      const jobs = [...context.jobManager.jobs.values()]
        .filter((job) => (job.flow ?? job.type) === route.flow)
        .map(context.jobManager.snapshot);

      sendJson(res, 200, { jobs });
      return;
    }

    if (req.method === 'POST' && pathname === route.prefix) {
      const body = await readJsonBody(req);
      const job = context.jobManager.startSession(route.flow, body);

      sendJson(res, 202, { job: context.jobManager.snapshot(job) });
      return;
    }

    const eventsMatch = new RegExp(`^${route.prefix}/([^/]+)/events$`).exec(pathname);

    if (req.method === 'GET' && eventsMatch) {
      const job = context.jobManager.jobs.get(eventsMatch[1]);

      if (!job || (job.flow ?? job.type) !== route.flow) {
        sendJson(res, 404, { error: 'Unknown session.' });
        return;
      }

      streamEvents(req, res, job);
      return;
    }

    const cancelMatch = new RegExp(`^${route.prefix}/([^/]+)/cancel$`).exec(pathname);

    if (req.method === 'POST' && cancelMatch) {
      sendJson(res, 200, { cancelled: context.jobManager.cancelJob(cancelMatch[1]) });
      return;
    }

    const sessionMatch = new RegExp(`^${route.prefix}/([^/]+)$`).exec(pathname);

    if (req.method === 'GET' && sessionMatch) {
      const job = context.jobManager.jobs.get(sessionMatch[1]);

      if (!job || (job.flow ?? job.type) !== route.flow) {
        sendJson(res, 404, { error: 'Unknown session.' });
        return;
      }

      sendJson(res, 200, { job: context.jobManager.snapshot(job) });
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/api/sweeps') {
    const body = await readJsonBody(req);
    const job = context.jobManager.startSweep(body);

    sendJson(res, 202, { job: context.jobManager.snapshot(job) });
    return;
  }

  const eventsMatch = /^\/api\/sweeps\/([^/]+)\/events$/.exec(pathname);

  if (req.method === 'GET' && eventsMatch) {
    const job = context.jobManager.jobs.get(eventsMatch[1]);

    if (!job) {
      sendJson(res, 404, { error: 'Unknown job.' });
      return;
    }

    streamEvents(req, res, job);
    return;
  }

  const cancelMatch = /^\/api\/sweeps\/([^/]+)\/cancel$/.exec(pathname);

  if (req.method === 'POST' && cancelMatch) {
    sendJson(res, 200, { cancelled: context.jobManager.cancelJob(cancelMatch[1]) });
    return;
  }

  const sweepMatch = /^\/api\/sweeps\/([^/]+)$/.exec(pathname);

  if (req.method === 'GET' && sweepMatch) {
    const job = context.jobManager.jobs.get(sweepMatch[1]);

    if (!job) {
      sendJson(res, 404, { error: 'Unknown job.' });
      return;
    }

    sendJson(res, 200, { job: context.jobManager.snapshot(job) });
    return;
  }

  const inputMatch = /^\/api\/jobs\/([^/]+)\/input$/.exec(pathname);

  if (req.method === 'POST' && inputMatch) {
    const body = await readJsonBody(req);
    const accepted = context.jobManager.submitInput(inputMatch[1], body);

    sendJson(res, accepted ? 200 : 404, { accepted });
    return;
  }

  const permissionMatch = /^\/api\/jobs\/([^/]+)\/permission$/.exec(pathname);

  if (req.method === 'POST' && permissionMatch) {
    const body = await readJsonBody(req);
    const accepted = context.jobManager.submitPermission(permissionMatch[1], body);

    sendJson(res, accepted ? 200 : 404, { accepted });
    return;
  }

  sendJson(res, 404, { error: `No route for ${req.method} ${pathname}.` });
}

export function createStudioServer(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const version = options.version ?? '0.0.0';
  const jobManager = createJobManager({
    cwd,
    version,
    fetchImpl: options.fetchImpl,
    spawnImpl: options.spawnImpl,
    spawnProcess: options.spawnProcess,
    terminate: options.terminate,
    now: options.now
  });
  const context = { cwd, version, jobManager, fetchImpl: options.fetchImpl };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, context).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, error.statusCode ?? 500, { error: error.message });
      } else {
        res.end();
      }
    });
  });

  return {
    server,
    jobManager,
    cwd,
    version,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', url] : [url];

  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Opening the browser is best effort.
  }
}

export async function runStudio(argv = [], dependencies = {}) {
  const options = parseStudioArgs(argv);

  if (options.help) {
    return formatStudioHelp();
  }

  const studio = createStudioServer({
    cwd: dependencies.cwd ?? process.cwd(),
    version: dependencies.version,
    fetchImpl: dependencies.fetchImpl,
    spawnImpl: dependencies.spawnImpl,
    spawnProcess: dependencies.spawnProcess,
    terminate: dependencies.terminate,
    now: dependencies.now
  });
  const port = await listen(studio.server, options.port, options.host);
  const url = `http://${options.host}:${port}/`;
  const local = ['127.0.0.1', 'localhost', '::1'].includes(options.host);

  if (options.open && dependencies.openBrowser !== false) {
    openBrowser(url);
  }

  return `SDD Studio is running at ${url}\nPress Ctrl+C to stop.${local ? '' : '\nWarning: the dashboard has no authentication. Keep it on localhost unless you add your own protection.'}`;
}
