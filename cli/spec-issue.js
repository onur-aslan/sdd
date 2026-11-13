import fs from 'node:fs';
import path from 'node:path';

import { buildJiraAuthHeader, createJiraFetch, runProcess } from './bug-sweep.js';
import { createTrackerIssue, specIssueTitle } from './issue-tracker.js';
import {
  githubCliToken,
  readStore,
  resolveStudioGitHub,
  resolveStudioJira
} from './studio.js';

const SOURCES = ['jira', 'github', 'gitlab'];

export function formatSpecIssueHelp() {
  return `SDD spec-issue - file a deep-spec spec as one tracker issue

Usage:
  sdd spec-issue [spec.md] [options]

Without a path, the newest docs/sdd/features/<feature>/spec.md is used.

Options:
  --source <jira|github|gitlab>  Tracker to create the issue in (saved choice)
  --target <value>               Jira project key, GitHub owner/repo, or GitLab project
  --type <name>                  Jira issue type (default: Task)
  --labels <a,b>                 Labels for GitHub or GitLab
  --dry-run                      Print the plan without creating anything
  --json                         Print the result or plan as JSON
  --help                         Show this help

Examples:
  sdd spec-issue
  sdd spec-issue docs/sdd/features/saved-searches/spec.md --source github
  sdd spec-issue spec.md --source jira --target ABC --dry-run
`;
}

function splitFlag(token) {
  const index = token.indexOf('=');

  return index === -1 ? [token, null] : [token.slice(0, index), token.slice(index + 1)];
}

function flagValue(name, inline, argv, index) {
  if (inline !== null) {
    return { value: inline, next: index };
  }

  const value = argv[index + 1];

  if (value === undefined || value === '' || value.startsWith('--')) {
    throw new Error(`Missing value for ${name}.`);
  }

  return { value, next: index + 1 };
}

export function parseSpecIssueArgs(argv = []) {
  const options = {
    specPath: '',
    source: '',
    target: '',
    issueType: 'Task',
    labels: [],
    dryRun: false,
    json: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }

    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (token === '--json') {
      options.json = true;
      continue;
    }

    if (token.startsWith('--')) {
      const [name, inline] = splitFlag(token);

      if (!['--source', '--target', '--type', '--labels'].includes(name)) {
        throw new Error(`Unknown option ${name}.`);
      }

      const resolved = flagValue(name, inline, argv, index);

      index = resolved.next;

      if (name === '--source') {
        const source = resolved.value.toLowerCase();

        if (!SOURCES.includes(source)) {
          throw new Error(`--source expects one of: ${SOURCES.join(', ')}.`);
        }

        options.source = source;
      } else if (name === '--target') {
        options.target = resolved.value.trim();
      } else if (name === '--type') {
        options.issueType = resolved.value.trim() || 'Task';
      } else if (name === '--labels') {
        options.labels = resolved.value
          .split(',')
          .map((label) => label.trim())
          .filter(Boolean);
      }

      continue;
    }

    if (!options.specPath) {
      options.specPath = token;
      continue;
    }

    throw new Error(`Unexpected argument ${token}.`);
  }

  return options;
}

// The interview writes docs/sdd/features/<feature>/spec.md. When no path is
// passed, the newest one is the spec the human just approved.
export function findNewestSpec(cwd = process.cwd()) {
  const root = path.resolve(cwd, 'docs', 'sdd', 'features');

  if (!fs.existsSync(root)) {
    return '';
  }

  const candidates = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const file = path.join(root, entry.name, 'spec.md');

    if (fs.existsSync(file)) {
      candidates.push({ file, mtime: fs.statSync(file).mtimeMs });
    }
  }

  candidates.sort((left, right) => right.mtime - left.mtime);

  return candidates[0]?.file ?? '';
}

function resolveSpecPath(value, cwd) {
  const input = String(value ?? '').trim();

  if (!input) {
    const newest = findNewestSpec(cwd);

    if (!newest) {
      throw new Error('No spec.md found under docs/sdd/features. Pass the spec path explicitly.');
    }

    return newest;
  }

  const absolute = path.resolve(cwd, input);

  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`Spec file not found: ${input}`);
  }

  return absolute;
}

function resolveTarget({ source, requested, settings }) {
  const target = String(requested ?? '').trim();

  if (target) {
    return target;
  }

  const saved = source === 'github'
    ? settings.githubRepo
    : source === 'gitlab'
      ? settings.gitlabProject
      : settings.project;

  return String(saved ?? '').trim();
}

function formatPlan(plan) {
  return [
    'Spec issue plan',
    `  source  ${plan.source}`,
    `  target  ${plan.target}`,
    `  title   ${plan.title}`,
    `  spec    ${plan.spec} (${plan.bytes} bytes)`,
    `  type    ${plan.type}`,
    ...(plan.labels.length > 0 ? [`  labels  ${plan.labels.join(', ')}`] : [])
  ].join('\n');
}

export async function runSpecIssue(argv = [], dependencies = {}) {
  const options = parseSpecIssueArgs(argv);

  if (options.help) {
    return formatSpecIssueHelp();
  }

  const cwd = dependencies.cwd ?? process.cwd();
  const settings = dependencies.settings ?? readStore(cwd);
  const specPath = resolveSpecPath(options.specPath, cwd);
  const body = fs.readFileSync(specPath, 'utf8');
  const title = specIssueTitle(body, path.basename(path.dirname(specPath)) || 'Feature spec');
  const source = options.source || String(settings.source || settings.specIssueSource || '').toLowerCase() || 'jira';
  const target = resolveTarget({ source, requested: options.target, settings });
  const plan = {
    source,
    target,
    title,
    spec: path.relative(cwd, specPath).split(path.sep).join('/'),
    bytes: Buffer.byteLength(body),
    type: options.issueType,
    labels: options.labels
  };

  if (!SOURCES.includes(source)) {
    throw new Error(`Unknown source "${source}". Use one of: ${SOURCES.join(', ')}.`);
  }

  if (!target) {
    throw new Error(
      source === 'github'
        ? 'Set a GitHub repository with --target or in Settings.'
        : source === 'gitlab'
          ? 'Set a GitLab project with --target or in Settings.'
          : 'Set a Jira project with --target or in Settings.'
    );
  }

  if (options.dryRun) {
    return options.json ? JSON.stringify({ plan }, null, 2) : formatPlan(plan);
  }

  const fetchImpl = dependencies.fetchImpl;
  const run = dependencies.run ?? runProcess;

  if (source === 'jira') {
    const jira = resolveStudioJira({}, settings);

    if (!jira.url || !jira.token) {
      throw new Error('Jira credentials are not configured. Add the URL and token in Settings or the environment.');
    }

    const result = await createTrackerIssue({
      source,
      target,
      title,
      body,
      issueType: options.issueType,
      labels: options.labels,
      jira: {
        baseUrl: jira.url,
        headers: {
          Authorization: dependencies.jiraAuthHeader
            ?? buildJiraAuthHeader({ auth: jira.auth, email: jira.email, token: jira.token }),
          Accept: 'application/json'
        },
        apiVersion: jira.apiVersion,
        fetchImpl: fetchImpl ?? createJiraFetch({ caPath: jira.ca, insecure: jira.insecure })
      }
    });

    return options.json ? JSON.stringify(result, null, 2) : `Created ${result.key}${result.url ? `: ${result.url}` : ''}`;
  }

  if (source === 'github') {
    const github = resolveStudioGitHub({}, settings);
    const result = await createTrackerIssue({
      source,
      target,
      title,
      body,
      labels: options.labels,
      github: {
        repo: target,
        token: dependencies.githubToken ?? await githubCliToken(cwd),
        apiUrl: github.apiUrl,
        fetchImpl: fetchImpl ?? globalThis.fetch
      }
    });

    return options.json ? JSON.stringify(result, null, 2) : `Created ${result.key}${result.url ? `: ${result.url}` : ''}`;
  }

  const result = await createTrackerIssue({
    source,
    target,
    title,
    body,
    labels: options.labels,
    gitlab: { project: target, cwd, run }
  });

  return options.json ? JSON.stringify(result, null, 2) : `Created ${result.key}${result.url ? `: ${result.url}` : ''}`;
}
