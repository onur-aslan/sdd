import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { assertNativeSkillAvailable, buildNativeSkillCall, resolveNativeSkillAgent } from './native-skills.js';
import { fetchGitLabIssues, normalizeGitLabProject, parseGitLabIssueKeys } from './gitlab-issues.js';

export const DEFAULT_AGENT_COMMAND = '["claude","-p"]';
export const DEFAULT_MAX_TURNS = 5;
export const DEFAULT_LIMIT = 50;
export const DEFAULT_FETCH_LIMIT = 500;
export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const DEFAULT_WORK_DIR = '.bug-fix';
export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
export const DEFAULT_GITHUB_STATE = 'open';

export const DEFAULT_JIRA_FIELDS = [
  'summary',
  'description',
  'priority',
  'status',
  'labels',
  'issuetype',
  'created',
  'updated',
  'reporter'
];

const VALUE_FLAGS = new Set([
  '--project',
  '--jql',
  '--issues',
  '--date',
  '--base',
  '--branch',
  '--tag',
  '--agent-cmd',
  '--verify-cmd',
  '--max-turns',
  '--limit',
  '--timeout',
  '--work-dir',
  '--remote',
  '--jira-url',
  '--jira-email',
  '--jira-token',
  '--jira-auth',
  '--jira-api-version',
  '--jira-ca',
  '--github-repo',
  '--github-token',
  '--github-label',
  '--github-api-url',
  '--github-state',
  '--gitlab-project',
  '--source',
  '--pr-cmd',
  '--extra-fields'
]);

const BOOLEAN_FLAGS = new Set([
  '--resume',
  '--retry-failed',
  '--dry-run',
  '--no-push',
  '--no-pr',
  '--worktree',
  '--fetch-base',
  '--gitlab-push',
  '--jira-insecure',
  '--verbose'
]);

const CRITICAL_PATH_PATTERNS = [
  { pattern: /(^|\/)(auth|authentication|authorization|security|permissions?)\//i, label: 'authentication/authorization' },
  { pattern: /(^|\/)(payment|billing|checkout|invoice|refund)\//i, label: 'payments/billing' },
  { pattern: /(^|\/)(migrations?|schema|database|db)\//i, label: 'data/database migrations' },
  { pattern: /(^|\/)\.github\/workflows\//i, label: 'CI/CD workflows' },
  { pattern: /(^|\/)(terraform|helm|k8s|kubernetes|infra|deploy)\//i, label: 'infrastructure' },
  { pattern: /(^|\/)(dockerfile|docker-compose\.ya?ml)$/i, label: 'container/deployment' },
  { pattern: /\.sql$/i, label: 'SQL migration' }
];

export function formatBugSweepHelp() {
  return `Usage:
  sdd bug-sweep --project <KEY> [options]

Fetch Jira, GitHub, or GitLab bugs in order, fix them one at a time with the bug-fix skill,
commit each successful fix, create one branch and one tag, then open a pull request.

Required (one of):
  --project <KEY>          Jira project key, e.g. ABC
  --jql <query>            Custom JQL; --project is optional when the JQL names one
  --github-repo <repo>     GitHub repository, e.g. owner/repo (implies GitHub)
  --gitlab-project <path>  GitLab group/project (implies GitLab)
  --issues <keys>          Fix only these bugs, comma-separated, e.g. ABC-1,ABC-2
                           or 12,15 / GH-12,GH-15 / GL-12,GL-15 for forge issues

Source:
  --source <jira|github|gitlab> Bug source (default: jira, inferred from repository flags)

GitHub:
  --github-repo <repo>     GitHub repository, e.g. owner/repo or a GitHub URL
  --github-token <token>   Token for private repositories; GITHUB_TOKEN/GH_TOKEN works
  --github-label <labels>  Only issues with all of these comma-separated labels
  --github-state <state>   open | closed | all (default: open)
  --github-api-url <url>   API base for GitHub Enterprise (default: ${DEFAULT_GITHUB_API_URL})

GitLab:
  --gitlab-project <path>  GitLab group/project or full project URL
                           GitLab CLI (glab) must be installed and authenticated

Sweep options:
  --date <YYYY-MM-DD>      Sweep date (default: today)
  --base <ref>             Base branch (default: auto-detect origin/HEAD, main, or master)
  --fetch-base             Fetch the base branch from --remote first, so the sweep
                           starts from the up-to-date remote-tracking ref (origin/<base>)
  --branch <name>          Default: bug-fix/<date>
  --tag <name>             Default: bug-fix-<date>
  --limit <n>              Maximum bugs to fix in this run (default: ${DEFAULT_LIMIT});
                           the branch, tag, and PR wait until nothing is pending
  --max-turns <n>          Attempt limit passed to the bug-fix skill (default: ${DEFAULT_MAX_TURNS})
  --timeout <seconds>      Per-bug agent timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  --verify-cmd <command>   Optional command run before each commit, e.g. "npm test"
  --work-dir <path>        State, logs, prompts, and reports (default: ${DEFAULT_WORK_DIR})
  --extra-fields <a,b>     Extra Jira fields to include in the prompt

Isolation:
  --worktree               Create a separate git worktree under <work-dir>/worktrees/
                           and fix bugs there, so your own checkout is never touched
                           and may stay dirty. The worktree is removed once the sweep
                           publishes; on --resume it is reattached. Without this flag
                           the sweep runs directly in your working tree and refuses
                           a dirty one.

Agent:
  --agent-cmd <value>      Agent command. A JSON array is the safest form:
                           '["claude","-p"]'
                           A plain command line is also accepted; {prompt} and
                           {promptFile} placeholders are supported.
                           Default: ${DEFAULT_AGENT_COMMAND}

Scheduling:
  --at <HH:MM>             Wait until this local time, then start (e.g. 00:00)
  --every <duration>       Keep running: repeat after each sweep (30m, 2h, 1d)
  --run-now                With --every, run immediately instead of waiting
                           "sdd bug-sweep --project ABC --at 00:00 --every 1d"
                           sweeps nightly at midnight while the process runs.
                           For unattended runs, let cron or Task Scheduler start
                           "sdd bug-sweep --project ABC" at 00:00 instead.

Recovery:
  --resume                 Continue an existing sweep instead of starting over
  --retry-failed           Retry bugs a previous run reported as not fixed

Publishing:
  --remote <name>          Git remote (default: origin)
  --no-push                Do not push the branch or tag
  --no-pr                  Do not open or update a pull request
  --pr-cmd <command>       Replace the GitHub CLI. A plain command runs through the
                           shell and reads SDD_PR_TITLE, SDD_PR_BODY, SDD_PR_BODY_FILE,
                           SDD_PR_BASE, SDD_PR_HEAD, SDD_PR_REMOTE, SDD_PR_PROJECT, and
                           SDD_PR_DATE. A JSON array runs without a shell and supports
                           {title}, {body}, {bodyFile}, {base}, {head}, {remote},
                           {project}, and {date}. Either form must print the MR URL.
                           Example: "glab mr create --title \\"$SDD_PR_TITLE\\" ..."
  --gitlab-push            Create the merge request with git push options instead of a
                           CLI: merge_request.create, target, title, and description.
                           Requires GitLab and a server that advertises push options.
                           The MR URL is read from git's output when it is present.
  --dry-run                Fetch and print the plan without touching git
  --verbose                Stream agent output to stderr

Jira (Cloud, Server, or Data Center):
  --jira-url <url>         Base URL; JIRA_BASE_URL also works
  --jira-token <token>     API token or personal access token; JIRA_API_TOKEN also works
  --jira-email <email>     Only for Basic auth (Cloud, or DC with a password)
  --jira-auth <mode>       auto | basic | bearer (default: auto)
                           auto uses basic when --jira-email is set, otherwise bearer.
                           A Data Center personal access token needs bearer and no email.
  --jira-api-version <v>   auto | 2 | 3 (default: auto). Data Center and Server use v2.
  --jira-ca <path>         PEM file for an internal or self-signed CA
  --jira-insecure          Skip TLS verification (last resort; prefer --jira-ca)

Run "sdd jira-check" first to verify reachability, TLS, and credentials.

Exit status is non-zero only for setup, tracker, git, push, or PR failures. A bug
that cannot be fixed is recorded as "not fixed" and does not stop the sweep.`;
}

function localDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function validateDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    throw new Error(`Invalid --date "${value}". Expected YYYY-MM-DD.`);
  }

  const [, year, month, day] = match.map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`Invalid --date "${value}". Expected a real calendar date.`);
  }
}

function positiveInteger(value, flag) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${value}".`);
  }

  return parsed;
}

function validateGitName(value, flag) {
  if (
    !/^[A-Za-z0-9._/-]+$/.test(value)
    || value.startsWith('-')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('..')
    || value.includes('//')
    || value.includes('@{')
    || value.endsWith('.lock')
  ) {
    throw new Error(`Invalid ${flag} "${value}".`);
  }
}

export function parseCsv(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;

// Accept a comma-separated string or an array, normalize it, and reject typos
// before they reach JQL.
export function parseIssueKeys(value) {
  if (!value) {
    return [];
  }

  const entries = Array.isArray(value) ? value : String(value).split(',');
  const keys = [];

  for (const entry of entries) {
    const key = String(entry).trim().toUpperCase();

    if (!key) {
      continue;
    }
    if (!JIRA_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid Jira key "${entry}". Use the ABC-123 form.`);
    }
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }

  return keys;
}

const GITHUB_KEY_PATTERN = /^GH-(\d+)$/;

// GitHub issues are selected by number. Accept "#12", "12", "GH-12", or an
// issue URL and normalize all of them to the stable sweep key "GH-12".
export function parseGitHubIssueKeys(value) {
  if (!value) {
    return [];
  }

  const entries = Array.isArray(value) ? value : String(value).split(',');
  const keys = [];

  for (const entry of entries) {
    const text = String(entry).trim();

    if (!text) {
      continue;
    }

    const fromUrl = /\/issues\/(\d+)(?:[?#].*)?$/.exec(text)?.[1] ?? null;
    const normalized = text.toUpperCase();
    const fromKey = GITHUB_KEY_PATTERN.exec(normalized)?.[1] ?? null;
    const fromNumber = /^#?(\d+)$/.exec(text)?.[1] ?? null;
    const number = Number(fromUrl ?? fromKey ?? fromNumber);

    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`Invalid GitHub issue "${entry}". Use 123, #123, GH-123, or an issue URL.`);
    }

    const key = `GH-${number}`;

    if (!keys.includes(key)) {
      keys.push(key);
    }
  }

  return keys;
}

export function normalizeBugSource(value) {
  const source = String(value ?? 'jira').trim().toLowerCase();

  if (source === 'jira' || source === 'github' || source === 'gitlab') {
    return source;
  }

  throw new Error(`Invalid --source "${value}". Use jira, github, or gitlab.`);
}

export function normalizeGitHubRepo(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  let text = String(value).trim().replace(/\.git$/i, '').replace(/\/+$/, '');

  // Accept a full browser or SSH URL as well as the owner/repo shorthand.
  text = text
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, '')
    .replace(/^git@[^:]+:/i, '');

  const parts = text.split('/').filter(Boolean);
  const repo = parts.slice(-2).join('/');

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repository "${value}". Use owner/repo.`);
  }

  return repo;
}

export function normalizeGitHubState(value = DEFAULT_GITHUB_STATE) {
  const state = String(value || DEFAULT_GITHUB_STATE).trim().toLowerCase();

  if (state === 'open' || state === 'closed' || state === 'all') {
    return state;
  }

  throw new Error(`Invalid --github-state "${value}". Use open, closed, or all.`);
}

function mapGitHubIssue(issue) {
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean)
    : [];
  const priorityLabel = labels.find((label) => /^(priority\s*[:/]\s*\S+|p[0-3]|critical|high|medium|low)$/i.test(label)) ?? '';
  const state = issue.state === 'closed' ? 'Closed' : 'Open';

  return {
    key: `GH-${issue.number}`,
    id: issue.id == null ? null : String(issue.id),
    number: issue.number,
    summary: issue.title ?? '',
    description: issue.body ?? '',
    priority: priorityLabel,
    jiraStatus: '',
    statusLabel: state,
    labels,
    url: issue.html_url ?? '',
    source: 'github',
    tracker: 'GitHub',
    state: issue.state ?? '',
    extraFields: {}
  };
}

async function readGitHubError(response) {
  try {
    const text = await response.text();
    const data = JSON.parse(text);

    return String(data.message ?? text).slice(0, 800);
  } catch {
    return '';
  }
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sdd-bug-sweep',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function githubRequest({ url, token, fetchImpl }) {
  const response = await fetchImpl(url, { headers: githubHeaders(token) });

  if (!response.ok) {
    throw new Error(`GitHub API failed (${response.status}): ${await readGitHubError(response)}`);
  }

  return response.json();
}

// Open GitHub issues can be selected directly. Pull requests are filtered out,
// and optional labels use GitHub's AND semantics.
export async function fetchGitHubBugs({
  repo,
  token = null,
  labels = [],
  state = DEFAULT_GITHUB_STATE,
  issues = [],
  limit = DEFAULT_FETCH_LIMIT,
  apiUrl = DEFAULT_GITHUB_API_URL,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('This Node.js version does not provide fetch. Use Node.js 18 or newer.');
  }

  const normalizedRepo = normalizeGitHubRepo(repo);

  if (!normalizedRepo) {
    throw new Error('A GitHub repository is required. Use owner/repo.');
  }

  const base = String(apiUrl || DEFAULT_GITHUB_API_URL).replace(/\/+$/, '');
  const issueKeys = Array.isArray(issues) ? issues : parseGitHubIssueKeys(issues);
  const numbers = issueKeys.map((key) => Number(GH_PATTERN_FOR_NUMBER(key)));

  if (numbers.length > 0) {
    const bugs = [];

    for (const number of numbers.slice(0, limit)) {
      const issue = await githubRequest({
        url: `${base}/repos/${normalizedRepo}/issues/${number}`,
        token,
        fetchImpl
      });

      if (!issue?.pull_request) {
        bugs.push(mapGitHubIssue(issue));
      }
    }

    return bugs;
  }

  const normalizedState = normalizeGitHubState(state);
  const labelFilter = (Array.isArray(labels) ? labels : parseCsv(labels)).filter(Boolean);
  const perPage = 100;
  const bugs = [];

  for (let page = 1; bugs.length < limit; page += 1) {
    const search = new URLSearchParams({
      state: normalizedState,
      sort: 'created',
      direction: 'asc',
      per_page: String(perPage),
      page: String(page)
    });

    if (labelFilter.length > 0) {
      search.set('labels', labelFilter.join(','));
    }

    const batch = await githubRequest({
      url: `${base}/repos/${normalizedRepo}/issues?${search.toString()}`,
      token,
      fetchImpl
    });
    const pageItems = Array.isArray(batch) ? batch : [];
    const issuesOnly = pageItems.filter((issue) => !issue.pull_request);

    bugs.push(...issuesOnly.map(mapGitHubIssue));

    if (pageItems.length < perPage) {
      break;
    }
  }

  return bugs.slice(0, limit);
}

function GH_PATTERN_FOR_NUMBER(key) {
  const match = GITHUB_KEY_PATTERN.exec(String(key).toUpperCase());

  if (!match) {
    throw new Error(`Invalid GitHub issue key "${key}".`);
  }

  return match[1];
}

export function describeGitHubQuery({ repo, labels = [], state = DEFAULT_GITHUB_STATE } = {}) {
  const labelFilter = (Array.isArray(labels) ? labels : parseCsv(labels)).filter(Boolean);
  const bits = [`${normalizeGitHubRepo(repo)}`, `${normalizeGitHubState(state)} issues`];

  if (labelFilter.length > 0) {
    bits.push(`labels ${labelFilter.join(', ')}`);
  }

  return bits.join(' · ');
}

export async function probeGitHub({
  repo,
  token = null,
  apiUrl = DEFAULT_GITHUB_API_URL,
  fetchImpl = globalThis.fetch
} = {}) {
  const normalizedRepo = normalizeGitHubRepo(repo);

  if (!normalizedRepo) {
    return { ok: false, error: 'A GitHub repository is required. Use owner/repo.' };
  }

  const base = String(apiUrl || DEFAULT_GITHUB_API_URL).replace(/\/+$/, '');

  try {
    const data = await githubRequest({
      url: `${base}/repos/${normalizedRepo}`,
      token,
      fetchImpl
    });

    return {
      ok: true,
      repo: data.full_name ?? normalizedRepo,
      private: data.private === true,
      url: data.html_url ?? `https://github.com/${normalizedRepo}`
    };
  } catch (error) {
    return { ok: false, repo: normalizedRepo, error: error.message };
  }
}

const DURATION_UNITS = {
  s: 1000,
  m: 60000,
  h: 3600000,
  d: 86400000
};

export function parseClockTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());

  if (!match) {
    throw new Error(`Invalid --at "${value}". Expected HH:MM in 24-hour local time, e.g. 00:00.`);
  }

  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

export function parseDuration(value) {
  const match = /^(\d+)(s|m|h|d)$/.exec(String(value ?? '').trim());

  if (!match) {
    throw new Error(`Invalid --every "${value}". Expected a duration like 30m, 2h, or 1d.`);
  }

  return Number(match[1]) * DURATION_UNITS[match[2]];
}

export function nextOccurrence(clock, from = new Date()) {
  const next = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate(),
    clock.hours,
    clock.minutes,
    0,
    0
  );

  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

export function formatDelay(milliseconds) {
  const totalMinutes = Math.max(1, Math.round(milliseconds / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }

  return parts.join(' ') || '0m';
}

function formatLocalTime(date) {
  const pad = (value) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseScheduleArgs(argv) {
  const rest = [];
  let at = null;
  let every = null;
  let runNow = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsIndex = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : token.slice(equalsIndex + 1);

    if (name === '--at' || name === '--every') {
      const value = inlineValue ?? argv[index + 1];

      if (value === undefined || (inlineValue === null && value.startsWith('--'))) {
        throw new Error(`Missing value for ${name}.`);
      }

      if (inlineValue === null) {
        index += 1;
      }

      if (name === '--at') {
        at = value;
      } else {
        every = value;
      }
      continue;
    }

    if (name === '--run-now' && inlineValue === null) {
      runNow = true;
      continue;
    }

    rest.push(token);
  }

  return { at, every, runNow, rest };
}

export function tokenizeCommand(template) {
  const tokens = [];
  let current = '';
  let quote = null;
  let hasToken = false;

  for (let index = 0; index < template.length; index += 1) {
    const character = template[index];

    if (quote) {
      if (character === quote) {
        quote = null;
        continue;
      }
      // Only an escaped double quote is special. Windows paths keep their backslashes.
      if (character === '\\' && quote === '"' && template[index + 1] === '"') {
        current += '"';
        index += 1;
        hasToken = true;
        continue;
      }
      current += character;
      hasToken = true;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      hasToken = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    current += character;
    hasToken = true;
  }

  if (quote) {
    throw new Error('Unterminated quote in --agent-cmd.');
  }

  if (hasToken) {
    tokens.push(current);
  }

  return tokens;
}

export function normalizeAgentCommand(value) {
  const text = String(value ?? '').trim();

  if (!text) {
    throw new Error('--agent-cmd is required.');
  }

  if (text.startsWith('[')) {
    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`--agent-cmd is not valid JSON: ${error.message}`);
    }

    if (
      !Array.isArray(parsed)
      || parsed.length === 0
      || parsed.some((entry) => typeof entry !== 'string' || entry.length === 0)
    ) {
      throw new Error('--agent-cmd JSON form must be a non-empty array of strings.');
    }

    return { kind: 'argv', argv: parsed };
  }

  const tokens = tokenizeCommand(text);

  if (tokens.length === 0) {
    throw new Error('--agent-cmd is empty.');
  }

  return { kind: 'argv', argv: tokens };
}

export function parseBugSweepArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }

  const raw = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}". Use --help for usage.`);
    }

    const equalsIndex = token.indexOf('=');
    const name = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : token.slice(equalsIndex + 1);

    if (VALUE_FLAGS.has(name)) {
      const value = inlineValue ?? argv[index + 1];

      if (value === undefined || (inlineValue === null && value.startsWith('--'))) {
        throw new Error(`Missing value for ${name}.`);
      }

      if (inlineValue === null) {
        index += 1;
      }

      raw[name] = value;
      continue;
    }

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== null) {
        throw new Error(`${name} does not take a value.`);
      }

      raw[name] = true;
      continue;
    }

    throw new Error(`Unknown option ${name}. Use --help for usage.`);
  }

  const date = raw['--date'] ?? localDate();
  validateDate(date);

  const source = normalizeBugSource(
    raw['--source'] ?? (raw['--github-repo'] ? 'github' : raw['--gitlab-project'] ? 'gitlab' : 'jira')
  );
  const jql = source === 'jira' ? raw['--jql'] ?? null : null;
  const projectFromJql = jql
    ? /project\s*=\s*"?([A-Za-z][A-Za-z0-9_]*)"?/i.exec(jql)?.[1] ?? null
    : null;
  let project = source === 'jira' ? raw['--project'] ?? projectFromJql ?? null : null;
  const githubRepo = source === 'github'
    ? normalizeGitHubRepo(raw['--github-repo'] ?? process.env.GITHUB_REPOSITORY ?? null)
    : null;
  const gitlabProject = source === 'gitlab'
    ? normalizeGitLabProject(raw['--gitlab-project'] ?? null)
    : null;
  const issues = source === 'github'
    ? parseGitHubIssueKeys(raw['--issues'])
    : source === 'gitlab'
      ? parseGitLabIssueKeys(raw['--issues'])
      : parseIssueKeys(raw['--issues']);

  if (source === 'github') {
    if (!githubRepo) {
      throw new Error('--github-repo is required for --source github (or set GITHUB_REPOSITORY).');
    }

    project = githubRepo;
  } else if (source === 'gitlab') {
    if (!gitlabProject) {
      throw new Error('--gitlab-project is required for --source gitlab.');
    }

    project = gitlabProject.project;
  } else if (!project && !jql && issues.length === 0) {
    throw new Error('Either --project, --jql, or --issues is required.');
  }

  const branch = raw['--branch'] ?? `bug-fix/${date}`;
  const tag = raw['--tag'] ?? `bug-fix-${date}`;

  validateGitName(branch, '--branch');
  validateGitName(tag, '--tag');

  return {
    help: false,
    source,
    project: project ?? 'JIRA',
    jql,
    issues,
    githubRepo,
    gitlabProject,
    githubToken: source === 'github'
      ? raw['--github-token'] ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null
      : null,
    githubLabels: source === 'github' ? parseCsv(raw['--github-label']) : [],
    githubState: source === 'github' ? normalizeGitHubState(raw['--github-state']) : DEFAULT_GITHUB_STATE,
    githubApiUrl: source === 'github'
      ? raw['--github-api-url'] ?? process.env.GITHUB_API_URL ?? DEFAULT_GITHUB_API_URL
      : null,
    date,
    base: raw['--base'] ?? null,
    branch,
    tag,
    agentCommand: normalizeAgentCommand(raw['--agent-cmd'] ?? DEFAULT_AGENT_COMMAND),
    verifyCommand: raw['--verify-cmd'] ?? null,
    maxTurns: positiveInteger(raw['--max-turns'] ?? DEFAULT_MAX_TURNS, '--max-turns'),
    limit: positiveInteger(raw['--limit'] ?? DEFAULT_LIMIT, '--limit'),
    timeoutSeconds: positiveInteger(raw['--timeout'] ?? DEFAULT_TIMEOUT_SECONDS, '--timeout'),
    workDir: raw['--work-dir'] ?? DEFAULT_WORK_DIR,
    remote: raw['--remote'] ?? 'origin',
    jiraUrl: raw['--jira-url'] ?? process.env.JIRA_BASE_URL ?? null,
    jiraEmail: raw['--jira-email'] ?? process.env.JIRA_EMAIL ?? null,
    jiraToken: raw['--jira-token'] ?? process.env.JIRA_API_TOKEN ?? null,
    jiraAuth: raw['--jira-auth'] ?? process.env.JIRA_AUTH ?? 'auto',
    jiraApiVersion: raw['--jira-api-version'] ?? process.env.JIRA_API_VERSION ?? 'auto',
    jiraCa: raw['--jira-ca'] ?? process.env.JIRA_CA_CERT ?? null,
    jiraInsecure: Boolean(raw['--jira-insecure']) || process.env.JIRA_INSECURE === '1',
    prCommand: raw['--pr-cmd'] ?? process.env.SDD_PR_CMD ?? null,
    extraFields: source === 'jira' ? parseCsv(raw['--extra-fields']) : [],
    resume: Boolean(raw['--resume']),
    retryFailed: Boolean(raw['--retry-failed']),
    worktree: Boolean(raw['--worktree']),
    fetchBase: Boolean(raw['--fetch-base']),
    gitlabPush: Boolean(raw['--gitlab-push']),
    dryRun: Boolean(raw['--dry-run']),
    push: !raw['--no-push'],
    pr: !raw['--no-pr'],
    verbose: Boolean(raw['--verbose'])
  };
}

export function buildResumeJql(jql, excludedKeys) {
  if (!Array.isArray(excludedKeys) || excludedKeys.length === 0) {
    return jql;
  }

  // ORDER BY belongs at the very end of the query, so keep it outside the
  // parenthesized filter instead of producing "(... ORDER BY ...) AND ...".
  const order = /\s+ORDER\s+BY\s+[\s\S]+$/i.exec(jql);
  const filter = order ? jql.slice(0, order.index) : jql;
  const suffix = order ? order[0] : '';

  return `(${filter}) AND key NOT IN (${excludedKeys.join(', ')})${suffix}`;
}

export function buildJql({ project, jql, issues }) {
  if (Array.isArray(issues) && issues.length > 0) {
    return `key IN (${issues.join(', ')}) ORDER BY priority DESC, key ASC`;
  }

  if (jql && jql.trim()) {
    return jql.trim();
  }

  if (!project) {
    throw new Error('Either --project, --jql, or --issues is required.');
  }

  return `project = "${project.replace(/"/g, '\\"')}" AND issuetype = Bug AND statusCategory != Done ORDER BY priority DESC, key ASC`;
}

export function flattenAdf(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(flattenAdf).join('');
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  const parts = [];

  if (value.type === 'text' && typeof value.text === 'string') {
    parts.push(value.text);
  }
  if (value.type === 'hardBreak') {
    parts.push('\n');
  }
  if (value.type === 'mention') {
    parts.push(value.attrs?.text ?? '');
  }
  if (value.type === 'inlineCard') {
    parts.push(value.attrs?.url ?? '');
  }

  if (Array.isArray(value.content)) {
    parts.push(value.content.map(flattenAdf).join(''));

    if (['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'panel'].includes(value.type)) {
      parts.push('\n');
    }
    if (['bulletList', 'orderedList'].includes(value.type)) {
      parts.push('\n');
    }
  }

  return parts.join('');
}

function normalizeAdfText(value) {
  return flattenAdf(value).replace(/\n{3,}/g, '\n\n').trim();
}

function mapJiraIssue(issue, { baseUrl, extraFields }) {
  const fields = issue.fields ?? {};
  const extra = {};

  for (const field of extraFields) {
    if (fields[field] !== undefined && fields[field] !== null) {
      extra[field] = normalizeAdfText(fields[field]);
    }
  }

  return {
    key: issue.key,
    id: issue.id ?? null,
    summary: fields.summary ?? '',
    description: normalizeAdfText(fields.description),
    priority: fields.priority?.name ?? '',
    jiraStatus: fields.status?.name ?? '',
    statusLabel: fields.status?.name ?? '',
    jiraType: fields.issuetype?.name ?? '',
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    url: `${baseUrl}/browse/${issue.key}`,
    source: 'jira',
    tracker: 'Jira',
    extraFields: extra
  };
}

async function readJiraError(response) {
  try {
    return (await response.text()).slice(0, 800);
  } catch {
    return '';
  }
}

export async function fetchJiraBugs({
  baseUrl,
  auth = 'auto',
  email = null,
  token,
  apiVersion = 'auto',
  jql,
  limit,
  fields = DEFAULT_JIRA_FIELDS,
  extraFields = [],
  fetchImpl = globalThis.fetch
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('This Node.js version does not provide fetch. Use Node.js 18 or newer.');
  }

  const version = normalizeJiraApiVersion(apiVersion);
  const headers = {
    Authorization: buildJiraAuthHeader({ auth, email, token }),
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };

  // Data Center and Server deployments only expose the v2 search endpoint.
  if (version === '2') {
    return fetchJiraBugsV2({ baseUrl, headers, jql, limit, fields, extraFields, fetchImpl });
  }

  const pageSize = Math.min(50, limit);
  const issues = [];
  let nextPageToken = null;
  let firstRequest = true;

  for (;;) {
    const body = {
      jql,
      maxResults: Math.max(1, Math.min(pageSize, limit - issues.length)),
      fields
    };

    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const response = await fetchImpl(`${baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (firstRequest && version === 'auto' && (response.status === 404 || response.status === 405)) {
      return fetchJiraBugsV2({ baseUrl, headers, jql, limit, fields, extraFields, fetchImpl });
    }

    if (!response.ok) {
      throw new Error(`Jira search failed (${response.status}): ${await readJiraError(response)}`);
    }

    const data = await response.json();
    const page = Array.isArray(data.issues) ? data.issues : [];

    issues.push(...page);
    firstRequest = false;

    if (issues.length >= limit || page.length === 0 || !data.nextPageToken || data.isLast) {
      break;
    }

    nextPageToken = data.nextPageToken;
  }

  return issues.slice(0, limit).map((issue) => mapJiraIssue(issue, { baseUrl, extraFields }));
}

async function fetchJiraBugsV2({ baseUrl, headers, jql, limit, fields, extraFields, fetchImpl }) {
  const pageSize = Math.min(50, limit);
  const issues = [];
  let startAt = 0;

  for (;;) {
    const response = await fetchImpl(`${baseUrl}/rest/api/2/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jql,
        startAt,
        maxResults: Math.max(1, Math.min(pageSize, limit - issues.length)),
        fields
      })
    });

    if (!response.ok) {
      throw new Error(`Jira search failed (${response.status}): ${await readJiraError(response)}`);
    }

    const data = await response.json();
    const page = Array.isArray(data.issues) ? data.issues : [];

    issues.push(...page);
    startAt += page.length;

    if (issues.length >= limit || page.length === 0 || startAt >= (data.total ?? 0)) {
      break;
    }
  }

  return issues.slice(0, limit).map((issue) => mapJiraIssue(issue, { baseUrl, extraFields }));
}

export function validateBugResult(raw, { key }) {
  const errors = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Result must be a JSON object.'], value: null };
  }

  const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

  if (!nonEmpty(raw.key)) {
    errors.push('key is required.');
  } else if (raw.key !== key) {
    errors.push(`key must be "${key}".`);
  }

  if (!['fixed', 'not-fixed'].includes(raw.status)) {
    errors.push('status must be "fixed" or "not-fixed".');
  }

  if (raw.status === 'fixed') {
    if (!nonEmpty(raw.summary)) {
      errors.push('summary is required when status is "fixed".');
    }
    if (!nonEmpty(raw.how)) {
      errors.push('how is required when status is "fixed".');
    }
  }

  if (raw.status === 'not-fixed' && !nonEmpty(raw.reason)) {
    errors.push('reason is required when status is "not-fixed".');
  }

  if (raw.critical === true && !nonEmpty(raw.criticalReason)) {
    errors.push('criticalReason is required when critical is true.');
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      key,
      status: raw.status,
      summary: nonEmpty(raw.summary) ? raw.summary.trim() : '',
      how: nonEmpty(raw.how) ? raw.how.trim() : '',
      reason: nonEmpty(raw.reason) ? raw.reason.trim() : '',
      critical: raw.critical === true,
      criticalReason: nonEmpty(raw.criticalReason) ? raw.criticalReason.trim() : '',
      evidence: Array.isArray(raw.evidence) ? raw.evidence.filter(nonEmpty).map((entry) => entry.trim()) : []
    }
  };
}

export function assessCritical({ result, files }) {
  const reasons = [];

  if (result.critical) {
    reasons.push(result.criticalReason || 'The agent marked this change as critical.');
  }

  for (const file of files) {
    const normalized = String(file).replace(/\\/g, '/');

    for (const { pattern, label } of CRITICAL_PATH_PATTERNS) {
      if (pattern.test(normalized)) {
        reasons.push(`Touches ${label} (${normalized}).`);
        break;
      }
    }
  }

  if (files.length > 30) {
    reasons.push(`Large change: ${files.length} files touched.`);
  }

  const unique = [...new Set(reasons)];

  return {
    critical: unique.length > 0,
    reason: unique.join(' ')
  };
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(value, maxLength) {
  const text = oneLine(value);

  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function escapeTableCell(value) {
  return oneLine(value).replace(/\|/g, '\\|');
}

export function buildCommitMessage({ key, summary, how, url, source = 'jira' }) {
  const title = `fix(${key}): ${truncate(summary, 90)}`;
  const tracker = source === 'github' ? 'GitHub issue' : source === 'gitlab' ? 'GitLab issue' : 'Jira';

  return {
    title,
    body: [how.trim(), '', url ? `${tracker}: ${url}` : ''].filter(Boolean).join('\n')
  };
}

export function renderBugPrompt({ bug, maxTurns, resultFile }) {
  const tracker = bug.source === 'github' ? 'GitHub' : bug.source === 'gitlab' ? 'GitLab' : 'Jira';
  const status = bug.statusLabel ?? bug.jiraStatus ?? 'unknown';
  const lines = [
    '# Bug fix task',
    '',
    `You are fixing exactly one ${tracker} bug as part of an automated sweep.`,
    `Work only on this bug. Do not commit, do not push, and do not change the ${tracker} issue.`,
    'The orchestrator owns git history and the pull request.',
    '',
    '## Bug',
    '',
    `- Key: ${bug.key}`,
    `- Summary: ${bug.summary}`,
    `- Priority: ${bug.priority || 'unknown'}`,
    `- Status: ${status}`,
    `- URL: ${bug.url}`
  ];

  if (bug.labels?.length) {
    lines.push(`- Labels: ${bug.labels.join(', ')}`);
  }

  lines.push('', '## Description', '', bug.description || '(no description)');

  if (bug.extraFields && Object.keys(bug.extraFields).length > 0) {
    lines.push('', '## Additional Jira fields', '');

    for (const [field, value] of Object.entries(bug.extraFields)) {
      lines.push(`- ${field}: ${value}`);
    }
  }

  lines.push(
    '',
    '## Task',
    '',
    '1. Reproduce the bug before changing code.',
    '2. Identify the root cause.',
    '3. Apply the smallest effective fix.',
    '4. Verify the fix with tests or the real code path.',
    '5. Do not weaken, skip, or delete tests.',
    '6. Do not touch unrelated files and do not reformat the repository.',
    '',
    `Use max_turns=${maxTurns} for this bug-fix run.`,
    'If the skill describes a different final report format, this task file wins for this run.',
    'If the bug cannot be reproduced or verified, stop and report it as not fixed.',
    '',
    '## Result contract',
    '',
    `Write exactly one JSON object to this file: ${resultFile}`,
    '',
    '```json',
    '{',
    `  "key": "${bug.key}",`,
    '  "status": "fixed",',
    '  "summary": "One line describing the change",',
    '  "how": "Short explanation of the root cause and the fix",',
    '  "critical": false,',
    '  "criticalReason": "",',
    '  "evidence": ["command or manual verification"]',
    '}',
    '```',
    '',
    'Rules:',
    '',
    '- `status` is `"fixed"` or `"not-fixed"`.',
    '- For `"not-fixed"`, replace `summary` and `how` with `reason` and keep evidence.',
    '- Use `"fixed"` only when verification passed and the working tree contains the fix.',
    '- Set `critical` to `true` when the change affects authentication, authorization,',
    '  security, payments, data migrations, infrastructure, CI/CD, or when you are unsure',
    '  about production behavior. `criticalReason` is required when `critical` is true.',
    '- Do not wrap the JSON in Markdown and do not write anything after it.',
    ''
  );

  return lines.join('\n');
}

export function buildAgentInvocation(command, { prompt, promptFile }) {
  const tokens = [...command.argv];
  let replaced = false;

  const next = tokens.map((token) => {
    let value = token;

    if (value.includes('{promptFile}')) {
      value = value.replaceAll('{promptFile}', promptFile);
      replaced = true;
    }
    if (value.includes('{prompt}')) {
      value = value.replaceAll('{prompt}', prompt);
      replaced = true;
    }

    return value;
  });

  if (!replaced) {
    next.push(prompt);
  }

  if (next.length === 0) {
    throw new Error('--agent-cmd produced an empty command.');
  }

  return { command: next[0], args: next.slice(1) };
}

export function buildSpawnSpec(invocation, platform = process.platform) {
  // npm-installed CLIs are .cmd shims on Windows, and those need cmd.exe.
  if (platform === 'win32') {
    // Native executables can be spawned directly. This also lets preset agents
    // use an absolute path when their install directory is missing from PATH.
    if (/\.exe$/i.test(invocation.command)) {
      return { command: invocation.command, args: invocation.args };
    }

    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', invocation.command, ...invocation.args]
    };
  }

  return { command: invocation.command, args: invocation.args };
}

function terminateProcess(child) {
  if (!child || child.killed) {
    return;
  }

  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // The process may already be gone.
  }
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: options.shell ?? false,
        windowsHide: true,
        stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = options.signal?.aborted === true;
    const timer = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        terminateProcess(child);
      }, options.timeoutMs)
      : null;
    const onAbort = () => {
      aborted = true;
      terminateProcess(child);
    };

    if (options.signal) {
      if (aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener?.('abort', onAbort);
    };

    const onClose = (code) => {
      cleanup();
      resolve({ code: code ?? 1, stdout, stderr, timedOut, aborted });
    };

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', onClose);
  });
}

async function git(cwd, args, options = {}) {
  const result = await runProcess('git', args, {
    cwd,
    timeoutMs: options.timeoutMs ?? 120000
  });

  if (!options.allowFailure && result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`git ${args.join(' ')} failed (${result.code})${detail ? `: ${detail}` : ''}`);
  }

  return result;
}

async function refExists(cwd, ref) {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true });

  return result.code === 0;
}

async function ensureGitRepository(cwd) {
  const result = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });

  if (result.code !== 0 || result.stdout.trim() !== 'true') {
    throw new Error(`${cwd} is not a git working tree.`);
  }
}

async function ensureCleanWorktree(cwd) {
  const result = await git(cwd, ['status', '--porcelain']);

  if (result.stdout.trim()) {
    throw new Error('The working tree is not clean. Commit or stash your changes before running a bug sweep.');
  }
}

async function resolveBaseRef(cwd, base) {
  if (base !== 'HEAD') {
    return base;
  }

  const current = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });

  return current.code === 0 && current.stdout.trim() ? current.stdout.trim() : 'HEAD';
}

async function detectBaseBranch(cwd) {
  const remoteHead = await git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFailure: true });

  if (remoteHead.code === 0) {
    return remoteHead.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  }

  for (const candidate of ['main', 'master']) {
    if (await refExists(cwd, `refs/heads/${candidate}`)) {
      return candidate;
    }
  }

  return 'HEAD';
}

// "origin/main" and "main" name the same branch; the shared name is what the PR
// base and tag messages use.
function stripRemotePrefix(base, remote = 'origin') {
  const prefix = `${remote}/`;

  return base.startsWith(prefix) ? base.slice(prefix.length) : base;
}

// Prefer the remote-tracking ref so a sweep starts from the branch as it exists
// on the remote. --fetch-base refreshes that ref first; fetching is best effort,
// so an offline run still falls back to whatever refs are already present.
export async function resolveRemoteBase(cwd, base, { remote = 'origin', fetchBase = false, logger = () => {} } = {}) {
  const name = stripRemotePrefix(base, remote);

  if (!name || name === 'HEAD') {
    return base;
  }

  if (fetchBase) {
    const fetched = await git(cwd, ['fetch', remote, name], { allowFailure: true });

    if (fetched.code !== 0) {
      logger(`Could not fetch ${name} from ${remote}; using the refs already on disk.`);
    }
  }

  const remoteRef = `${remote}/${name}`;

  return (await refExists(cwd, `refs/remotes/${remoteRef}`)) ? remoteRef : name;
}

async function changedFiles(cwd) {
  const tracked = await git(cwd, ['diff', '--name-only', 'HEAD']);
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);

  return [...new Set(
    `${tracked.stdout}\n${untracked.stdout}`
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  )];
}

async function resetWorktree(cwd) {
  await git(cwd, ['reset', '--hard', 'HEAD']);
  await git(cwd, ['clean', '-fd']);
}

export function prepareWorkDir(workDir) {
  fs.mkdirSync(workDir, { recursive: true });

  const ignorePath = path.join(workDir, '.gitignore');

  if (!fs.existsSync(ignorePath)) {
    // The sweep directory is state, not part of the fix. Everything in it is ignored.
    fs.writeFileSync(ignorePath, '*\n', 'utf8');
  }
}

function worktreeSlug(branch) {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
}

async function registeredWorktrees(cwd) {
  const result = await git(cwd, ['worktree', 'list', '--porcelain'], { allowFailure: true });

  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length).trim()));
}

// Fix bugs in a separate checkout so the user's own working tree is never touched.
// The branch is created in the new worktree and shared through the same .git store,
// so commits, tags, and pushes work exactly as they do in place.
async function prepareGitWorktree({ repoRoot, workDir, options, baseRef, logger }) {
  const target = path.join(workDir, 'worktrees', worktreeSlug(options.branch));
  const known = await registeredWorktrees(repoRoot);
  const branchExists = await refExists(repoRoot, `refs/heads/${options.branch}`);

  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (branchExists) {
    if (!options.resume) {
      throw new Error(`Branch ${options.branch} already exists. Use --resume, choose another --branch, or remove the old worktree.`);
    }

    if (!known.includes(path.resolve(target))) {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      await git(repoRoot, ['worktree', 'add', target, options.branch]);
    }
  } else {
    if (options.resume) {
      throw new Error(`--resume was requested but branch ${options.branch} does not exist.`);
    }

    if (!(await refExists(repoRoot, baseRef))) {
      throw new Error(`Base ref ${baseRef} does not exist.`);
    }

    if (known.includes(path.resolve(target))) {
      await git(repoRoot, ['worktree', 'remove', '--force', target], { allowFailure: true });
    } else if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }

    await git(repoRoot, ['worktree', 'add', '-b', options.branch, target, baseRef]);
  }

  logger(`Using an isolated worktree at ${target}.`);

  return target;
}

async function removeGitWorktree(repoRoot, target, logger) {
  if (!target) {
    return;
  }

  const result = await git(repoRoot, ['worktree', 'remove', '--force', target], { allowFailure: true });

  if (result.code === 0) {
    logger(`Removed the worktree at ${target}.`);
  }

  await git(repoRoot, ['worktree', 'prune'], { allowFailure: true });
}

let activeLockPath = null;

function releaseLock() {
  if (activeLockPath) {
    try {
      fs.rmSync(activeLockPath, { force: true });
    } catch {
      // The lock may already be gone.
    }
    activeLockPath = null;
  }
}

// A scheduled sweep must never overlap with a running one. The lock lives in the
// ignored work directory and records the owning process.
process.once('exit', releaseLock);

function acquireLock(workDir, now) {
  const lockPath = path.join(workDir, '.lock');

  if (fs.existsSync(lockPath)) {
    let lock = null;

    try {
      lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      lock = null;
    }

    const ownedByAnotherProcess = lock
      && lock.pid !== process.pid
      && Number.isInteger(lock.pid)
      && isProcessAlive(lock.pid);

    if (ownedByAnotherProcess) {
      throw new Error(`Another bug sweep is already running (pid ${lock.pid}, started ${lock.startedAt}). Wait for it or remove ${lockPath} if it is stale.`);
    }
  }

  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: now().toISOString() })}\n`, 'utf8');
  activeLockPath = lockPath;

  return lockPath;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this user cannot signal it.
    return error.code === 'EPERM';
  }
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeState(statePath, state, now) {
  state.updatedAt = now().toISOString();

  const temporaryPath = `${statePath}.tmp`;

  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, statePath);
}

function mergeBugs(state, fetchedBugs, { retryFailed }) {
  const existingByKey = new Map(state.bugs.map((bug) => [bug.key, bug]));
  const merged = [];

  for (const bug of fetchedBugs) {
    const existing = existingByKey.get(bug.key);
    existingByKey.delete(bug.key);

    if (!existing) {
      merged.push({ ...bug, status: 'pending' });
      continue;
    }

    const next = {
      ...existing,
      summary: bug.summary,
      description: bug.description,
      priority: bug.priority,
      jiraStatus: bug.jiraStatus,
      statusLabel: bug.statusLabel,
      labels: bug.labels,
      url: bug.url,
      source: bug.source ?? existing.source,
      tracker: bug.tracker ?? existing.tracker,
      number: bug.number ?? existing.number,
      extraFields: bug.extraFields
    };

    if (retryFailed && next.status === 'not-fixed') {
      next.status = 'pending';
      next.reason = '';
    }

    merged.push(next);
  }

  // Bugs that a resumed run no longer returns from Jira stay in the report.
  for (const leftover of existingByKey.values()) {
    merged.push(leftover);
  }

  state.bugs = merged;
}

function markNotFixed(bug, message, result = {}) {
  bug.status = 'not-fixed';
  bug.reason = message;
  bug.fixSummary = result.summary ?? '';
  bug.how = result.how ?? '';
  bug.critical = result.critical === true;
  bug.criticalReason = result.criticalReason ?? '';
  bug.evidence = result.evidence ?? [];
}

export function renderPrBody({ project, date, branch, tag, bugs }) {
  const fixed = bugs.filter((bug) => bug.status === 'fixed');
  const notFixed = bugs.filter((bug) => bug.status === 'not-fixed');
  const critical = fixed.filter((bug) => bug.critical);
  const tracker = bugs[0]?.tracker ?? 'Jira';
  const lines = [
    `## Bug Fix Sweep — ${date}`,
    '',
    `${tracker} ${project} · ${bugs.length} bugs · ${fixed.length} fixed · ${notFixed.length} not fixed`,
    '',
    '| Bug | Status | What / How | Human review |',
    '|---|---|---|---|'
  ];

  for (const bug of bugs) {
    const link = bug.url ? `[${bug.key}](${bug.url})` : bug.key;
    const status = bug.status === 'fixed' ? '✅ Fixed' : '❌ Not fixed';
    const what = bug.status === 'fixed'
      ? truncate(`${bug.fixSummary || bug.summary} — ${bug.how}`, 180)
      : truncate(bug.reason, 180);
    const review = bug.critical
      ? `⚠️ Yes — ${escapeTableCell(bug.criticalReason)}`
      : '—';

    lines.push(`| ${link} | ${status} | ${escapeTableCell(what)} | ${escapeTableCell(review)} |`);
  }

  if (critical.length > 0) {
    lines.push('', '### Human review required');

    for (const bug of critical) {
      lines.push(`- **${bug.key}** — ${oneLine(bug.criticalReason)}`);
    }
  }

  if (notFixed.length > 0) {
    lines.push('', '### Not fixed');

    for (const bug of notFixed) {
      lines.push(`- **${bug.key}** — ${oneLine(bug.reason)}`);
    }
  }

  lines.push('', `Branch: \`${branch}\` · Tag: \`${tag}\``);

  return `${lines.join('\n')}\n`;
}

export function formatSweepSummary(state, { prUrl = null, pushed = false } = {}) {
  const fixed = state.bugs.filter((bug) => bug.status === 'fixed');
  const notFixed = state.bugs.filter((bug) => bug.status === 'not-fixed');
  const lines = [
    `Bug sweep ${state.date} — ${state.project}`,
    `Branch: ${state.branch}`,
    `Tag: ${state.tag}`,
    `Fixed: ${fixed.length}/${state.bugs.length}`
  ];

  for (const bug of state.bugs) {
    if (bug.status === 'fixed') {
      const review = bug.critical ? ` — HUMAN REVIEW: ${oneLine(bug.criticalReason)}` : '';
      lines.push(`  ✅ ${bug.key}  ${bug.commit ? bug.commit.slice(0, 7) : ''}  ${oneLine(bug.fixSummary || bug.summary)}${review}`);
    } else if (bug.status === 'not-fixed') {
      lines.push(`  ❌ ${bug.key}  Not fixed — ${oneLine(bug.reason)}`);
    } else {
      lines.push(`  ⏳ ${bug.key}  Pending`);
    }
  }

  if (prUrl) {
    lines.push(`PR: ${prUrl}`);
  } else if (!pushed) {
    lines.push('Not pushed; no pull request was created.');
  }

  return `${lines.join('\n')}\n`;
}

function formatDryRun({ project, date, jql, branch, tag, bugs, source = 'jira', githubRepo = null, githubLabels = [], githubState = DEFAULT_GITHUB_STATE }) {
  const query = source === 'github'
    ? describeGitHubQuery({ repo: githubRepo, labels: githubLabels, state: githubState })
    : source === 'gitlab' ? `${project} · open issues` : jql;
  const lines = [
    `Bug sweep plan — ${project} (${date})`,
    `${source === 'github' ? 'GitHub' : source === 'gitlab' ? 'GitLab' : 'JQL'}: ${query}`,
    `Branch: ${branch}`,
    `Tag: ${tag}`,
    `Bugs: ${bugs.length}`
  ];

  bugs.forEach((bug, index) => {
    const priority = bug.priority ? ` [${bug.priority}]` : '';
    lines.push(`  ${index + 1}. ${bug.key}${priority} ${bug.summary}`);
  });

  lines.push('', 'Dry run: git was not touched.');

  return `${lines.join('\n')}\n`;
}

export function normalizeJiraAuth(auth = 'auto', email = null) {
  const value = String(auth || 'auto').toLowerCase();

  if (value === 'basic' || value === 'bearer') {
    return value;
  }

  if (value !== 'auto') {
    throw new Error(`Invalid --jira-auth "${auth}". Use auto, basic, or bearer.`);
  }

  // Data Center personal access tokens carry no email, so bearer is the better guess.
  return email ? 'basic' : 'bearer';
}

export function normalizeJiraApiVersion(value = 'auto') {
  const normalized = String(value || 'auto').toLowerCase().replace(/^v/, '');

  if (normalized === 'auto' || normalized === '2' || normalized === '3') {
    return normalized;
  }

  throw new Error(`Invalid --jira-api-version "${value}". Use auto, 2, or 3.`);
}

export function buildJiraAuthHeader({ auth = 'auto', email = null, token = '' } = {}) {
  const mode = normalizeJiraAuth(auth, email);

  if (mode === 'basic') {
    return `Basic ${Buffer.from(`${email ?? ''}:${token}`).toString('base64')}`;
  }

  return `Bearer ${token}`;
}

function resolveJiraConfig(options = {}, env = process.env) {
  const baseUrl = options.jiraUrl ?? env.JIRA_BASE_URL ?? null;
  const email = options.jiraEmail ?? env.JIRA_EMAIL ?? null;
  const token = options.jiraToken ?? env.JIRA_API_TOKEN ?? null;
  const auth = normalizeJiraAuth(options.jiraAuth ?? env.JIRA_AUTH ?? 'auto', email);
  const apiVersion = normalizeJiraApiVersion(options.jiraApiVersion ?? env.JIRA_API_VERSION ?? 'auto');
  const ca = options.jiraCa ?? env.JIRA_CA_CERT ?? null;
  const insecure = Boolean(options.jiraInsecure) || env.JIRA_INSECURE === '1';

  if (!baseUrl) {
    throw new Error('Jira base URL is required. Set JIRA_BASE_URL or pass --jira-url.');
  }
  if (!token) {
    throw new Error('Jira credentials are required. Set JIRA_API_TOKEN or pass --jira-token.');
  }
  if (auth === 'basic' && !email) {
    throw new Error('Basic authentication needs an email. Set JIRA_EMAIL or pass --jira-email, or use --jira-auth bearer with a personal access token.');
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ''), auth, email, token, apiVersion, ca, insecure };
}

const JIRA_TLS_ERRORS = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID'
]);

export function describeJiraError(error) {
  const code = error?.code ?? '';

  if (JIRA_TLS_ERRORS.has(code)) {
    return {
      kind: 'tls',
      hint: 'The Jira certificate is not trusted. Pass --jira-ca /path/to/ca.pem (or JIRA_CA_CERT), or use --jira-insecure as a last resort.',
      code
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { kind: 'dns', hint: 'The Jira hostname could not be resolved. Check the URL and DNS in this network.', code };
  }
  if (code === 'ECONNREFUSED') {
    return { kind: 'connection', hint: 'The connection was refused. Check the port and that Jira accepts connections from this machine.', code };
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EPIPE') {
    return { kind: 'network', hint: 'The connection timed out or was reset. A firewall or proxy may be blocking it.', code };
  }

  return { kind: 'unknown', hint: error?.message ?? 'Unknown Jira error.', code };
}

export function describeJiraStatus(status) {
  if (status === 401) {
    return 'Jira rejected the credentials (401). Check the token, or switch --jira-auth between bearer and basic.';
  }
  if (status === 403) {
    return 'Jira refused the request (403). The account may lack permission for this project or for the REST API.';
  }
  if (status === 404) {
    return 'Jira returned 404. Check the base URL path; a reverse proxy may add or remove a prefix.';
  }
  if (status === 429) {
    return 'Jira rate-limited the request (429). Retry later.';
  }
  if (status >= 500) {
    return `Jira returned ${status}. The server is unhealthy or a proxy in front of it failed.`;
  }

  return `Jira returned ${status}.`;
}

// Jira calls go through node:https instead of fetch so an internal CA can be trusted
// per request, which global fetch cannot do at runtime.
export function createJiraFetch({ caPath = null, insecure = false, timeoutMs = 60000 } = {}) {
  let ca;

  if (caPath) {
    try {
      ca = fs.readFileSync(caPath, 'utf8');
    } catch (error) {
      throw new Error(`Could not read the Jira CA file "${caPath}": ${error.message}`);
    }
  }

  return async function jiraFetch(url, init = {}) {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const headers = { ...(init.headers ?? {}) };
    const body = init.body ?? null;

    if (body != null && headers['Content-Length'] === undefined) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    return new Promise((resolve, reject) => {
      const request = transport.request({
        method: init.method ?? 'GET',
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        headers,
        timeout: timeoutMs,
        ...(isHttps && insecure ? { rejectUnauthorized: false } : {}),
        ...(isHttps && ca ? { ca } : {})
      }, (response) => {
        const chunks = [];

        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');

          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            json: async () => {
              try {
                return JSON.parse(text || '{}');
              } catch {
                return {};
              }
            },
            text: async () => text
          });
        });
      });

      request.on('timeout', () => request.destroy(Object.assign(new Error('Jira request timed out.'), { code: 'ETIMEDOUT' })));
      request.on('error', reject);

      if (body != null) {
        request.write(body);
      }

      request.end();
    });
  };
}

export async function fetchJiraProjects({ baseUrl, headers, apiVersion = 'auto', limit = 100, fetchImpl = globalThis.fetch } = {}) {
  const version = normalizeJiraApiVersion(apiVersion);
  const root = baseUrl.replace(/\/+$/, '');

  if (version !== '2') {
    const v3 = await fetchImpl(`${root}/rest/api/3/project/search?maxResults=${limit}&orderBy=name`, { method: 'GET', headers });

    if (v3.ok) {
      const data = await v3.json();

      return (data.values ?? []).map((project) => ({ key: project.key, name: project.name }));
    }

    if (version === '3' || (v3.status !== 404 && v3.status !== 405)) {
      throw new Error(`Jira project list failed (${v3.status}): ${await readJiraError(v3)}`);
    }
  }

  const v2 = await fetchImpl(`${root}/rest/api/2/project?maxResults=${limit}`, { method: 'GET', headers });

  if (!v2.ok) {
    throw new Error(`Jira project list failed (${v2.status}): ${await readJiraError(v2)}`);
  }

  const data = await v2.json();
  const list = Array.isArray(data) ? data : data.values ?? [];

  return list.slice(0, limit).map((project) => ({ key: project.key, name: project.name }));
}

export async function probeJira({
  baseUrl,
  auth = 'auto',
  email = null,
  token = '',
  apiVersion = 'auto',
  ca = null,
  insecure = false,
  fetchImpl
} = {}) {
  const mode = normalizeJiraAuth(auth, email);
  const version = normalizeJiraApiVersion(apiVersion);
  const transport = fetchImpl ?? createJiraFetch({ caPath: ca, insecure });
  const root = baseUrl.replace(/\/+$/, '');
  const headers = {
    Authorization: buildJiraAuthHeader({ auth, email, token }),
    Accept: 'application/json'
  };
  const attempts = version === 'auto' ? ['3', '2'] : [version];

  for (const api of attempts) {
    let response;

    try {
      response = await transport(`${root}/rest/api/${api}/myself`, { method: 'GET', headers });
    } catch (error) {
      return { ok: false, auth: mode, apiVersion: api, error: describeJiraError(error) };
    }

    if (response.ok) {
      const user = await response.json();

      return {
        ok: true,
        auth: mode,
        apiVersion: api,
        user: { name: user.name ?? user.accountId ?? '', displayName: user.displayName ?? '' }
      };
    }

    if (version === 'auto' && api === '3' && (response.status === 404 || response.status === 405)) {
      continue;
    }

    return {
      ok: false,
      auth: mode,
      apiVersion: api,
      status: response.status,
      error: { kind: 'status', hint: describeJiraStatus(response.status) }
    };
  }

  return { ok: false, auth: mode, apiVersion: version, error: { kind: 'status', hint: 'Could not reach a Jira REST API version.' } };
}

async function ensureGhCli(cwd) {
  try {
    const result = await runProcess('gh', ['auth', 'status'], { cwd, timeoutMs: 30000 });

    if (result.code !== 0) {
      throw new Error((result.stderr || result.stdout).trim() || 'gh auth status failed.');
    }
  } catch (error) {
    throw new Error(`The GitHub CLI is required for --pr and must be authenticated: ${error.message}`);
  }
}

const PR_PLACEHOLDER = /\{(title|body|bodyFile|base|head|remote|project|date)\}/g;

function fillPrPlaceholders(value, context) {
  return value.replace(PR_PLACEHOLDER, (_, key) => context[key] ?? '');
}

// Runs a user-supplied forge CLI (glab, tea, a script) instead of gh. A plain
// command goes through the shell; a JSON argv runs without one, so the same
// preset works on Windows and POSIX. Both forms must print the merge request URL.
export async function openMergeRequest({ cwd, options, state, title, bodyFile, logger }) {
  const body = fs.readFileSync(bodyFile, 'utf8');
  const env = {
    ...process.env,
    SDD_PR_TITLE: title,
    SDD_PR_BODY: body,
    SDD_PR_BODY_FILE: bodyFile,
    SDD_PR_BASE: state.base,
    SDD_PR_HEAD: options.branch,
    SDD_PR_REMOTE: options.remote,
    SDD_PR_PROJECT: state.project,
    SDD_PR_DATE: state.date
  };
  const command = options.prCommand.trim();
  let result;

  if (command.startsWith('[')) {
    let argv;

    try {
      argv = JSON.parse(command);
    } catch (error) {
      throw new Error(`--pr-cmd is not valid JSON: ${error.message}`);
    }

    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((entry) => typeof entry === 'string')) {
      throw new Error('--pr-cmd JSON form must be a non-empty array of strings.');
    }

    const context = {
      title,
      body,
      bodyFile,
      base: state.base,
      head: options.branch,
      remote: options.remote,
      project: state.project,
      date: state.date
    };
    const [file, ...args] = argv.map((entry) => fillPrPlaceholders(entry, context));

    result = await runProcess(file, args, { cwd, timeoutMs: 120000, env });
  } else {
    result = await runProcess(options.prCommand, [], { cwd, shell: true, timeoutMs: 120000, env });
  }

  if (result.timedOut || result.code !== 0) {
    const output = truncate(result.stderr || result.stdout, 500);

    throw new Error(`--pr-cmd failed (${result.timedOut ? 'timeout' : `exit ${result.code}`})${output ? `: ${output}` : '.'}`);
  }

  const url = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? '';

  if (url) {
    logger(`Opened merge request ${url}.`);
  } else {
    logger('Ran --pr-cmd (no URL on stdout).');
  }

  return url || null;
}

async function processBug({
  bug,
  options,
  cwd,
  workDir,
  logger,
  spawnImpl,
  now,
  signal
}) {
  const key = bug.key;
  const promptFile = path.join(workDir, `${key}.prompt.md`);
  const resultFile = path.join(workDir, `${key}.result.json`);
  const logFile = path.join(workDir, `${key}.agent.log`);

  logger(`[${key}] ${bug.summary}`);
  fs.rmSync(resultFile, { force: true });
  fs.writeFileSync(promptFile, renderBugPrompt({ bug, maxTurns: options.maxTurns, resultFile }), 'utf8');

  const skillCall = buildNativeSkillCall('bug-fix', options.agentPreset, { max_turns: options.maxTurns });
  const shortPrompt = `${skillCall} Read the task file at \`${promptFile}\` and complete it. Write the result JSON to \`${resultFile}\`. Do not commit, push, or ask questions.`;
  const invocation = buildAgentInvocation(options.agentCommand, { prompt: shortPrompt, promptFile });
  const spec = buildSpawnSpec(invocation);
  const logStream = fs.createWriteStream(logFile, { flags: 'w' });
  const env = {
    ...process.env,
    SDD_BUG_KEY: key,
    SDD_BUG_RESULT_FILE: resultFile,
    SDD_BUG_PROMPT_FILE: promptFile,
    SDD_BUG_DATE: options.date
  };

  let agentRun;

  try {
    agentRun = await (spawnImpl ?? runProcess)(spec.command, spec.args, {
      cwd,
      env,
      signal,
      timeoutMs: options.timeoutSeconds * 1000,
      onStdout: (text) => {
        logStream.write(text);
        if (options.verbose) {
          process.stderr.write(text);
        }
      },
      onStderr: (text) => {
        logStream.write(text);
        if (options.verbose) {
          process.stderr.write(text);
        }
      }
    });
  } catch (error) {
    logStream.end();
    await resetWorktree(cwd);
    markNotFixed(bug, `Agent could not be started: ${error.message}`);
    bug.updatedAt = now().toISOString();
    logger(`[${key}] Not fixed: ${bug.reason}`);
    return;
  }

  await new Promise((resolve) => logStream.end(resolve));

  if (agentRun.aborted) {
    await resetWorktree(cwd);
    bug.status = 'pending';
    bug.reason = '';
    bug.updatedAt = now().toISOString();
    logger(`[${key}] Cancelled before finishing.`);
    return;
  }

  if (agentRun.timedOut) {
    await resetWorktree(cwd);
    markNotFixed(bug, `Agent timed out after ${options.timeoutSeconds} seconds.`);
    bug.updatedAt = now().toISOString();
    logger(`[${key}] Not fixed: ${bug.reason}`);
    return;
  }

  let rawResult;

  try {
    rawResult = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  } catch {
    rawResult = null;
  }

  const validation = validateBugResult(rawResult, { key });

  if (!validation.ok) {
    await resetWorktree(cwd);
    markNotFixed(bug, `Invalid or missing result: ${validation.errors.join(' ')}`);
    bug.updatedAt = now().toISOString();
    logger(`[${key}] Not fixed: ${bug.reason}`);
    return;
  }

  const result = validation.value;

  if (result.status === 'not-fixed') {
    await resetWorktree(cwd);
    markNotFixed(bug, result.reason || 'The agent reported the bug as not fixed.', result);
    bug.updatedAt = now().toISOString();
    logger(`[${key}] Not fixed: ${bug.reason}`);
    return;
  }

  const files = await changedFiles(cwd);

  if (files.length === 0) {
    await resetWorktree(cwd);
    markNotFixed(bug, 'The agent reported a fix but the working tree has no changes.', result);
    bug.updatedAt = now().toISOString();
    logger(`[${key}] Not fixed: ${bug.reason}`);
    return;
  }

  if (options.verifyCommand) {
    const verification = await runProcess(options.verifyCommand, [], {
      cwd,
      shell: true,
      signal,
      timeoutMs: options.timeoutSeconds * 1000
    });

    if (verification.timedOut || verification.code !== 0) {
      const output = truncate(verification.stderr || verification.stdout, 500);
      await resetWorktree(cwd);
      markNotFixed(
        bug,
        `Verification failed (${verification.timedOut ? 'timeout' : `exit ${verification.code}`})${output ? `: ${output}` : '.'}`,
        result
      );
      bug.updatedAt = now().toISOString();
      logger(`[${key}] Not fixed: ${bug.reason}`);
      return;
    }
  }

  const critical = assessCritical({ result, files });
  const commit = buildCommitMessage({
    key,
    summary: result.summary,
    how: result.how,
    url: bug.url,
    source: bug.source
  });

  try {
    await git(cwd, ['add', '-A']);
    await git(cwd, ['commit', '-m', commit.title, '-m', commit.body]);
  } catch (error) {
    await resetWorktree(cwd);
    markNotFixed(bug, `The fix could not be committed: ${error.message}`, result);
    bug.updatedAt = now().toISOString();
    logger(`[${key}] Not fixed: ${bug.reason}`);
    return;
  }

  const sha = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();

  bug.status = 'fixed';
  bug.commit = sha;
  bug.fixSummary = result.summary;
  bug.how = result.how;
  bug.reason = '';
  bug.critical = critical.critical;
  bug.criticalReason = critical.reason;
  bug.evidence = result.evidence;
  bug.updatedAt = now().toISOString();

  logger(`[${key}] Fixed in ${sha.slice(0, 7)}${critical.critical ? ` — human review required: ${critical.reason}` : ''}.`);
}

// GitLab accepts merge-request metadata as git push options, so a push can create
// the MR without gh/glab. Git must forward the options to a server that advertises
// push-options support.
export function buildBranchPushArgs({ options, state, title, body }) {
  const args = ['push', '-u', options.remote, options.branch];

  if (options.pr && options.gitlabPush) {
    args.push(
      '-o', 'merge_request.create',
      '-o', `merge_request.target=${state.base}`,
      '-o', `merge_request.title=${title}`,
      '-o', `merge_request.description=${body}`
    );
  }

  return args;
}

// GitLab prints the new MR URL in the "remote:" lines of the push output. Keep the
// report useful even when a server stays silent.
export function extractMergeRequestUrl(output) {
  const match = String(output).match(/https?:\/\/[^\s"'<>]+?\/merge_requests\/\d+/);

  return match ? match[0] : null;
}

async function publish({ cwd, options, state, workDir, logger }) {
  const fixed = state.bugs.filter((bug) => bug.status === 'fixed');

  if (fixed.length === 0) {
    return { pushed: false, prUrl: null };
  }

  if (!(await refExists(cwd, `refs/tags/${options.tag}`))) {
    await git(cwd, ['tag', '-a', options.tag, '-m', `Bug fix sweep ${state.date}`]);
    logger(`Created tag ${options.tag}.`);
  }

  if (!options.push) {
    return { pushed: false, prUrl: null };
  }

  const bodyFile = path.join(workDir, `pr-${options.date}.md`);
  const title = `fix: Jira bug sweep ${state.project} ${state.date} (${fixed.length} fixed)`;
  let body = null;

  if (options.pr) {
    body = renderPrBody({
      project: state.project,
      date: state.date,
      branch: state.branch,
      tag: state.tag,
      bugs: state.bugs
    });
    fs.writeFileSync(bodyFile, body, 'utf8');
  }

  const branchPush = await git(cwd, buildBranchPushArgs({ options, state, title, body }));

  await git(cwd, ['push', options.remote, options.tag]);
  logger(`Pushed ${options.branch} and ${options.tag}.`);

  if (!options.pr) {
    return { pushed: true, prUrl: null };
  }

  if (options.gitlabPush) {
    const mrUrl = extractMergeRequestUrl(`${branchPush.stdout}\n${branchPush.stderr}`);

    if (mrUrl) {
      logger(`Opened merge request ${mrUrl}.`);
    } else {
      logger('Pushed with GitLab merge request push options (no URL in the git output).');
    }

    return { pushed: true, prUrl: mrUrl };
  }

  // Air-gapped and self-hosted forges have no gh. A custom command (glab, tea, a
  // script) receives everything it needs through the environment.
  if (options.prCommand) {
    const mrUrl = await openMergeRequest({ cwd, options, state, title, bodyFile, logger });

    return { pushed: true, prUrl: mrUrl };
  }

  await ensureGhCli(cwd);

  const existing = await runProcess('gh', ['pr', 'view', options.branch, '--json', 'url', '--jq', '.url'], {
    cwd,
    timeoutMs: 60000
  });

  if (existing.code === 0 && existing.stdout.trim()) {
    const prUrl = existing.stdout.trim();
    const edited = await runProcess('gh', ['pr', 'edit', options.branch, '--body-file', bodyFile], {
      cwd,
      timeoutMs: 60000
    });

    if (edited.code !== 0) {
      throw new Error(`Could not update the pull request: ${(edited.stderr || edited.stdout).trim()}`);
    }

    logger(`Updated pull request ${prUrl}.`);
    return { pushed: true, prUrl };
  }

  const created = await runProcess('gh', [
    'pr',
    'create',
    '--base',
    state.base,
    '--head',
    options.branch,
    '--title',
    title,
    '--body-file',
    bodyFile
  ], { cwd, timeoutMs: 120000 });

  if (created.code !== 0) {
    throw new Error(`Could not create the pull request: ${(created.stderr || created.stdout).trim()}`);
  }

  const prUrl = created.stdout.trim();

  logger(`Opened pull request ${prUrl}.`);

  return { pushed: true, prUrl };
}

async function runScheduledSweep(schedule, dependencies = {}) {
  const logger = dependencies.logger ?? ((line) => process.stderr.write(`${line}\n`));
  const output = dependencies.output ?? ((text) => process.stdout.write(text));
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxRuns = dependencies.maxRuns ?? Infinity;
  const clock = schedule.at ? parseClockTime(schedule.at) : null;
  const intervalMs = schedule.every ? parseDuration(schedule.every) : null;
  const runImmediately = schedule.runNow || (clock === null && intervalMs !== null);
  let first = true;
  let runs = 0;

  for (;;) {
    if (!first || !runImmediately) {
      const target = clock
        ? nextOccurrence(clock, now())
        : new Date(now().getTime() + (intervalMs ?? 0));
      const waitMs = target.getTime() - now().getTime();

      if (waitMs > 0) {
        logger(`Next bug sweep at ${formatLocalTime(target)} (in ${formatDelay(waitMs)}).`);
        await sleep(waitMs);
      }
    }

    first = false;

    try {
      const summary = await runSingleSweep(schedule.rest, dependencies);

      output(`${summary}\n`);
    } catch (error) {
      logger(`Bug sweep failed: ${error.message}`);

      if (intervalMs === null) {
        throw error;
      }
    } finally {
      releaseLock();
    }

    runs += 1;

    if (intervalMs === null || runs >= maxRuns) {
      return '';
    }
  }
}

export async function runBugSweep(argv, dependencies = {}) {
  const schedule = parseScheduleArgs(argv);

  if (schedule.at !== null || schedule.every !== null) {
    // Validate the sweep arguments before waiting hours for a bad command to fail.
    const preflight = parseBugSweepArgs(schedule.rest);

    if (preflight.help) {
      return formatBugSweepHelp();
    }

    if (!preflight.dryRun) {
      const cwd = dependencies.cwd ?? process.cwd();
      const agentPreset = resolveNativeSkillAgent(dependencies.agentPreset, preflight.agentCommand);
      assertNativeSkillAvailable(cwd, agentPreset, 'bug-fix');
    }

    return runScheduledSweep(schedule, dependencies);
  }

  try {
    return await runSingleSweep(schedule.rest, dependencies);
  } finally {
    releaseLock();
  }
}

async function runSingleSweep(argv, dependencies = {}) {
  const options = parseBugSweepArgs(argv);

  if (options.help) {
    return formatBugSweepHelp();
  }

  const cwd = dependencies.cwd ?? process.cwd();
  options.agentPreset = resolveNativeSkillAgent(dependencies.agentPreset, options.agentCommand);
  if (!options.dryRun) assertNativeSkillAvailable(cwd, options.agentPreset, 'bug-fix');
  const logger = dependencies.logger ?? ((line) => process.stderr.write(`${line}\n`));
  const spawnImpl = dependencies.spawnImpl ?? runProcess;
  const now = dependencies.now ?? (() => new Date());
  const signal = dependencies.signal;
  const emit = dependencies.onEvent ?? (() => {});
  const jira = options.source === 'jira' ? resolveJiraConfig(options) : null;
  // Jira requests use node:https so an internal CA (--jira-ca) can be trusted per
  // request. Tests inject their own fetch through dependencies.fetchImpl.
  const fetchImpl = dependencies.fetchImpl
    ?? (jira ? createJiraFetch({ caPath: jira.ca, insecure: jira.insecure }) : globalThis.fetch);
  const jql = options.source === 'jira'
    ? buildJql({ project: options.project, jql: options.jql, issues: options.issues })
    : null;
  const githubQuery = options.source === 'github'
    ? describeGitHubQuery({
      repo: options.githubRepo,
      labels: options.githubLabels,
      state: options.githubState
    })
    : null;
  const gitlabQuery = options.source === 'gitlab' ? `${options.project} · open issues` : null;
  const workDir = path.resolve(cwd, options.workDir);
  const statePath = path.join(workDir, `state-${options.date}.json`);
  let state = null;

  emit({
    type: 'sweep-started',
    source: options.source,
    project: options.project,
    repo: options.githubRepo ?? options.gitlabProject?.project,
    date: options.date,
    branch: options.branch,
    tag: options.tag,
    jql,
    query: githubQuery ?? gitlabQuery ?? jql,
    dryRun: options.dryRun
  });

  if (!options.dryRun) {
    await ensureGitRepository(cwd);
    // A worktree gives the sweep its own clean checkout, so the user's tree may stay dirty.
    if (!options.worktree) {
      await ensureCleanWorktree(cwd);
    }
    prepareWorkDir(workDir);
    acquireLock(workDir, now);

    if (options.resume) {
      state = readState(statePath);

      if (!state) {
        throw new Error(`--resume was requested but ${statePath} does not exist.`);
      }
    }
  }

  // On resume, bugs that are already actioned are left out of the query so the next run
  // can reach bugs that an earlier --limit cut off.
  const excludedKeys = state
    ? state.bugs
      .filter((bug) => bug.status === 'fixed' || (bug.status === 'not-fixed' && !options.retryFailed))
      .map((bug) => bug.key)
    : [];
  const effectiveJql = options.source === 'jira' ? buildResumeJql(jql, excludedKeys) : null;

  logger(options.source === 'github'
    ? `Fetching GitHub issues for ${options.githubRepo}...`
    : options.source === 'gitlab'
      ? `Fetching GitLab issues for ${options.project}...`
      : `Fetching Jira bugs for ${options.project}...`);

  let fetchedBugs;

  try {
    if (options.source === 'github') {
      fetchedBugs = await fetchGitHubBugs({
        repo: options.githubRepo,
        token: options.githubToken,
        labels: options.githubLabels,
        state: options.githubState,
        issues: options.issues,
        apiUrl: options.githubApiUrl,
        // --limit caps how many bugs are fixed per run; the scan stays wider so the run
        // knows whether anything is still pending before it publishes.
        limit: Math.max(options.limit, DEFAULT_FETCH_LIMIT),
        fetchImpl
      });
      fetchedBugs = fetchedBugs.filter((bug) => !excludedKeys.includes(bug.key));
    } else if (options.source === 'gitlab') {
      fetchedBugs = await fetchGitLabIssues({
        project: options.gitlabProject?.hostname
          ? `https://${options.gitlabProject.hostname}/${options.gitlabProject.project}`
          : options.gitlabProject?.project,
        issues: options.issues,
        limit: Math.max(options.limit, DEFAULT_FETCH_LIMIT),
        cwd,
        run: spawnImpl
      });
      fetchedBugs = fetchedBugs.filter((bug) => !excludedKeys.includes(bug.key));
    } else {
      fetchedBugs = await fetchJiraBugs({
        baseUrl: jira.baseUrl,
        auth: jira.auth,
        email: jira.email,
        token: jira.token,
        apiVersion: jira.apiVersion,
        jql: effectiveJql,
        // --limit caps how many bugs are fixed per run; the scan stays wider so the run
        // knows whether anything is still pending before it publishes.
        limit: Math.max(options.limit, DEFAULT_FETCH_LIMIT),
        fields: [...new Set([...DEFAULT_JIRA_FIELDS, ...options.extraFields])],
        extraFields: options.extraFields,
        fetchImpl
      });
    }
  } catch (error) {
    if (options.source === 'github' || options.source === 'gitlab') {
      const tracker = options.source === 'github' ? 'GitHub' : 'GitLab';
      throw new Error(`Could not fetch ${tracker} issues: ${error.message}`);
    }

    const diagnosis = describeJiraError(error);

    throw new Error(`Could not fetch Jira bugs: ${diagnosis.hint}`);
  }

  const query = githubQuery ?? gitlabQuery ?? effectiveJql;

  logger(`Found ${fetchedBugs.length} bug(s).`);

  emit({
    type: 'bugs-found',
    source: options.source,
    total: fetchedBugs.length,
    jql: effectiveJql,
    query,
    bugs: fetchedBugs.map((bug) => ({ key: bug.key, summary: bug.summary, priority: bug.priority, url: bug.url }))
  });

  if (options.dryRun) {
    return formatDryRun({
      source: options.source,
      project: options.project,
      date: options.date,
      jql: effectiveJql,
      githubRepo: options.githubRepo,
      githubLabels: options.githubLabels,
      githubState: options.githubState,
      branch: options.branch,
      tag: options.tag,
      bugs: fetchedBugs
    });
  }

  const hasActionedBugs = Boolean(state) && state.bugs.some((bug) => bug.status !== 'pending');

  if (fetchedBugs.length === 0 && !hasActionedBugs) {
    return `No bugs matched: ${query}\n`;
  }

  if (!state) {
    const detectedBase = options.base ?? await detectBaseBranch(cwd);

    state = {
      version: 1,
      source: options.source,
      repo: options.githubRepo,
      project: options.project,
      date: options.date,
      branch: options.branch,
      tag: options.tag,
      base: stripRemotePrefix(await resolveBaseRef(cwd, detectedBase), options.remote),
      startedAt: now().toISOString(),
      updatedAt: now().toISOString(),
      phase: 'running',
      bugs: []
    };
  } else if (state.base === 'HEAD') {
    state.base = stripRemotePrefix(await resolveBaseRef(cwd, state.base), options.remote);
  }

  // state.base stays the plain branch name for the PR; the checkout starts from
  // the remote-tracking ref when one exists (`--fetch-base` refreshes it first).
  const baseRef = await resolveRemoteBase(cwd, state.base, {
    remote: options.remote,
    fetchBase: options.fetchBase,
    logger
  });

  mergeBugs(state, fetchedBugs, { retryFailed: options.retryFailed });

  // Everything below runs in `activeDir`: the repository itself, or an isolated
  // worktree that shares the same .git store.
  let activeDir = cwd;
  let worktreePath = null;

  if (options.worktree) {
    worktreePath = await prepareGitWorktree({
      repoRoot: cwd,
      workDir,
      options,
      baseRef,
      logger
    });
    activeDir = worktreePath;
  } else if (await refExists(cwd, `refs/heads/${options.branch}`)) {
    if (!options.resume) {
      throw new Error(`Branch ${options.branch} already exists. Use --resume or choose another --branch.`);
    }

    await git(cwd, ['checkout', options.branch]);
  } else {
    if (options.resume) {
      throw new Error(`--resume was requested but branch ${options.branch} does not exist.`);
    }

    if (!(await refExists(cwd, baseRef))) {
      throw new Error(`Base ref ${baseRef} does not exist.`);
    }

    await git(cwd, ['checkout', '-b', options.branch, baseRef]);
  }

  const tagExists = await refExists(activeDir, `refs/tags/${options.tag}`);

  if (tagExists && !options.resume) {
    throw new Error(`Tag ${options.tag} already exists. Use --resume or choose another --tag.`);
  }

  if (tagExists) {
    logger(`Tag ${options.tag} already exists and will not be moved.`);
  }

  writeState(statePath, state, now);

  const cancelled = () => {
    state.phase = 'cancelled';
    writeState(statePath, state, now);
    emit({ type: 'sweep-cancelled' });

    const summary = formatSweepSummary(state);

    fs.writeFileSync(path.join(workDir, `report-${options.date}.md`), summary, 'utf8');

    return `${summary}\nCancelled before finishing. Run again with --resume to continue.\n`;
  };

  let processed = 0;

  for (const bug of state.bugs) {
    if (signal?.aborted) {
      return cancelled();
    }

    if (bug.status === 'fixed') {
      logger(`Skipping ${bug.key} (already fixed).`);
      continue;
    }

    if (bug.status === 'not-fixed' && !options.retryFailed) {
      logger(`Skipping ${bug.key} (already reported as not fixed).`);
      continue;
    }

    if (processed >= options.limit) {
      break;
    }

    processed += 1;
    bug.status = 'pending';
    writeState(statePath, state, now);

    emit({ type: 'bug-started', key: bug.key, summary: bug.summary, url: bug.url });

    await processBug({
      bug,
      options,
      cwd: activeDir,
      workDir,
      logger,
      spawnImpl,
      now,
      signal
    });

    writeState(statePath, state, now);

    emit({
      type: 'bug-finished',
      key: bug.key,
      summary: bug.summary,
      status: bug.status,
      commit: bug.commit ?? null,
      fixSummary: bug.fixSummary ?? '',
      how: bug.how ?? '',
      reason: bug.reason ?? '',
      critical: bug.critical === true,
      criticalReason: bug.criticalReason ?? ''
    });

    if (signal?.aborted) {
      return cancelled();
    }
  }

  const fixedCount = state.bugs.filter((bug) => bug.status === 'fixed').length;
  const pendingCount = state.bugs.filter((bug) => bug.status === 'pending').length;

  // Do not publish a half-finished sweep: the tag and PR belong to the complete run.
  if (pendingCount > 0 && processed >= options.limit) {
    state.phase = 'partial';
    writeState(statePath, state, now);

    const summary = formatSweepSummary(state);

    fs.writeFileSync(path.join(workDir, `report-${options.date}.md`), summary, 'utf8');

    return `${summary}\nReached --limit ${options.limit} with ${pendingCount} bug(s) still pending. Run again with --resume to continue; the tag and pull request wait until the sweep finishes.\n`;
  }

  if (fixedCount === 0) {
    state.phase = 'no-fixes';
    writeState(statePath, state, now);

    const summary = formatSweepSummary(state);

    fs.writeFileSync(path.join(workDir, `report-${options.date}.md`), summary, 'utf8');
    await removeGitWorktree(cwd, worktreePath, logger);

    return `${summary}\nNo commits were created, so the tag and pull request were skipped.\n`;
  }

  state.phase = 'publishing';
  writeState(statePath, state, now);
  emit({ type: 'publishing', fixed: fixedCount });

  let publication = { pushed: false, prUrl: null };

  try {
    publication = await publish({ cwd: activeDir, options, state, workDir, logger });
    state.phase = 'complete';
  } catch (error) {
    state.phase = 'publish-failed';
    throw error;
  } finally {
    writeState(statePath, state, now);
  }

  emit({
    type: 'sweep-finished',
    phase: state.phase,
    fixed: fixedCount,
    pushed: publication.pushed,
    prUrl: publication.prUrl ?? null
  });

  const summary = formatSweepSummary(state, publication);

  fs.writeFileSync(path.join(workDir, `report-${options.date}.md`), summary, 'utf8');
  await removeGitWorktree(cwd, worktreePath, logger);

  return summary;
}
