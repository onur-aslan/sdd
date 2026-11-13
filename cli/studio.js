import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_FETCH_LIMIT,
  DEFAULT_GITHUB_API_URL,
  DEFAULT_GITHUB_STATE,
  DEFAULT_LIMIT,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_WORK_DIR,
  LEGACY_WORK_DIR,
  buildJiraAuthHeader,
  buildJql,
  createJiraFetch,
  fetchGitHubBugs,
  fetchJiraBugs,
  fetchJiraProjects,
  normalizeGitHubRepo,
  probeGitHub,
  probeJira,
  resolveSweepBranch,
  runBugSweep,
  runProcess
} from './bug-sweep.js';
import { fetchGitLabIssues, normalizeGitLabProject } from './gitlab-issues.js';
import { closeTrackerIssue, createTrackerIssue, normalizeSourceIssue, specIssueTitle } from './issue-tracker.js';
import { runInterviewSession, resolveSessionFlow, validateBrief, validateSessionSkillArguments } from './agent-session.js';
import { FEATURE_PIPELINES } from './feature-build.js';
import {
  createSessionPublishPlan,
  commitSessionWork,
  publishSessionWork,
  sessionSlug
} from './session-publish.js';
import {
  STUDIO_EFFORTS,
  STUDIO_WORKFLOWS,
  isSecretClaudeEnvKey,
  modelOptionsFromEnv,
  normalizeClaudeEnv,
  normalizeWorkflowSettings,
  parseClaudeModelList,
  resolveWorkflowSelection
} from './agent-config.js';
import {
  SESSION_HISTORY_LIMIT,
  listSessionHistory,
  readSessionMarkdown,
  readSessionRecord,
  removeSessionHistory,
  writeSessionRecord
} from './session-history.js';
import {
  cleanupOrphanWorktrees,
  copySpecToMainCheckout,
  createSessionWorktree,
  removeSessionWorktree
} from './session-worktree.js';

export const STUDIO_DEFAULT_PORT = 4321;
export const STUDIO_DEFAULT_HOST = '127.0.0.1';

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
  { prefix: '/api/spec-issues', flow: 'specIssue' },
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

// One publish choice replaces the old push/pr toggles. The dashboard never
// commits without pushing, so an explicit commit-only choice is retired: it
// becomes a plain push. Legacy push/pr booleans resolve to push as well, and an
// explicit publish choice always wins.
export function normalizePublish(publish, request = {}) {
  if (publish === 'push' || publish === 'pr') {
    return publish;
  }

  if (publish === 'commit') {
    return 'push';
  }

  if (request.push === false || request.pr === false) {
    return 'push';
  }

  return 'pr';
}

// Turn a dashboard request into the exact argv "sdd bug-sweep" understands.
export function buildSweepArgs(request = {}) {
  const args = [];
  const value = (flag, input) => {
    if (input !== undefined && input !== null && input !== '') {
      args.push(flag, String(input));
    }
  };

  const source = ['github', 'gitlab'].includes(request.source) ? request.source : 'jira';

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
  } else if (source === 'gitlab') {
    value('--source', 'gitlab');
    value('--gitlab-project', request.gitlabProject);
    value('--issues', Array.isArray(request.issues) && request.issues.length > 0 ? request.issues.join(',') : '');
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
  if (request.closeIssues) {
    args.push('--close-issues');
  }
  if (request.verbose) {
    args.push('--verbose');
  }

  const publish = normalizePublish(request.publish, request);

  if (publish === 'push') {
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
    || job.status === 'stopping'
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

async function remoteBranchesList(cwd) {
  const result = await runProcess(
    'git',
    ['branch', '-r', '--format=%(refname:short)'],
    { cwd }
  );

  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('origin/HEAD'));
}

// A merge starts from two real local branches. The worktree is created from the
// target, so the main checkout does not need to be clean or on the target; the
// explicit land action is what requires a clean tree.
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

function sessionStateDir(cwd, flow, id) {
  return path.join(path.resolve(cwd, DEFAULT_WORK_DIR), 'sessions', String(flow), String(id));
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

// Closing is a best-effort step after a successful run. The issue key and its
// tracker target were captured when the session started; credentials stay in
// the local settings store.
async function closeSourceIssueForJob({
  cwd,
  issue,
  settings = {},
  fetchImpl,
  run = runProcess
} = {}) {
  const source = normalizeSourceIssue(issue);

  if (!source) {
    throw new Error('The source issue has no supported tracker key.');
  }

  if (source.source === 'jira') {
    const jira = resolveStudioJira(settings, settings);

    if (!jira.url || !jira.token) {
      throw new Error('Jira credentials are not configured.');
    }

    return closeTrackerIssue({
      issue: source,
      jira: {
        baseUrl: jira.url,
        headers: {
          Authorization: buildJiraAuthHeader({ auth: jira.auth, email: jira.email, token: jira.token }),
          Accept: 'application/json'
        },
        apiVersion: jira.apiVersion,
        fetchImpl: fetchImpl ?? createJiraFetch({ caPath: jira.ca, insecure: jira.insecure })
      }
    });
  }

  if (source.source === 'github') {
    const github = resolveStudioGitHub(settings, settings);
    const repo = source.target || github.repo;

    if (!repo) {
      throw new Error('A GitHub repository is not configured.');
    }

    return closeTrackerIssue({
      issue: source,
      github: {
        repo,
        token: await githubCliToken(cwd),
        apiUrl: github.apiUrl,
        fetchImpl: fetchImpl ?? globalThis.fetch
      }
    });
  }

  const project = source.target || settings.gitlabProject;

  if (!project) {
    throw new Error('A GitLab project is not configured.');
  }

  return closeTrackerIssue({
    issue: source,
    gitlab: { project, cwd, run }
  });
}

// The spec issue flow files the spec itself as one tracker issue. The tracker
// source is the global issue source; the old per-tab setting is only a fallback.
export function resolveSpecIssueTarget({ request = {}, saved = {} } = {}) {
  const imported = normalizeSourceIssue(request.issue);
  const requested = String(request.source || request.specIssueSource || '').toLowerCase();
  const stored = String(saved.source || saved.specIssueSource || '').toLowerCase();
  const source = imported?.source
    || (['github', 'gitlab', 'jira'].includes(requested) ? requested : '')
    || (['github', 'gitlab', 'jira'].includes(stored) ? stored : 'jira');
  const savedTarget = source === 'github'
    ? saved.githubRepo
    : source === 'gitlab'
      ? saved.gitlabProject
      : saved.project;

  return {
    source,
    target: String(imported?.target || savedTarget || '').trim()
  };
}

async function createIssueForJob({
  cwd,
  target,
  artifact,
  settings = {},
  fetchImpl,
  run = runProcess
} = {}) {
  const spec = fs.readFileSync(artifact, 'utf8');
  const source = String(target?.source ?? '').toLowerCase();
  const destination = String(target?.target ?? '').trim();
  const title = specIssueTitle(spec, featureNameFromSpec(artifact));

  if (source === 'jira') {
    const jira = resolveStudioJira(settings, settings);

    if (!jira.url || !jira.token) {
      throw new Error('Jira credentials are not configured.');
    }

    return createTrackerIssue({
      source,
      target: destination,
      title,
      body: spec,
      jira: {
        baseUrl: jira.url,
        headers: {
          Authorization: buildJiraAuthHeader({ auth: jira.auth, email: jira.email, token: jira.token }),
          Accept: 'application/json'
        },
        apiVersion: jira.apiVersion,
        fetchImpl: fetchImpl ?? createJiraFetch({ caPath: jira.ca, insecure: jira.insecure })
      }
    });
  }

  if (source === 'github') {
    const github = resolveStudioGitHub(settings, settings);
    const repo = destination || github.repo;

    if (!repo) {
      throw new Error('A GitHub repository is not configured.');
    }

    return createTrackerIssue({
      source,
      target: repo,
      title,
      body: spec,
      github: {
        repo,
        token: await githubCliToken(cwd),
        apiUrl: github.apiUrl,
        fetchImpl: fetchImpl ?? globalThis.fetch
      }
    });
  }

  if (source === 'gitlab') {
    const project = destination || settings.gitlabProject;

    if (!project) {
      throw new Error('A GitLab project is not configured.');
    }

    return createTrackerIssue({
      source,
      target: project,
      title,
      body: spec,
      gitlab: { project, cwd, run }
    });
  }

  throw new Error(`Unsupported issue source "${source}".`);
}

// A run closes its source issue only after the branch was pushed, with or
// without a merge request. That is the same rule for every workflow.
function publishCompleted(publish) {
  return Boolean(publish?.enabled) && ['pushed', 'published'].includes(publish.status);
}

export function createJobManager({ cwd, fetchImpl, spawnImpl, spawnProcess, terminate, now } = {}) {
  const jobs = new Map();
  const pendingInputs = new Map();
  const pendingPermissions = new Map();
  const pendingBuilds = new Map();
  let activeSweepId = null;

  // Sessions left on disk by an earlier Studio process are read-only history.
  // Any status that was still alive is honestly closed as failed; nothing is
  // resumed automatically.
  for (const flow of STUDIO_WORKFLOWS.filter((entry) => entry !== 'bugSweep')) {
    for (const record of listSessionHistory(cwd, flow, { limit: 500 })) {
      const status = ['queued', 'running', 'waiting', 'stopping', 'cancelling'].includes(record.status)
        ? 'failed'
        : String(record.status ?? 'done');
      const job = {
        id: String(record.id),
        type: flow,
        flow,
        status,
        createdAt: record.createdAt ?? new Date(0).toISOString(),
        updatedAt: record.updatedAt ?? record.createdAt ?? new Date(0).toISOString(),
        request: publicRequest(record.request ?? { brief: record.brief ?? '' }),
        publish: record.publish ?? null,
        specIssue: record.specIssue ?? null,
        result: record.result ?? null,
        error: record.error ?? (status === 'failed' ? 'The Studio restarted before this session finished.' : null),
        events: Array.isArray(record.events) ? record.events : [],
        turns: Array.isArray(record.turns) ? record.turns : [],
        selection: publicSelection(record.selection) ?? {
          model: record.model ?? '',
          effort: record.effort ?? '',
          mr: true
        },
        branch: record.branch ?? '',
        base: record.base ?? '',
        worktree: record.worktree ?? '',
        historical: true,
        readOnly: true,
        listeners: new Set(),
        cancelled: false
      };

      jobs.set(job.id, job);
    }
  }

  // Remove worktrees that no active session owns. Startup is the only moment
  // when every worktree on disk is guaranteed to be an orphan.
  const ready = cleanupOrphanWorktrees(cwd, { run: runProcess }).catch(() => []);

  function publicRequest(request = {}) {
    const copy = { ...request };

    // Never echo saved tracker or Claude credentials through the API or into
    // session history.
    for (const key of SECRET_SETTINGS_KEYS) {
      if (copy[key]) {
        copy[key] = '***';
      }
    }

    if (copy.claudeEnv && typeof copy.claudeEnv === 'object') {
      copy.claudeEnv = Object.fromEntries(
        Object.entries(copy.claudeEnv).map(([key, value]) => [
          key,
          isSecretClaudeEnvKey(key) ? '' : value
        ])
      );
    }

    return copy;
  }

  function publicSelection(selection) {
    if (!selection) {
      return null;
    }

    return {
      model: selection.model ?? '',
      effort: selection.effort ?? '',
      mr: selection.mr !== false
    };
  }

  function snapshot(job) {
    const request = publicRequest(job.request);

    return {
      id: job.id,
      type: job.type,
      flow: job.flow ?? job.type,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      request,
      publish: job.publish ?? null,
      specIssue: job.specIssue ?? null,
      result: job.result,
      error: job.error,
      events: job.events,
      selection: publicSelection(job.selection),
      model: job.selection?.model ?? '',
      effort: job.selection?.effort ?? '',
      branch: job.branch ?? '',
      base: job.base ?? '',
      worktree: job.worktree ?? '',
      historical: job.historical === true,
      readOnly: job.readOnly === true
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

  // session.json/session.md are written after each turn and on every terminal
  // transition, not on every token, so a long reply does not thrash the disk.
  function persist(job) {
    if (job.historical) {
      return;
    }

    const result = job.result && typeof job.result === 'object' ? { ...job.result } : job.result ?? null;

    if (result && typeof result === 'object') {
      delete result.turns;
    }

    try {
      writeSessionRecord(cwd, {
        id: job.id,
        flow: job.flow ?? job.type,
        brief: job.request?.brief ?? '',
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        model: job.selection?.model ?? '',
        effort: job.selection?.effort ?? '',
        branch: job.branch ?? job.publish?.branch ?? '',
        base: job.base ?? '',
        worktree: job.worktree ?? '',
        request: publicRequest(job.request),
        selection: publicSelection(job.selection),
        publish: job.publish ?? null,
        specIssue: job.specIssue ?? null,
        result,
        error: job.error ?? null,
        events: job.events,
        turns: job.turns ?? []
      });
    } catch {
      // History is a convenience; the live session must not fail on it.
    }
  }

  function rememberWorkflow(flow, selection) {
    const store = readStore(cwd);
    const workflows = normalizeWorkflowSettings(store.workflows);
    const current = workflows[flow] ?? {};

    workflows[flow] = {
      model: selection.model,
      effort: selection.effort,
      base: selection.base === undefined ? (current.base ?? '') : selection.base,
      mr: selection.mr !== false
    };

    try {
      writeSettings(cwd, { ...store, workflows });
    } catch {
      // Remembering the selection must never block a start.
    }
  }

  // A tracker rejection is reported on the job, but a finished run stays done.
  async function closeJobIssue(job) {
    if (!job.closeIssues || !job.issue) {
      return;
    }

    try {
      const result = await closeSourceIssueForJob({
        cwd,
        issue: job.issue,
        settings: readStore(cwd),
        fetchImpl,
        run: spawnImpl ?? runProcess
      });

      emit(job, {
        type: 'issue-closed',
        key: job.issue.key,
        status: result.status,
        url: job.issue.url ?? ''
      });
    } catch (error) {
      emit(job, {
        type: 'issue-close-failed',
        key: job.issue.key,
        error: error.message
      });
    }
  }

  // The spec is the artifact; the tracker issue is the handoff. A missing
  // target or a tracker rejection is reported on the job but never turns a
  // finished interview into a failure.
  async function publishSpecIssue(job, artifact) {
    const target = job.specIssueTarget ?? { source: '', target: '' };

    if (!target.target) {
      const reason = target.source === 'github'
        ? 'Set a GitHub repository in Settings to create the spec issue.'
        : target.source === 'gitlab'
          ? 'Set a GitLab project in Settings to create the spec issue.'
          : 'Pick a Jira project in Settings to create the spec issue.';

      job.specIssue = { status: 'skipped', source: target.source, reason };
      emit(job, { type: 'issue-skipped', source: target.source, reason });

      return;
    }

    try {
      const result = await createIssueForJob({
        cwd,
        target,
        artifact,
        settings: readStore(cwd),
        fetchImpl,
        run: spawnImpl ?? runProcess
      });

      job.specIssue = { status: 'created', ...result };
      emit(job, {
        type: 'issue-created',
        source: result.source,
        key: result.key,
        url: result.url
      });
    } catch (error) {
      job.specIssue = { status: 'failed', source: target.source, error: error.message };
      emit(job, {
        type: 'issue-create-failed',
        source: target.source,
        error: error.message
      });
    }
  }

  // Only bug-sweep is serial. Live sessions run in their own worktrees and do
  // not compete for the main checkout.
  function assertSweepIdle() {
    const active = activeSweepId ? jobs.get(activeSweepId) : null;

    if (active && isAlive(active)) {
      const error = new Error(`A sweep is already running (${active.id}). Wait for it or stop it first.`);
      error.statusCode = 409;
      throw error;
    }
  }

  function startSweep(request = {}) {
    assertSweepIdle();

    const store = readStore(cwd);
    const selection = resolveWorkflowSelection(store, 'bugSweep', request);

    // A minimal request inherits the choices the user already made once. The
    // base is workflow-scoped; an explicit request wins, including a blank one.
    const effective = applySettings({ ...request, base: request.base ?? selection.base ?? '' }, store);

    try {
      writeSettings(cwd, effective);
    } catch {
      // Remembering settings is a convenience; never block a sweep on it.
    }

    // Write the workflow selection after the merged settings, or the older
    // store snapshot would overwrite it again.
    rememberWorkflow('bugSweep', selection);

    const id = randomUUID();
    const job = {
      id,
      type: 'bug-sweep',
      flow: 'bugSweep',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      request: effective,
      selection,
      branch: effective.branch ?? '',
      base: effective.base ?? '',
      worktree: '',
      events: [],
      listeners: new Set(),
      result: null,
      error: null,
      cancelled: false,
      controller: new AbortController()
    };

    jobs.set(id, job);
    activeSweepId = id;

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
          model: selection.model,
          effort: selection.effort,
          agentEnv: selection.environment,
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
        if (activeSweepId === id) {
          activeSweepId = null;
        }
      });

    return job;
  }

  async function disposeWorktree(job, { deleteBranch }) {
    const worktreePath = job.worktree;

    if (!worktreePath) {
      return;
    }

    try {
      await removeSessionWorktree({
        cwd,
        worktreePath,
        branch: job.branch,
        deleteBranch,
        run: runProcess
      });
    } catch {
      // The outcome is already decided; a locked directory is retried by the
      // next startup orphan sweep.
    }

    job.worktree = '';
    emit(job, { type: 'worktree-removed', branch: job.branch ?? '', deleted: deleteBranch });
  }

  async function publishJob(job, summary) {
    const publish = job.publish;

    if (!publish || !job.worktree) {
      return;
    }

    const flow = job.flow ?? job.type;
    const spec = summary?.artifact
      ? path.relative(job.worktree, summary.artifact).split(path.sep).join('/')
      : '';
    const slug = flow === 'feature'
      ? featureNameFromSpec(summary?.artifact ?? '')
      : sessionSlug(job.request?.brief, flow);
    const title = flow === 'feature'
      ? `feat: implement ${slug}`
      : sessionChangeTitle(flow, job.request?.brief);
    const body = sessionChangeBody({
      flow,
      id: job.id,
      brief: job.request?.brief,
      extra: spec ? `Spec: ${spec}` : ''
    });

    await commitSessionWork({
      cwd: job.worktree,
      publish,
      title,
      body,
      emit: (event) => emit(job, event),
      run: runProcess
    });

    if (publish.commits.length > 0 && publish.status !== 'failed') {
      await publishSessionWork({
        cwd: job.worktree,
        publish,
        title,
        body,
        dir: sessionStateDir(cwd, flow, job.id),
        emit: (event) => emit(job, event),
        run: runProcess
      });
    }
  }

  // A live session with the agent. Every flow uses one long-lived process; the
  // worktree is created before the process starts and removed when it ends.
  async function startSession(flow, request = {}) {
    await ready;

    const config = resolveSessionFlow(flow);
    const store = readStore(cwd);
    const selection = resolveWorkflowSelection(store, config.id, request);

    rememberWorkflow(config.id, selection);

    // A merge needs branches, not a written brief; its prompt is derived from
    // the two branch names. Every other workflow still needs a brief. Validation
    // always runs, even when the dashboard sends a prebuilt merge object.
    const merge = config.id === 'merge'
      ? await validateMergeRequest(cwd, {
        source: request.source ?? request.merge?.source,
        target: request.target ?? request.merge?.target
      })
      : null;
    const brief = merge ? mergeBrief(merge) : validateBrief(request.brief);
    const skillArguments = validateSessionSkillArguments(config.id, request.skillArguments);
    const isSpecIssue = config.id === 'specIssue';
    const sourceIssue = config.id === 'merge' ? null : normalizeSourceIssue(request.issue);
    const closeIssues = config.id !== 'merge'
      && !isSpecIssue
      && (request.closeIssues === undefined ? store.closeIssues === true : request.closeIssues === true);
    const specIssueTarget = isSpecIssue ? resolveSpecIssueTarget({ request, saved: store }) : null;
    const id = randomUUID();

    let worktree;

    try {
      worktree = await createSessionWorktree({
        cwd,
        id,
        flow: config.id,
        brief: brief,
        base: config.id === 'merge' ? merge.target : (selection.base ?? '')
      });
    } catch (error) {
      error.statusCode = error.statusCode ?? 400;
      throw error;
    }

    const publish = ['enhancement', 'feature'].includes(config.id)
      ? createSessionPublishPlan({
        flow: config.id,
        brief: brief,
        id,
        request: { mr: request.mr ?? selection.mr },
        saved: store
      })
      : null;

    if (publish) {
      publish.branch = worktree.branch;
      publish.base = worktree.base;
      publish.startedSha = worktree.startedSha;
      publish.status = 'branch';
    }

    const job = {
      id,
      type: config.id,
      flow: config.id,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      request: {
        brief: brief,
        skillArguments,
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.effort ? { effort: selection.effort } : {}),
        mr: selection.mr,
        ...(sourceIssue ? { issue: sourceIssue } : {}),
        closeIssues,
        ...(specIssueTarget ? { specIssueTarget } : {}),
        ...(merge ? { merge } : {})
      },
      selection: {
        model: selection.model,
        effort: selection.effort,
        mr: selection.mr
      },
      issue: sourceIssue,
      closeIssues,
      specIssueTarget,
      publish,
      branch: worktree.branch,
      base: worktree.base,
      worktree: worktree.path,
      events: [],
      listeners: new Set(),
      turns: [],
      result: null,
      error: null,
      cancelled: false,
      historical: false,
      readOnly: false,
      controller: new AbortController()
    };

    jobs.set(id, job);

    emit(job, { type: 'job-started', jobId: id, kind: config.id });
    emit(job, {
      type: 'worktree',
      path: worktree.path,
      branch: worktree.branch,
      base: worktree.base
    });

    (async () => {
      try {
        const summary = await runInterviewSession(
          {
            flow: config.id,
            brief: brief,
            skillArguments,
            ...(merge ? { merge } : {})
          },
          {
            cwd: worktree.path,
            stateCwd: cwd,
            id,
            spawnProcess,
            terminate,
            signal: job.controller.signal,
            emit: (event) => emit(job, event),
            waitForAnswer: (question) => askInput(job, question),
            waitForPermission: (permission) => askPermission(job, permission),
            waitForBuild: (build) => askBuild(job, build),
            model: selection.model,
            effort: selection.effort,
            agentEnv: selection.environment,
            merge,
            onTurn: ({ turns }) => {
              job.turns = turns;
              persist(job);
            }
          }
        );

        job.result = summary;
        job.turns = summary.turns ?? job.turns;

        if (job.cancelled) {
          await disposeWorktree(job, { deleteBranch: true });
          job.status = 'stopped';
          persist(job);
          emit(job, { type: 'job-stopped', summary });
          return;
        }

        if (publish) {
          await publishJob(job, summary);
        }

        if (config.id === 'specIssue' && summary.artifact) {
          const destination = copySpecToMainCheckout({
            cwd,
            source: summary.artifact,
            featureName: featureNameFromSpec(summary.artifact)
          });

          summary.artifact = destination;
          await publishSpecIssue(job, destination);
        }

        if ((config.id === 'enhancement' || config.id === 'feature') && publishCompleted(publish)) {
          await closeJobIssue(job);
        }

        // specIssue never publishes, so its throwaway branch goes with the
        // worktree. Published enhancement/feature branches stay for the MR.
        await disposeWorktree(job, { deleteBranch: config.id === 'specIssue' });

        job.status = 'done';
        persist(job);
        emit(job, {
          type: 'job-done',
          summary: {
            output: summary.output,
            engine: summary.engine,
            flow: summary.flow,
            ...(summary.ref ? { ref: summary.ref } : {}),
            ...(summary.build ? { build: summary.build } : {}),
            ...(publish ? { publish } : {}),
            ...(job.specIssue ? { issue: job.specIssue } : {})
          }
        });
      } catch (error) {
        job.error = error.message;

        if (job.cancelled || error.cancelled) {
          await disposeWorktree(job, { deleteBranch: true });
          job.status = 'stopped';
          persist(job);
          emit(job, { type: 'job-stopped', summary: job.result });
        } else {
          await disposeWorktree(job, { deleteBranch: true });
          job.status = 'failed';
          persist(job);
          emit(job, { type: 'job-failed', message: error.message });
        }
      }
    })();

    return job;
  }

  function startEnhancement(request = {}) {
    return startSession('enhancement', request);
  }

  function startFeature(request = {}) {
    return startSession('feature', request);
  }

  // The separate planning workflow: deep-spec writes the spec, then the Studio
  // copies it into the main checkout and files it as one tracker issue.
  function startSpecIssue(request = {}) {
    return startSession('specIssue', request);
  }

  // A merge session uses the same live engine. Its worktree is created from the
  // target branch, so the main checkout can stay wherever it is until "land".
  function startMerge(request = {}) {
    return startSession('merge', request);
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

  // The feature build is a turn in the same job. The human's choice resumes the
  // waiting live process instead of creating a separate feature-build job.
  function askBuild(job, request) {
    job.status = 'waiting';
    emit(job, {
      type: 'build-choice',
      artifact: request?.artifact ?? '',
      spec: request?.spec ?? ''
    });

    return new Promise((resolve) => {
      pendingBuilds.set(job.id, { job, resolve });
    });
  }

  function submitBuild(jobId, payload = {}) {
    const pending = pendingBuilds.get(jobId);

    if (!pending) {
      return false;
    }

    pendingBuilds.delete(jobId);
    pending.job.status = 'running';
    pending.resolve({
      pipeline: payload.pipeline,
      verify: payload.verify !== false
    });

    return true;
  }

  function cancelJob(id) {
    const job = jobs.get(id);

    if (!job || !isAlive(job) || job.readOnly) {
      return false;
    }

    job.status = 'stopping';
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

    const build = pendingBuilds.get(id);

    if (build) {
      pendingBuilds.delete(id);
      build.resolve({ cancelled: true });
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

  function listSessions(flow) {
    const matching = [...jobs.values()].filter((job) => (job.flow ?? job.type) === flow);
    const active = matching
      .filter((job) => isAlive(job))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    const history = matching
      .filter((job) => !isAlive(job))
      .sort((left, right) => String(right.updatedAt ?? right.createdAt).localeCompare(String(left.updatedAt ?? left.createdAt)));

    return [...active, ...history].slice(0, SESSION_HISTORY_LIMIT);
  }

  function sessionDetail(flow, id) {
    const job = jobs.get(id);

    if (!job || (job.flow ?? job.type) !== flow) {
      return null;
    }

    return {
      job: snapshot(job),
      markdown: readSessionMarkdown(cwd, flow, id)
    };
  }

  function deleteSession(flow, id) {
    const job = jobs.get(id);

    if (!job || (job.flow ?? job.type) !== flow) {
      return false;
    }

    if (isAlive(job)) {
      const error = new Error('Stop the session before removing it from history.');
      error.statusCode = 409;
      throw error;
    }

    removeSessionHistory(cwd, flow, id);
    jobs.delete(id);

    return true;
  }

  return {
    jobs,
    ready,
    startSweep,
    startSession,
    startEnhancement,
    startFeature,
    startSpecIssue,
    startMerge,
    landMerge,
    submitBuild,
    cancelJob,
    askInput,
    submitInput,
    askPermission,
    submitPermission,
    listSessions,
    sessionDetail,
    deleteSession,
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

// Studio state is shared by every workflow, so it lives in its own directory
// instead of the bug-sweep work dir.
const STUDIO_STATE_DIR = '.sdd';
const SETTINGS_FILE = 'studio.settings.json';
// Only choices a human actually has to make. Dates, branch, tag, base branch, work
// directory, limits, and timeouts are derived by the command at run time.
const SETTINGS_KEYS = [
  'source',
  'project',
  'base',
  // Claude Code's environment and workflow-scoped model/effort selections.
  // Model ids are not stored in a built-in catalog.
  'claudeEnv',
  'workflows',
  // One publishing choice replaced the push/pr toggles. The old booleans stay
  // readable so an existing settings file keeps its behaviour on upgrade.
  'publish',
  'push',
  'pr',
  'closeIssues',
  'jiraType',
  'jiraUrl',
  'jiraEmail',
  'jiraAuth',
  'jiraApiVersion',
  'jiraCa',
  'jiraInsecure',
  'githubRepo',
  'githubLabel',
  'gitlabProject',
  // Legacy fallback for the CLI's spec-issue command; the Studio uses `source`.
  'specIssueSource',
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
  return path.join(path.resolve(cwd, STUDIO_STATE_DIR), SETTINGS_FILE);
}

// Older versions wrote the same file under the bug-sweep work dir. It is moved
// once so existing projects keep their project, agent, and tracker token.
function legacySettingsFile(cwd) {
  return path.join(path.resolve(cwd, LEGACY_WORK_DIR), SETTINGS_FILE);
}

function cleanKeys(raw, keys) {
  const clean = {};

  for (const key of keys) {
    const value = raw[key];

    if (value !== undefined && value !== null && value !== '') {
      // Commit-only publishing is retired; keep old settings files valid by
      // reading and writing them as a plain push.
      clean[key] = key === 'publish' && value === 'commit' ? 'push' : value;
    }
  }

  return clean;
}

// Everything on disk, including the token. Server-side only.
export function readStore(cwd) {
  try {
    return cleanKeys(JSON.parse(fs.readFileSync(settingsFile(cwd), 'utf8')), STORE_KEYS);
  } catch {
    // Fall through to the legacy location.
  }

  const legacy = legacySettingsFile(cwd);

  try {
    const store = cleanKeys(JSON.parse(fs.readFileSync(legacy, 'utf8')), STORE_KEYS);

    if (Object.keys(store).length === 0) {
      return store;
    }

    // Write the new copy first; the legacy file is only removed once it succeeded
    // so an unreadable or read-only project keeps working from the old location.
    try {
      writeSettings(cwd, store);
      fs.rmSync(legacy, { force: true });
    } catch {
      // Keep serving the legacy copy when the new location cannot be written.
    }

    return store;
  } catch {
    return {};
  }
}

function mergeClaudeEnv(requestValue, savedValue) {
  const saved = normalizeClaudeEnv(savedValue);

  if (requestValue === undefined || requestValue === null) {
    return saved;
  }

  const requestedRaw = requestValue && typeof requestValue === 'object' && !Array.isArray(requestValue)
    ? requestValue
    : {};
  const requested = normalizeClaudeEnv(requestValue);
  const merged = { ...requested };

  // A blank secret field means "keep the saved value". Removing the row
  // removes the key entirely, which is the only way to clear a secret.
  for (const [key, value] of Object.entries(saved)) {
    if (
      isSecretClaudeEnvKey(key) &&
      Object.prototype.hasOwnProperty.call(requestedRaw, key) &&
      !requestedRaw[key]
    ) {
      merged[key] = value;
    }
  }

  return merged;
}

// The public view: safe to return to the dashboard. Workflow selections are
// normalized so a partial settings file still drives the UI, and secret
// environment values are removed before the response leaves the server.
export function publicSettings(store = {}) {
  const settings = cleanKeys(store, SETTINGS_KEYS);

  settings.claudeEnv = normalizeClaudeEnv(settings.claudeEnv);
  settings.claudeEnvSecrets = Object.keys(settings.claudeEnv).filter(isSecretClaudeEnvKey);
  settings.claudeEnv = Object.fromEntries(
    Object.entries(settings.claudeEnv).map(([key, value]) => [
      key,
      isSecretClaudeEnvKey(key) ? '' : value
    ])
  );
  settings.workflows = normalizeWorkflowSettings(settings.workflows);

  return settings;
}

export function readSettings(cwd) {
  return publicSettings(readStore(cwd));
}

export function hasSavedToken(cwd) {
  return Boolean(readStore(cwd).jiraToken);
}

export function hasSavedGitHubToken(cwd) {
  return Boolean(readStore(cwd).githubToken);
}

export function writeSettings(cwd, settings = {}) {
  const clean = cleanKeys(settings, STORE_KEYS);

  if (clean.claudeEnv !== undefined) {
    clean.claudeEnv = normalizeClaudeEnv(clean.claudeEnv);
  }

  if (clean.workflows !== undefined) {
    clean.workflows = normalizeWorkflowSettings(clean.workflows);
  }

  ensureWorkDir(path.resolve(cwd, STUDIO_STATE_DIR));

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

  merged.claudeEnv = mergeClaudeEnv(request.claudeEnv, settings.claudeEnv);

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

  const jiraType = pick(input.jiraType, saved.jiraType, env.JIRA_TYPE, '');
  const defaultAuth = jiraType === 'cloud' ? 'basic' : jiraType === 'datacenter' ? 'bearer' : 'auto';
  const defaultApiVersion = jiraType === 'cloud' ? '3' : jiraType === 'datacenter' ? '2' : 'auto';

  const auth = pick(input.jiraAuth, saved.jiraAuth, env.JIRA_AUTH, defaultAuth);

  return {
    jiraType,
    url: pick(input.jiraUrl, saved.jiraUrl, env.JIRA_BASE_URL, ''),
    // An email only matters for Basic auth; auto and bearer use the token alone.
    email: auth === 'basic' ? pick(input.jiraEmail, saved.jiraEmail, env.JIRA_EMAIL, '') : '',
    token: pick(input.jiraToken, saved.jiraToken, env.JIRA_API_TOKEN, ''),
    auth,
    apiVersion: pick(input.jiraApiVersion, saved.jiraApiVersion, env.JIRA_API_VERSION, defaultApiVersion),
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

export async function githubCliToken(cwd) {
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
        description: bug.description,
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

export async function checkGitLabHealth(input = {}) {
  try {
    const result = await runProcess('glab', ['auth', 'status'], {
      cwd: input.cwd ?? process.cwd(),
      timeoutMs: 10000
    });

    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      return { configured: true, ok: false, error: detail || 'GitLab CLI is not authenticated. Run "glab auth login".' };
    }

    return { configured: true, ok: true, detail: (result.stdout || result.stderr).trim() };
  } catch (error) {
    const message = error.code === 'ENOENT'
      ? 'GitLab CLI (glab) is not installed or is not on PATH. Install it from https://docs.gitlab.com/cli/.'
      : `GitLab CLI (glab) check failed: ${error.message}`;

    return { configured: false, ok: false, error: message };
  }
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

export async function listGitLabIssues(input = {}, saved = {}) {
  const projectValue = input.gitlabProject ?? input.project ?? saved.gitlabProject ?? '';
  if (!String(projectValue).trim()) {
    return { configured: true, issues: [], error: 'Set a GitLab project in Settings first.' };
  }

  try {
    const issues = await fetchGitLabIssues({
      project: projectValue,
      limit: input.limit ?? 100,
      cwd: input.cwd ?? process.cwd(),
      run: input.run ?? runProcess
    });
    return {
      configured: true,
      total: issues.length,
      issues: issues.map((issue) => ({
        key: issue.key,
        summary: issue.summary,
        description: issue.description,
        type: 'Issue',
        priority: issue.priority,
        status: issue.statusLabel,
        url: issue.url
      }))
    };
  } catch (error) {
    return { configured: true, issues: [], error: error.message };
  }
}

export async function fetchGitLabIssue(input = {}, saved = {}) {
  const projectValue = input.gitlabProject ?? input.project ?? saved.gitlabProject ?? '';
  if (!String(projectValue).trim()) {
    return { configured: true, issue: null, error: 'Set a GitLab project in Settings first.' };
  }

  try {
    const issues = await fetchGitLabIssues({
      project: projectValue,
      issues: [input.key],
      limit: 1,
      cwd: input.cwd ?? process.cwd(),
      run: input.run ?? runProcess
    });
    return issues.length
      ? { configured: true, issue: issues[0] }
      : { configured: true, issue: null, error: `GitLab issue ${input.key} was not found.` };
  } catch (error) {
    return { configured: true, issue: null, error: error.message };
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

// `claude -p "/model"` is a local command, not a model call. It returns the
// same alias list the interactive picker shows, so Studio never has to ship a
// stale model catalog. A custom gateway can still add model ids through
// ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL in the environment editor.
export async function readClaudeModels({ cwd, claudeEnv = {}, run = runProcess } = {}) {
  const env = { ...process.env, ...normalizeClaudeEnv(claudeEnv) };
  const fallback = modelOptionsFromEnv(claudeEnv);
  let result;

  try {
    result = await run(
      'claude',
      ['-p', '/model', '--output-format', 'json', '--no-session-persistence'],
      { cwd, env, timeoutMs: 20000 }
    );
  } catch (error) {
    return { models: fallback, available: [], current: '', error: error.message };
  }

  const stdout = String(result?.stdout ?? '').trim();
  let parsed = null;

  try {
    parsed = stdout ? JSON.parse(stdout) : null;
  } catch {
    // Older builds may print plain text. Parse it below.
  }

  const text = parsed?.result ?? stdout;
  const list = parseClaudeModelList(text, claudeEnv);
  const models = [...new Set([...list.models, ...fallback])];

  if (models.length === 0) {
    const detail = String(result?.stderr ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');

    return {
      models,
      available: [],
      current: '',
      error: detail || `Claude Code returned no model list (exit ${result?.code ?? 'unknown'}).`
    };
  }

  return { ...list, models, error: '' };
}

async function buildConfig({ cwd, version }) {
  const git = await describeGit(cwd);
  const branch = await resolveSweepBranch(cwd);
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
    workflows: normalizeWorkflowSettings(readStore(cwd).workflows),
    efforts: STUDIO_EFFORTS,
    workflowsAvailable: STUDIO_WORKFLOWS,
    prPresets: STUDIO_PR_PRESETS,
    featurePipelines: FEATURE_PIPELINES,
    sessionHistoryLimit: SESSION_HISTORY_LIMIT,
    defaults: {
      prPreset: 'github',
      workDir: DEFAULT_WORK_DIR,
      maxTurns: DEFAULT_MAX_TURNS,
      limit: DEFAULT_LIMIT,
      timeout: DEFAULT_TIMEOUT_SECONDS,
      verifyCommand: detectVerifyCommand(cwd),
      base: git.base ?? '',
      fetchBase: true,
      branch,
      tag: null
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

  // The interactive `/model` picker is not exposed as a stream-json event.
  // A short local `claude -p "/model"` probe returns the same list without a
  // model call, and can be refreshed from Settings.
  if (req.method === 'GET' && pathname === '/api/branches') {
    const branches = await localBranches(context.cwd);
    const remoteBranches = await remoteBranchesList(context.cwd);

    sendJson(res, 200, { branches, remoteBranches });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/claude/models') {
    const store = readStore(context.cwd);
    const result = await readClaudeModels({
      cwd: context.cwd,
      claudeEnv: store.claudeEnv,
      run: runProcess
    });

    sendJson(res, 200, result);
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

    // Merge so saving the form never drops unrelated values. An explicit ""
    // clears a tracker token; for Claude environment secrets a blank field
    // keeps the saved value and removing the row is the explicit clear.
    const saved = readStore(context.cwd);
    const merged = { ...saved, ...patch };

    merged.claudeEnv = mergeClaudeEnv(patch.claudeEnv, saved.claudeEnv);
    const stored = writeSettings(context.cwd, merged);

    sendJson(res, 200, {
      settings: publicSettings(stored),
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

  if (req.method === 'POST' && pathname === '/api/gitlab/bugs') {
    const body = await readJsonBody(req);
    const listed = await listGitLabIssues({ ...body, cwd: context.cwd }, readStore(context.cwd));
    sendJson(res, 200, {
      configured: listed.configured,
      error: listed.error,
      total: listed.total ?? 0,
      bugs: (listed.issues ?? []).map((issue) => ({
        key: issue.key,
        summary: issue.summary,
        description: issue.description,
        priority: issue.priority,
        status: issue.status,
        url: issue.url
      }))
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/github/health') {
    const body = await readJsonBody(req);
    const result = await checkGitHubHealth({ ...body, cwd: context.cwd, fetchImpl: context.fetchImpl }, readStore(context.cwd));

    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/gitlab/issues') {
    const body = await readJsonBody(req);
    const result = await listGitLabIssues({ ...body, cwd: context.cwd }, readStore(context.cwd));
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/gitlab/issue') {
    const body = await readJsonBody(req);
    const result = await fetchGitLabIssue({ ...body, cwd: context.cwd }, readStore(context.cwd));
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/gitlab/health') {
    const body = await readJsonBody(req);
    const result = await checkGitLabHealth({ ...body, cwd: context.cwd });

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

  // Every session flow exposes the same shape under its own prefix. Sessions in
  // different flows, and multiple sessions in the same flow, run in parallel.
  for (const route of SESSION_ROUTE_PREFIXES) {
    if (req.method === 'GET' && pathname === route.prefix) {
      const jobs = context.jobManager.listSessions(route.flow).map(context.jobManager.snapshot);

      sendJson(res, 200, { jobs });
      return;
    }

    if (req.method === 'POST' && pathname === route.prefix) {
      const body = await readJsonBody(req);
      const job = route.flow === 'merge'
        ? await context.jobManager.startMerge(body)
        : await context.jobManager.startSession(route.flow, body);

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
      const detail = context.jobManager.sessionDetail(route.flow, sessionMatch[1]);

      if (!detail) {
        sendJson(res, 404, { error: 'Unknown session.' });
        return;
      }

      sendJson(res, 200, detail);
      return;
    }

    if (req.method === 'DELETE' && sessionMatch) {
      const deleted = context.jobManager.deleteSession(route.flow, sessionMatch[1]);

      sendJson(res, deleted ? 200 : 404, { deleted });
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

  // The feature build is a turn in the same job: the waiting process receives
  // the start-build choice on its own stdin. There is no separate build job.
  const buildMatch = /^\/api\/features\/([^/]+)\/build$/.exec(pathname);

  if (req.method === 'POST' && buildMatch) {
    const body = await readJsonBody(req);
    const accepted = context.jobManager.submitBuild(buildMatch[1], body);

    sendJson(res, accepted ? 202 : 409, {
      accepted,
      ...(accepted ? {} : { error: 'No build is waiting for a start choice in this session.' })
    });
    return;
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
