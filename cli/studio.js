import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_AGENT_COMMAND,
  DEFAULT_FETCH_LIMIT,
  DEFAULT_GITHUB_API_URL,
  DEFAULT_GITHUB_STATE,
  DEFAULT_LIMIT,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_WORK_DIR,
  buildJiraAuthHeader,
  buildJql,
  createJiraFetch,
  fetchGitHubBugs,
  fetchJiraBugs,
  fetchJiraProjects,
  normalizeAgentCommand,
  normalizeGitHubRepo,
  probeGitHub,
  probeJira,
  runBugSweep,
  runProcess
} from './bug-sweep.js';
import { runInterviewSession, resolveSessionFlow, validateBrief, validateSessionSkillArguments } from './agent-session.js';
import { FEATURE_PIPELINES, resolveFeaturePipeline, runFeatureBuild } from './feature-build.js';
import {
  abandonSessionPublish,
  beginSessionPublish,
  commitSessionWork,
  createSessionPublishPlan,
  publishSessionWork,
  sessionSlug
} from './session-publish.js';

export const STUDIO_DEFAULT_PORT = 4321;
export const STUDIO_DEFAULT_HOST = '127.0.0.1';

// The dashboard offers a one-click agent choice. The command is still passed
// through --agent-cmd, so the sweep itself stays agent-agnostic.
export const STUDIO_AGENT_PRESETS = [
  { id: 'claude', label: 'Claude Code', command: DEFAULT_AGENT_COMMAND },
  { id: 'cursor', label: 'Cursor', command: '["cursor-agent","-p","--force","--output-format","stream-json"]' },
  { id: 'opencode', label: 'OpenCode', command: '["opencode","run","--format","json","--agent","build"]' },
  { id: 'codex', label: 'Codex', command: '["codex","exec","--json","--skip-git-repo-check"]' },
  { id: 'custom', label: 'Custom command', command: '' }
];

function findCodexExecutable(env = process.env) {
  const candidates = [];
  const add = (candidate) => {
    if (!candidate || !fs.existsSync(candidate)) return;
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) candidates.push({ path: candidate, mtimeMs: stat.mtimeMs });
    } catch {
      // A stale PATH entry or an install being updated should not block startup.
    }
  };

  for (const directory of String(env.PATH ?? '').split(path.delimiter)) {
    if (directory) {
      for (const name of ['codex.exe', 'codex.cmd', 'codex.bat']) {
        add(path.join(directory.replace(/^"|"$/g, ''), name));
      }
    }
  }

  // The desktop installer stores Codex in a versioned directory under this
  // location. Studio may have been launched before that directory was added
  // to PATH, so check the install location directly as well.
  const localAppData = env.LOCALAPPDATA
    || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : '');
  const codexBin = localAppData ? path.join(localAppData, 'OpenAI', 'Codex', 'bin') : '';
  if (codexBin && fs.existsSync(codexBin)) {
    add(path.join(codexBin, 'codex.exe'));
    try {
      for (const entry of fs.readdirSync(codexBin, { withFileTypes: true })) {
        if (entry.isDirectory()) add(path.join(codexBin, entry.name, 'codex.exe'));
      }
    } catch {
      // PATH candidates above remain usable if the install directory is unreadable.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.path ?? '';
}

function studioAgentPresets() {
  const executable = process.platform === 'win32' ? findCodexExecutable() : '';

  return STUDIO_AGENT_PRESETS.map((preset) => (
    preset.id === 'codex' && executable
      ? { ...preset, command: JSON.stringify([executable, 'exec', '--json', '--skip-git-repo-check']) }
      : preset
  ));
}

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
  { prefix: '/api/features', flow: 'feature' },
  { prefix: '/api/merges', flow: 'merge' }
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

The browser opens automatically when the terminal is interactive.

Options:
  --port <n>     Port to listen on (default: ${STUDIO_DEFAULT_PORT})
  --host <addr>  Interface to bind (default: ${STUDIO_DEFAULT_HOST}, local only)
  --no-open      Do not open the dashboard in your browser

The dashboard drives "sdd bug-sweep" from the browser: pick a Jira project or a
GitHub repository, watch each bug get fixed one at a time, and open the pull
request. Later enhancement and feature runs reuse the same job view, including
the interview steps that need your input.

Examples:
  sdd studio
  sdd studio --port 8080 --no-open
`;
}

export function parseStudioArgs(argv = []) {
  let port = STUDIO_DEFAULT_PORT;
  let host = STUDIO_DEFAULT_HOST;
  // null means "decide by terminal": open in an interactive shell, stay closed
  // in tests, pipes, and CI.
  let open = null;

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

    if (name === '--no-open') {
      open = false;
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

  const source = request.source === 'github' ? 'github' : 'jira';

  if (source === 'github') {
    value('--source', 'github');
    value('--github-repo', request.githubRepo);
    value('--github-token', request.githubToken);
    value(
      '--github-label',
      Array.isArray(request.githubLabels) && request.githubLabels.length > 0
        ? request.githubLabels.join(',')
        : request.githubLabel
    );
    value('--github-state', request.githubState);
    value('--github-api-url', request.githubApiUrl);
    value(
      '--issues',
      Array.isArray(request.issues) && request.issues.length > 0 ? request.issues.join(',') : ''
    );
  } else {
    value('--project', request.project);
    value('--jql', request.jql);
    value(
      '--issues',
      Array.isArray(request.issues) && request.issues.length > 0 ? request.issues.join(',') : ''
    );
  }

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

function mergeError(statusCode, message) {
  const error = new Error(message);

  error.statusCode = statusCode;

  return error;
}

async function localBranches(cwd) {
  // Most recently committed first: the merge setup uses this order for its
  // dropdowns, so the branch just worked on is at the top.
  const result = await runProcess(
    'git',
    ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'],
    { cwd }
  );

  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// A merge starts only from a clean tree with two real local branches. The
// integration branch is created by the agent, never by this validation.
async function validateMergeRequest(cwd, request = {}) {
  const source = String(request.source ?? '').trim();
  const target = String(request.target ?? '').trim();

  if (!source || !target) {
    throw mergeError(400, 'Pick a source branch and a target branch.');
  }

  if (source === target) {
    throw mergeError(400, 'Pick two different branches.');
  }

  const inside = await runProcess('git', ['rev-parse', '--is-inside-work-tree'], { cwd });

  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw mergeError(400, 'The studio is not running inside a git repository.');
  }

  const branches = await localBranches(cwd);

  if (!branches.includes(source)) {
    throw mergeError(400, `The source branch "${source}" does not exist.`);
  }

  if (!branches.includes(target)) {
    throw mergeError(400, `The target branch "${target}" does not exist.`);
  }

  const dirty = (await runProcess('git', ['status', '--porcelain'], { cwd })).stdout.trim();

  if (dirty) {
    const changed = dirty
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 6)
      .map((line) => line.trim());

    throw mergeError(
      409,
      `The working tree has changes. Commit or stash them before a merge: ${changed.join(', ')}.`
    );
  }

  const ref = `merge/${source}-into-${target}`;
  const exists = await runProcess('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], { cwd });

  if (exists.code === 0) {
    throw mergeError(
      409,
      `The integration branch "${ref}" already exists. Delete it, or merge into a different target.`
    );
  }

  const base = await runProcess('git', ['rev-parse', target], { cwd });

  if (base.code !== 0) {
    throw mergeError(400, `Could not read the target branch "${target}".`);
  }

  return { source, target, ref, baseSha: base.stdout.trim() };
}

function mergeBrief(merge) {
  return [
    `Merge "${merge.source}" into "${merge.target}" through the integration branch "${merge.ref}".`,
    `The target "${merge.target}" stays untouched until you land the branch.`,
    'Start with the preflight checks and the dry run; ask only when a decision is needed.'
  ].join('\n');
}

function sessionWorkDir(cwd, id) {
  return path.join(path.resolve(cwd, DEFAULT_WORK_DIR), 'sessions', id);
}

function sessionChangeTitle(flow, brief) {
  const first = String(brief ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? 'studio session';
  const line = first.replace(/^[A-Z][A-Z0-9_]*-\d+:\s*/, '').slice(0, 72).trim() || 'studio session';

  return `feat: ${line}`;
}

function sessionChangeBody({ flow, id, brief, extra = '' }) {
  return [
    `SDD studio ${flow} session ${id}`,
    '',
    String(brief ?? '').slice(0, 4000),
    extra
  ].filter((part) => part !== '').join('\n');
}

function featureNameFromSpec(specPath) {
  return path.basename(path.dirname(String(specPath ?? ''))) || 'feature';
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
      publish: job.publish ?? null,
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
      const label = active.type === 'bug-sweep'
        ? 'sweep'
        : active.type === 'feature-build'
          ? 'build'
          : 'session';
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

    Promise.resolve()
      .then(async () => {
        const sweepRequest = effective.source === 'github'
          ? { ...effective, githubToken: await githubCliToken(cwd) }
          : effective;
        return runBugSweep(buildSweepArgs(sweepRequest), {
          cwd,
          fetchImpl,
          spawnImpl,
          agentPreset: effective.agentPreset,
          now,
          signal: job.controller.signal,
          logger: (line) => emit(job, { type: 'log', line }),
          onEvent: (event) => emit(job, event)
        });
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
  // that the enhancement flow implements after approval, or a spec (feature).
  // The skill files stay untouched on disk.
  function startSession(flow, request = {}) {
    const config = resolveSessionFlow(flow);

    assertIdle();

    const brief = validateBrief(request.brief);
    const merge = request.merge && typeof request.merge === 'object' ? request.merge : null;
    const skillArguments = validateSessionSkillArguments(config.id, request.skillArguments);
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
    const publish = config.id === 'merge'
      ? null
      : createSessionPublishPlan({
        flow: config.id,
        brief,
        id,
        request: { publish: request.publish, base: request.base, push: request.push, pr: request.pr },
        saved
      });
    const job = {
      id,
      type: config.id,
      flow: config.id,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      request: {
        brief,
        agentPreset,
        agentCmd,
        skillArguments,
        ...(publish ? { publish: publish.enabled } : {}),
        ...(merge ? { merge } : {})
      },
      publish,
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

    (async () => {
      if (publish) {
        try {
          ensureWorkDir(path.resolve(cwd, DEFAULT_WORK_DIR));
        } catch {
          // The session still runs; publish will report a clear git error if it must.
        }

        await beginSessionPublish({
          cwd,
          publish,
          emit: (event) => emit(job, event)
        });
      }

      return runInterviewSession(
        { flow: config.id, brief, agentPreset, agentCmd, skillArguments, ...(merge ? { merge } : {}) },
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
      );
    })()
      .then(async (summary) => {
        job.result = summary;

        if (job.cancelled) {
          if (publish) {
            await abandonSessionPublish({
              cwd,
              publish,
              emit: (event) => emit(job, event),
              reason: 'The session was stopped before it finished, so its changes were not published.'
            });
          }

          job.status = 'cancelled';
          emit(job, { type: 'job-cancelled', summary });
          return;
        }

        if (publish?.status === 'branch' && config.id === 'enhancement') {
          const title = sessionChangeTitle('enhancement', brief);
          const body = sessionChangeBody({ flow: 'enhancement', id, brief });

          await commitSessionWork({
            cwd,
            publish,
            title,
            body,
            emit: (event) => emit(job, event)
          });

          if (publish.commits.length > 0) {
            await publishSessionWork({
              cwd,
              publish,
              title,
              body,
              dir: sessionWorkDir(cwd, id),
              emit: (event) => emit(job, event)
            });
          }
        }

        if (publish?.status === 'branch' && config.id === 'feature') {
          const slug = sessionSlug(brief, 'feature');
          const spec = summary.artifact
            ? path.relative(cwd, summary.artifact).split(path.sep).join('/')
            : '';
          const title = `docs: add ${slug} spec`;
          const body = sessionChangeBody({
            flow: 'feature',
            id,
            brief,
            extra: spec ? `Spec: ${spec}` : ''
          });

          // The spec is committed on the session branch now; the build adds its
          // own commit and only then pushes the branch and opens the MR.
          await commitSessionWork({
            cwd,
            publish,
            title,
            body,
            emit: (event) => emit(job, event),
            cleanupWhenEmpty: false
          });
        }

        job.status = 'done';
        emit(job, {
          type: 'job-done',
          summary: {
            output: summary.output,
            engine: summary.engine,
            flow: summary.flow,
            ...(summary.ref ? { ref: summary.ref } : {}),
            ...(publish ? { publish } : {})
          }
        });
      })
      .catch(async (error) => {
        job.error = error.message;

        if (publish) {
          await abandonSessionPublish({
            cwd,
            publish,
            emit: (event) => emit(job, event),
            reason: 'The session failed, so its changes were not published.'
          });
        }

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

  // A merge session is the same interview engine with a branch-based end. The
  // source and target are validated before the job exists, so a dirty tree or a
  // taken integration branch is a clear 409 instead of a session that fails.
  async function startMerge(request = {}) {
    assertIdle();

    const merge = await validateMergeRequest(cwd, request);

    return startSession('merge', { ...request, brief: mergeBrief(merge), merge });
  }

  // Landing is explicit and local: fast-forward the target, never push, never
  // create a merge commit. If anything is not safe, refuse with the reason.
  async function landMerge(sessionId) {
    const job = jobs.get(sessionId);

    if (!job || (job.flow ?? job.type) !== 'merge') {
      throw mergeError(404, 'Unknown merge session.');
    }

    const merge = job.request?.merge;

    if (!merge?.ref || !merge?.target) {
      throw mergeError(400, 'This session has no integration branch to land.');
    }

    if (job.status !== 'done') {
      throw mergeError(409, 'Finish the merge session before landing the branch.');
    }

    const refCheck = await runProcess(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/heads/${merge.ref}`],
      { cwd }
    );

    if (refCheck.code !== 0) {
      throw mergeError(409, `The integration branch "${merge.ref}" no longer exists.`);
    }

    const targetCheck = await runProcess(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/heads/${merge.target}`],
      { cwd }
    );

    if (targetCheck.code !== 0) {
      throw mergeError(409, `The target branch "${merge.target}" no longer exists.`);
    }

    // The target must be an ancestor of the integration branch, or the landing
    // is not a fast-forward and the human must merge the new target first.
    const ancestor = await runProcess(
      'git',
      ['merge-base', '--is-ancestor', merge.target, merge.ref],
      { cwd }
    );

    if (ancestor.code !== 0) {
      throw mergeError(
        409,
        `The target branch "${merge.target}" has moved since the merge started. Start a new merge against the current target.`
      );
    }

    const dirty = (await runProcess('git', ['status', '--porcelain'], { cwd })).stdout.trim();

    if (dirty) {
      throw mergeError(409, 'The working tree has changes. Commit or stash them before landing the branch.');
    }

    const current = (await runProcess('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim();
    const restoreBranch = async () => {
      if (current && current !== merge.target) {
        await runProcess('git', ['switch', current], { cwd });
      }
    };

    if (current !== merge.target) {
      const switched = await runProcess('git', ['switch', merge.target], { cwd });

      if (switched.code !== 0) {
        const detail = (switched.stderr || switched.stdout || '').trim();

        throw mergeError(
          409,
          `Could not switch to "${merge.target}".${detail ? ` ${detail}` : ''} Nothing was pushed.`
        );
      }
    }

    let landed;

    try {
      landed = await runProcess('git', ['merge', '--ff-only', merge.ref], { cwd });
    } catch (error) {
      await restoreBranch();
      throw mergeError(409, `The fast-forward failed: ${error.message} Nothing was pushed.`);
    }

    if (landed.code !== 0) {
      const detail = (landed.stderr || landed.stdout || '').trim();

      await restoreBranch();

      throw mergeError(
        409,
        `The fast-forward failed${detail ? `: ${detail}` : ''}. Nothing was pushed, and no merge commit was created.`
      );
    }

    const sha = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();

    return {
      target: merge.target,
      ref: merge.ref,
      sha,
      previousBranch: current,
      fastForward: true
    };
  }

  function findBuild(sessionId) {
    return [...jobs.values()]
      .filter((job) => job.type === 'feature-build' && job.sessionId === sessionId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .at(-1);
  }

  // After the spec exists the human decides how it gets built. The build is a
  // job like a sweep: it streams each skill step and can be stopped.
  function startFeatureBuild(sessionId, request = {}) {
    const session = jobs.get(sessionId);

    if (!session || session.type !== 'feature') {
      const error = new Error('Unknown feature session.');
      error.statusCode = 404;
      throw error;
    }

    if (!session.result?.artifact) {
      const error = new Error('This session has no spec yet. Finish the interview first.');
      error.statusCode = 400;
      throw error;
    }

    const pipeline = resolveFeaturePipeline(request.pipeline);
    const verify = request.verify !== false;

    assertIdle();

    const id = randomUUID();
    const job = {
      id,
      type: 'feature-build',
      flow: 'feature-build',
      sessionId,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      request: { pipeline: pipeline.id, verify, specPath: session.result.artifact },
      publish: session.publish ?? null,
      events: [],
      listeners: new Set(),
      result: null,
      error: null,
      cancelled: false,
      controller: new AbortController()
    };

    jobs.set(id, job);
    activeJobId = id;

    emit(job, { type: 'job-started', jobId: id, kind: 'feature-build' });

    runFeatureBuild(
      {
        pipeline: pipeline.id,
        verify,
        specPath: session.result.artifact,
        agentCmd: session.request.agentCmd ?? readStore(cwd).agentCmd,
        agentPreset: session.request.agentPreset ?? readStore(cwd).agentPreset
      },
      {
        cwd,
        spawnImpl,
        signal: job.controller.signal,
        emit: (event) => emit(job, event)
      }
    )
      .then(async (summary) => {
        job.result = summary;

        if (job.cancelled) {
          job.status = 'cancelled';
          emit(job, { type: 'job-cancelled', summary });
          return;
        }

        const publish = job.publish;

        if (publish?.enabled && ['branch', 'committed', 'no-changes'].includes(publish.status)) {
          const slug = featureNameFromSpec(summary.specPath);
          const spec = path.relative(cwd, summary.specPath).split(path.sep).join('/');
          const title = `feat: implement ${slug}`;
          const body = sessionChangeBody({
            flow: 'feature',
            id: session.id,
            brief: session.request.brief,
            extra: `Spec: ${spec}`
          });

          if (['branch', 'committed'].includes(publish.status)) {
            await commitSessionWork({
              cwd,
              publish,
              title,
              body,
              emit: (event) => emit(job, event)
            });
          }

          if (publish.commits.length > 0 && publish.status !== 'failed') {
            await publishSessionWork({
              cwd,
              publish,
              title,
              body,
              dir: sessionWorkDir(cwd, session.id),
              emit: (event) => emit(job, event)
            });
          }
        }

        job.status = 'done';
        emit(job, { type: 'job-done', summary: { ...summary, ...(publish ? { publish } : {}) } });
      })
      .catch((error) => {
        job.error = error.message;

        if (job.cancelled || error.cancelled) {
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
    startMerge,
    landMerge,
    startFeatureBuild,
    findBuild,
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
    const branches = await localBranches(cwd);
    const remoteUrl = (await runProcess('git', ['remote', 'get-url', 'origin'], { cwd })).stdout.trim();

    return {
      repo: true,
      root,
      branch,
      base,
      dirty,
      branches,
      remote: remoteUrl,
      detached: branch === 'HEAD'
    };
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
  'source',
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
  'githubRepo',
  'githubLabel',
  'prPreset',
  'prCommand',
  // Set once the Settings drawer has been seen, so it opens on the first visit
  // and not on every reload while the project is still empty.
  'settingsSeen'
];

// The dashboard runs on localhost, so it remembers tracker tokens in the same
// git-ignored file. Tokens are never sent back to the browser; the API only
// exposes hasSavedToken and hasSavedGitHubToken. A blank token field means
// "keep using the saved one".
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

export function hasSavedGitHubToken(cwd) {
  return Boolean(readStore(cwd).githubToken);
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

export function resolveStudioGitHub(input = {}, saved = {}) {
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

  return {
    repo: pick(input.githubRepo, saved.githubRepo, env.GITHUB_REPOSITORY, ''),
    label: pick(input.githubLabel, saved.githubLabel, '', ''),
    apiUrl: DEFAULT_GITHUB_API_URL
  };
}

async function githubCliToken(cwd) {
  let result;

  try {
    result = await runProcess('gh', ['auth', 'token'], { cwd, timeoutMs: 10000 });
  } catch (error) {
    throw new Error(`GitHub CLI (gh) is required and must be authenticated: ${error.message}`);
  }

  const token = result.stdout.trim();

  if (result.code !== 0 || !token) {
    throw new Error(`GitHub CLI is not authenticated. Run "gh auth login"${result.stderr ? `: ${result.stderr.trim()}` : '.'}`);
  }

  return token;
}

function studioGitHubLabels(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }

  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function listGitHubBugs(input = {}, saved = {}) {
  const github = resolveStudioGitHub(input, saved);
  let repo;

  try {
    repo = normalizeGitHubRepo(github.repo);
  } catch (error) {
    return { configured: true, bugs: [], error: error.message };
  }

  if (!repo) {
    return { configured: false, bugs: [], error: 'Set a GitHub repository in Settings first.' };
  }

  try {
    const token = await githubCliToken(input.cwd ?? process.cwd());
    const bugs = await fetchGitHubBugs({
      repo,
      token,
      labels: input.ignoreLabels ? [] : studioGitHubLabels(github.label),
      state: DEFAULT_GITHUB_STATE,
      limit: input.limit ?? DEFAULT_FETCH_LIMIT,
      apiUrl: github.apiUrl,
      fetchImpl: input.fetchImpl
    });

    return {
      configured: true,
      repo,
      total: bugs.length,
      bugs: bugs.map((bug) => ({
        key: bug.key,
        number: bug.number,
        summary: bug.summary,
        priority: bug.priority,
        status: bug.statusLabel,
        labels: bug.labels,
        url: bug.url
      }))
    };
  } catch (error) {
    return { configured: true, bugs: [], error: error.message };
  }
}

export async function checkGitHubHealth(input = {}, saved = {}) {
  const github = resolveStudioGitHub(input, saved);

  if (!github.repo) {
    return { configured: false, ok: false, error: 'Set a GitHub repository in Settings first.' };
  }

  let token;

  try {
    token = await githubCliToken(input.cwd ?? process.cwd());
  } catch (error) {
    return { configured: true, ok: false, repo: github.repo, error: error.message };
  }

  const result = await probeGitHub({
    repo: github.repo,
    token,
    apiUrl: github.apiUrl,
    fetchImpl: input.fetchImpl
  });

  return { configured: true, ...result };
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

const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/i;

function mapStudioIssue(issue) {
  return {
    key: issue.key,
    summary: issue.summary,
    description: issue.description,
    type: issue.jiraType,
    priority: issue.priority,
    status: issue.jiraStatus,
    url: issue.url
  };
}

// Enhancement and feature briefs start as ordinary Jira issues, not only bugs.
// The picker lists the open issues in the project the studio already remembers.
export async function listJiraIssues(input = {}, saved = {}) {
  const jira = resolveStudioJira(input, saved);

  if (!jira.url || !jira.token) {
    return { configured: false, issues: [], error: 'Jira credentials are not configured.' };
  }

  const project = String(input.project ?? saved.project ?? '').trim();

  if (!project) {
    return { configured: true, issues: [], jql: '', error: 'Pick a Jira project first.' };
  }

  try {
    const transport = input.fetchImpl ?? createJiraFetch({ caPath: jira.ca, insecure: jira.insecure });
    const jql = `project = "${project.replace(/"/g, '\\"')}" AND statusCategory != Done ORDER BY updated DESC`;
    const issues = await fetchJiraBugs({
      baseUrl: jira.url,
      auth: jira.auth,
      email: jira.email,
      token: jira.token,
      apiVersion: jira.apiVersion,
      jql,
      limit: input.limit ?? 50,
      fetchImpl: transport
    });

    return {
      configured: true,
      jql,
      total: issues.length,
      issues: issues.map((issue) => ({
        key: issue.key,
        summary: issue.summary,
        type: issue.jiraType,
        priority: issue.priority,
        status: issue.jiraStatus,
        url: issue.url
      }))
    };
  } catch (error) {
    return { configured: true, issues: [], error: error.message };
  }
}

export async function fetchJiraIssue(input = {}, saved = {}) {
  const jira = resolveStudioJira(input, saved);

  if (!jira.url || !jira.token) {
    return { configured: false, issue: null, error: 'Jira credentials are not configured.' };
  }

  const key = String(input.key ?? '').trim().toUpperCase();

  if (!JIRA_ISSUE_KEY.test(key)) {
    return { configured: true, issue: null, error: 'Enter a Jira issue key like ABC-123.' };
  }

  try {
    const transport = input.fetchImpl ?? createJiraFetch({ caPath: jira.ca, insecure: jira.insecure });
    const issues = await fetchJiraBugs({
      baseUrl: jira.url,
      auth: jira.auth,
      email: jira.email,
      token: jira.token,
      apiVersion: jira.apiVersion,
      jql: `key = ${key}`,
      limit: 1,
      fetchImpl: transport
    });

    if (issues.length === 0) {
      return { configured: true, issue: null, error: `Jira issue ${key} was not found.` };
    }

    return { configured: true, issue: mapStudioIssue(issues[0]) };
  } catch (error) {
    return { configured: true, issue: null, error: error.message };
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
  let detectedGitHubRepo = '';

  try {
    detectedGitHubRepo = normalizeGitHubRepo(git.remote) ?? '';
  } catch {
    // The remote may point at an internal forge; it is only a convenience hint.
  }

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
    github: {
      repo: process.env.GITHUB_REPOSITORY ?? detectedGitHubRepo,
      usesCliAuth: true
    },
    settings: readSettings(cwd),
    agents: studioAgentPresets(),
    prPresets: STUDIO_PR_PRESETS,
    featurePipelines: FEATURE_PIPELINES,
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
      hasSavedToken: hasSavedToken(context.cwd),
      hasSavedGitHubToken: false
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
      hasSavedToken: Boolean(stored.jiraToken),
      hasSavedGitHubToken: false
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

  if (req.method === 'POST' && pathname === '/api/jira/issues') {
    const body = await readJsonBody(req);
    const result = await listJiraIssues({ ...body, fetchImpl: context.fetchImpl }, readStore(context.cwd));

    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/jira/issue') {
    const body = await readJsonBody(req);
    const result = await fetchJiraIssue({ ...body, fetchImpl: context.fetchImpl }, readStore(context.cwd));

    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/jira/health') {
    const body = await readJsonBody(req);
    const result = await checkJiraHealth({ ...body, fetchImpl: context.fetchImpl }, readStore(context.cwd));

    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/github/bugs') {
    const body = await readJsonBody(req);
    const result = await listGitHubBugs({ ...body, cwd: context.cwd, fetchImpl: context.fetchImpl }, readStore(context.cwd));

    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/github/health') {
    const body = await readJsonBody(req);
    const result = await checkGitHubHealth({ ...body, cwd: context.cwd, fetchImpl: context.fetchImpl }, readStore(context.cwd));

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
        .filter((job) => job.type !== 'feature-build' && (job.flow ?? job.type) === route.flow)
        .map(context.jobManager.snapshot);

      sendJson(res, 200, { jobs });
      return;
    }

    if (req.method === 'POST' && pathname === route.prefix) {
      const body = await readJsonBody(req);
      const job = route.flow === 'merge'
        ? await context.jobManager.startMerge(body)
        : context.jobManager.startSession(route.flow, body);

      sendJson(res, 202, { job: context.jobManager.snapshot(job) });
      return;
    }

    const eventsMatch = new RegExp(`^${route.prefix}/([^/]+)/events$`).exec(pathname);

    if (req.method === 'GET' && eventsMatch) {
      const job = context.jobManager.jobs.get(eventsMatch[1]);

      if (!job || job.type === 'feature-build' || (job.flow ?? job.type) !== route.flow) {
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

      if (!job || job.type === 'feature-build' || (job.flow ?? job.type) !== route.flow) {
        sendJson(res, 404, { error: 'Unknown session.' });
        return;
      }

      sendJson(res, 200, { job: context.jobManager.snapshot(job) });
      return;
    }
  }

  // Landing is an explicit second step after the integration branch exists. It
  // is local-only and fast-forward-only; the route never pushes.
  const landMatch = /^\/api\/merges\/([^/]+)\/land$/.exec(pathname);

  if (req.method === 'POST' && landMatch) {
    const result = await context.jobManager.landMerge(landMatch[1]);

    sendJson(res, 200, result);
    return;
  }

  // The feature build: the human picks a pipeline after the spec is approved and
  // the studio runs the workflow's skills one at a time.
  const buildEventsMatch = /^\/api\/features\/([^/]+)\/build\/events$/.exec(pathname);

  if (req.method === 'GET' && buildEventsMatch) {
    const build = context.jobManager.findBuild(buildEventsMatch[1]);

    if (!build) {
      sendJson(res, 404, { error: 'No build for this feature.' });
      return;
    }

    streamEvents(req, res, build);
    return;
  }

  const buildCancelMatch = /^\/api\/features\/([^/]+)\/build\/cancel$/.exec(pathname);

  if (req.method === 'POST' && buildCancelMatch) {
    const build = context.jobManager.findBuild(buildCancelMatch[1]);

    sendJson(res, 200, { cancelled: build ? context.jobManager.cancelJob(build.id) : false });
    return;
  }

  const buildMatch = /^\/api\/features\/([^/]+)\/build$/.exec(pathname);

  if (buildMatch) {
    if (req.method === 'GET') {
      const build = context.jobManager.findBuild(buildMatch[1]);

      sendJson(res, 200, { build: build ? context.jobManager.snapshot(build) : null });
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const build = context.jobManager.startFeatureBuild(buildMatch[1], body);

      sendJson(res, 202, { build: context.jobManager.snapshot(build) });
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

// A person opening the studio from a terminal wants the dashboard, not a URL
// to copy. Pipes, tests, and CI stay quiet, and --no-open always wins.
export function shouldOpenBrowser(options = {}, context = {}) {
  if (options.open === true) {
    return true;
  }

  if (options.open === false) {
    return false;
  }

  const isTTY = context.isTTY ?? process.stdout.isTTY;
  const env = context.env ?? process.env;

  return Boolean(isTTY) && !env.CI;
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

  if (shouldOpenBrowser(options) && dependencies.openBrowser !== false) {
    openBrowser(url);
  }

  return `SDD Studio is running at ${url}\nPress Ctrl+C to stop.${local ? '' : '\nWarning: the dashboard has no authentication. Keep it on localhost unless you add your own protection.'}`;
}
