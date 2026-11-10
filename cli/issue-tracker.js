import { normalizeGitLabProject } from './gitlab-issues.js';

const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const GITHUB_KEY = /^GH-(\d+)$/i;
const GITLAB_KEY = /^GL-(\d+)$/i;
const GITHUB_REPO = /^[^/\s]+\/[^/\s]+$/;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// A source issue is the tracker item a workflow started from. Only the key and
// the tracker target travel with a job; the credentials stay in the studio.
export function normalizeSourceIssue(issue) {
  if (!issue || typeof issue !== 'object') {
    return null;
  }

  const source = text(issue.source).toLowerCase();
  const key = text(issue.key).toUpperCase();
  const url = text(issue.url);
  const target = text(issue.target);

  if (!key) {
    return null;
  }

  if (source === 'jira' && JIRA_KEY.test(key)) {
    return { source, key, url, target };
  }

  if (source === 'github') {
    const number = Number(GITHUB_KEY.exec(key)?.[1]);

    if (Number.isInteger(number) && number > 0) {
      return { source, key: `GH-${number}`, number, url, target };
    }
  }

  if (source === 'gitlab') {
    const number = Number(GITLAB_KEY.exec(key)?.[1]);

    if (Number.isInteger(number) && number > 0) {
      return { source, key: `GL-${number}`, number, url, target };
    }
  }

  return null;
}

function issueNumber(issue) {
  if (Number.isInteger(issue.number) && issue.number > 0) {
    return issue.number;
  }

  const match = issue.source === 'github' ? GITHUB_KEY.exec(issue.key) : GITLAB_KEY.exec(issue.key);

  return Number(match?.[1]);
}

async function readError(response) {
  try {
    return String(await response.text()).slice(0, 800);
  } catch {
    return '';
  }
}

function jiraVersions(apiVersion) {
  const value = String(apiVersion ?? 'auto').toLowerCase().replace(/^v/, '');

  if (value === '2' || value === '3') {
    return [value];
  }

  // "auto" is the Cloud default, with a Data Center fallback.
  return ['3', '2'];
}

// Jira has no single "closed" flag: a transition moves the issue to a status in
// the Done category. Prefer the category, then a few common status names.
export async function closeJiraIssue({
  key,
  baseUrl,
  headers = {},
  apiVersion = 'auto',
  fetchImpl = globalThis.fetch
} = {}) {
  const base = text(baseUrl).replace(/\/+$/, '');

  if (!base) {
    throw new Error('Jira base URL is required to close an issue.');
  }

  let lastError = null;

  for (const version of jiraVersions(apiVersion)) {
    const issueUrl = `${base}/rest/api/${version}/issue/${encodeURIComponent(key)}`;

    try {
      const statusResponse = await fetchImpl(`${issueUrl}?fields=status`, { headers });

      if (!statusResponse.ok) {
        throw new Error(`Jira issue lookup failed (${statusResponse.status}): ${await readError(statusResponse)}`);
      }

      const issue = await statusResponse.json();
      const status = issue?.fields?.status;

      if (status?.statusCategory?.key === 'done') {
        return { closed: true, status: status.name ?? 'Done', already: true };
      }

      const transitionUrl = `${issueUrl}/transitions`;
      const transitionsResponse = await fetchImpl(transitionUrl, { headers });

      if (!transitionsResponse.ok) {
        throw new Error(`Jira transitions failed (${transitionsResponse.status}): ${await readError(transitionsResponse)}`);
      }

      const data = await transitionsResponse.json();
      const transitions = Array.isArray(data?.transitions) ? data.transitions : [];
      const transition = transitions.find((candidate) => candidate?.to?.statusCategory?.key === 'done')
        ?? transitions.find((candidate) => /^(done|closed|resolved|complete|completed)$/i.test(text(candidate?.to?.name)));

      if (!transition) {
        throw new Error(`Jira offers no Done transition for ${key}.`);
      }

      const applied = await fetchImpl(transitionUrl, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ transition: { id: transition.id } })
      });

      if (!applied.ok) {
        throw new Error(`Jira transition failed (${applied.status}): ${await readError(applied)}`);
      }

      return { closed: true, status: transition.to?.name ?? 'Done' };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error(`Could not close ${key}.`);
}

export async function closeGitHubIssue({
  repo,
  number,
  token = '',
  apiUrl = 'https://api.github.com',
  fetchImpl = globalThis.fetch
} = {}) {
  const target = text(repo);

  if (!GITHUB_REPO.test(target)) {
    throw new Error(`Invalid GitHub repository "${repo}". Use owner/repo.`);
  }

  const base = text(apiUrl).replace(/\/+$/, '') || 'https://api.github.com';
  const response = await fetchImpl(`${base}/repos/${target}/issues/${number}`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sdd-issue-tracker',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ state: 'closed' })
  });

  if (!response.ok) {
    throw new Error(`GitHub issue close failed (${response.status}): ${await readError(response)}`);
  }

  return { closed: true, status: 'Closed' };
}

export async function closeGitLabIssue({
  project,
  number,
  hostname = null,
  cwd = process.cwd(),
  run
} = {}) {
  if (typeof run !== 'function') {
    throw new Error('A process runner is required to close a GitLab issue.');
  }

  const target = typeof project === 'string' ? normalizeGitLabProject(project) : project;

  if (!target?.project) {
    throw new Error('A GitLab project is required to close an issue.');
  }

  const host = target.hostname ?? hostname;
  let result;

  try {
    result = await run('glab', [
      'api',
      ...(host ? ['--hostname', host] : []),
      '--method', 'PUT',
      `projects/${encodeURIComponent(target.project)}/issues/${number}`,
      '-f', 'state_event=close'
    ], { cwd, timeoutMs: 30000 });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('GitLab CLI (glab) is not installed or is not on PATH. Install it from https://docs.gitlab.com/cli/.');
    }

    throw error;
  }

  if (!result || result.code !== 0) {
    const detail = text(result?.stderr) || text(result?.stdout);
    throw new Error(detail || 'GitLab issue close failed. Run "glab auth login" and check project access.');
  }

  let status = 'Closed';

  try {
    const data = JSON.parse(result.stdout);
    status = data?.state === 'closed' ? 'Closed' : (data?.state ?? status);
  } catch {
    // glab may print a human message instead of JSON; the command already succeeded.
  }

  return { closed: true, status };
}

// The spec starts with "# Feature: <name>" (deep-spec format). Fall back to the
// first heading, then to the feature directory name the caller passes.
export function specIssueTitle(markdown, fallback = 'Feature spec') {
  const content = String(markdown ?? '');
  const feature = /^#\s+Feature:\s*(.+?)\s*$/im.exec(content)?.[1]?.trim();

  if (feature) {
    return feature.slice(0, 240);
  }

  const heading = /^#\s+(.+?)\s*$/m.exec(content)?.[1]?.trim();

  return (heading || fallback || 'Feature spec').slice(0, 240);
}

// Jira Cloud v3 takes Atlassian Document Format, Data Center v2 takes plain
// text. Each non-empty line becomes a paragraph so the spec keeps its shape.
function jiraAdf(text) {
  const paragraphs = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => (line
      ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
      : { type: 'paragraph' }));

  return {
    type: 'doc',
    version: 1,
    content: paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph' }]
  };
}

export async function createJiraIssue({
  project,
  summary,
  description,
  issueType = 'Task',
  baseUrl,
  headers = {},
  apiVersion = 'auto',
  fetchImpl = globalThis.fetch
} = {}) {
  const base = text(baseUrl).replace(/\/+$/, '');
  const projectKey = text(project);

  if (!base) {
    throw new Error('Jira base URL is required to create an issue.');
  }

  if (!projectKey) {
    throw new Error('A Jira project key is required to create an issue.');
  }

  let lastError = null;

  for (const version of jiraVersions(apiVersion)) {
    const response = await fetchImpl(`${base}/rest/api/${version}/issue`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...headers
      },
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          summary,
          description: version === '3' ? jiraAdf(description) : String(description ?? ''),
          issuetype: { name: issueType }
        }
      })
    });

    if (!response.ok) {
      lastError = new Error(`Jira issue create failed (${response.status}): ${await readError(response)}`);
      continue;
    }

    const data = await response.json().catch(() => ({}));

    return {
      created: true,
      source: 'jira',
      key: text(data.key),
      id: data.id == null ? null : String(data.id),
      url: data.key ? `${base}/browse/${data.key}` : ''
    };
  }

  throw lastError ?? new Error('Could not create the Jira issue.');
}

export async function createGitHubIssue({
  repo,
  title,
  body,
  labels = [],
  token = '',
  apiUrl = 'https://api.github.com',
  fetchImpl = globalThis.fetch
} = {}) {
  const target = text(repo);

  if (!GITHUB_REPO.test(target)) {
    throw new Error(`Invalid GitHub repository "${repo}". Use owner/repo.`);
  }

  const base = text(apiUrl).replace(/\/+$/, '') || 'https://api.github.com';
  const response = await fetchImpl(`${base}/repos/${target}/issues`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sdd-issue-tracker',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      title,
      body,
      ...(Array.isArray(labels) && labels.length > 0 ? { labels } : {})
    })
  });

  if (!response.ok) {
    throw new Error(`GitHub issue create failed (${response.status}): ${await readError(response)}`);
  }

  const data = await response.json();

  return {
    created: true,
    source: 'github',
    key: `GH-${data.number}`,
    number: data.number,
    url: text(data.html_url)
  };
}

export async function createGitLabIssue({
  project,
  title,
  description,
  labels = [],
  hostname = null,
  cwd = process.cwd(),
  run
} = {}) {
  if (typeof run !== 'function') {
    throw new Error('A process runner is required to create a GitLab issue.');
  }

  const target = typeof project === 'string' ? normalizeGitLabProject(project) : project;

  if (!target?.project) {
    throw new Error('A GitLab project is required to create an issue.');
  }

  const host = target.hostname ?? hostname;
  const args = [
    'api',
    ...(host ? ['--hostname', host] : []),
    '--method', 'POST',
    `projects/${encodeURIComponent(target.project)}/issues`,
    '-f', `title=${title}`,
    '-f', `description=${description}`
  ];

  for (const label of labels) {
    args.push('-f', `labels[]=${label}`);
  }

  let result;

  try {
    result = await run('glab', args, { cwd, timeoutMs: 30000 });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('GitLab CLI (glab) is not installed or is not on PATH. Install it from https://docs.gitlab.com/cli/.');
    }

    throw error;
  }

  if (!result || result.code !== 0) {
    const detail = text(result?.stderr) || text(result?.stdout);
    throw new Error(detail || 'GitLab issue create failed. Run "glab auth login" and check project access.');
  }

  let data;

  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error('Could not read the JSON response from glab api. Update GitLab CLI and try again.');
  }

  return {
    created: true,
    source: 'gitlab',
    key: `GL-${data.iid}`,
    number: data.iid,
    url: text(data.web_url)
  };
}

// One issue is created per spec. The body is the spec file itself; the title
// comes from its first heading. Missing credentials and tracker rejections are
// the caller's problem to report, never a reason to lose the spec.
export async function createTrackerIssue({
  source,
  target,
  title,
  body,
  issueType = 'Task',
  labels = [],
  jira,
  github,
  gitlab
} = {}) {
  const tracker = text(source).toLowerCase();

  if (tracker === 'jira') {
    if (!jira) {
      throw new Error('Jira is not configured.');
    }

    return createJiraIssue({
      project: text(target) || text(jira.project),
      summary: title,
      description: body,
      issueType,
      baseUrl: jira.baseUrl,
      headers: jira.headers,
      apiVersion: jira.apiVersion,
      fetchImpl: jira.fetchImpl
    });
  }

  if (tracker === 'github') {
    if (!github) {
      throw new Error('GitHub is not configured.');
    }

    return createGitHubIssue({
      repo: text(target) || text(github.repo),
      title,
      body,
      labels,
      token: github.token,
      apiUrl: github.apiUrl,
      fetchImpl: github.fetchImpl
    });
  }

  if (tracker === 'gitlab') {
    if (!gitlab) {
      throw new Error('GitLab is not configured.');
    }

    return createGitLabIssue({
      project: target || gitlab.project,
      title,
      description: body,
      labels,
      hostname: gitlab.hostname,
      cwd: gitlab.cwd,
      run: gitlab.run
    });
  }

  throw new Error(`Unsupported issue source "${source}".`);
}

// Dispatch one source issue to its tracker. Callers keep closure best-effort:
// a tracker failure is reported, never allowed to undo a finished run.
export async function closeTrackerIssue({ issue, jira, github, gitlab } = {}) {
  const sourceIssue = normalizeSourceIssue(issue);

  if (!sourceIssue) {
    throw new Error('The source issue has no supported tracker key.');
  }

  if (sourceIssue.source === 'jira') {
    if (!jira) {
      throw new Error('Jira is not configured.');
    }

    return closeJiraIssue({ key: sourceIssue.key, ...jira });
  }

  if (sourceIssue.source === 'github') {
    if (!github) {
      throw new Error('GitHub is not configured.');
    }

    return closeGitHubIssue({
      repo: sourceIssue.target || github.repo,
      number: issueNumber(sourceIssue),
      token: github.token,
      apiUrl: github.apiUrl,
      fetchImpl: github.fetchImpl
    });
  }

  if (sourceIssue.source === 'gitlab') {
    if (!gitlab) {
      throw new Error('GitLab is not configured.');
    }

    return closeGitLabIssue({
      project: sourceIssue.target || gitlab.project,
      number: issueNumber(sourceIssue),
      hostname: gitlab.hostname,
      cwd: gitlab.cwd,
      run: gitlab.run
    });
  }

  throw new Error(`Unsupported issue source "${sourceIssue.source}".`);
}
