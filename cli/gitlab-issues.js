const GITLAB_KEY = /^GL-(\d+)$/i;

export function normalizeGitLabProject(value) {
  if (value === undefined || value === null || value === '') return null;

  const text = String(value).trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  let hostname = null;
  let projectPath = text;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const url = new URL(text);
    hostname = url.hostname;
    projectPath = url.pathname.replace(/^\/+|\/+$/g, '');
  } else if (/^[^/]+:[^/]+\//.test(text)) {
    const match = /^([^:]+):(.+)$/.exec(text);
    hostname = match[1].replace(/^git@/, '');
    projectPath = match[2];
  }

  projectPath = projectPath.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  if (!projectPath || projectPath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid GitLab project "${value}". Use group/subgroup/project or a GitLab project URL.`);
  }

  return { project: projectPath, hostname };
}

export function parseGitLabIssueKeys(value) {
  const entries = Array.isArray(value) ? value : String(value ?? '').split(',');
  const keys = [];

  for (const entry of entries) {
    const text = String(entry).trim();
    if (!text) continue;

    const number = /(?:\/-\/issues\/|^#?)(\d+)(?:[?#].*)?$/.exec(text)?.[1]
      ?? GITLAB_KEY.exec(text.toUpperCase())?.[1];
    if (!number || Number(number) <= 0) {
      throw new Error(`Invalid GitLab issue "${entry}". Use 123, GL-123, or an issue URL.`);
    }

    const key = `GL-${Number(number)}`;
    if (!keys.includes(key)) keys.push(key);
  }

  return keys;
}

export function mapGitLabIssue(issue) {
  const labels = Array.isArray(issue.labels) ? issue.labels.map(String) : [];
  const priority = labels.find((label) => /^(priority\s*[:/]\s*\S+|p[0-3]|critical|high|medium|low)$/i.test(label)) ?? '';
  return {
    key: `GL-${issue.iid}`,
    id: issue.id == null ? null : String(issue.id),
    number: issue.iid,
    summary: issue.title ?? '',
    description: issue.description ?? '',
    priority,
    jiraStatus: '',
    statusLabel: issue.state === 'closed' ? 'Closed' : 'Open',
    labels,
    url: issue.web_url ?? '',
    source: 'gitlab',
    tracker: 'GitLab',
    state: issue.state ?? '',
    extraFields: {}
  };
}

export async function fetchGitLabIssues({
  project,
  issues = [],
  limit = 50,
  cwd = process.cwd(),
  run
} = {}) {
  if (typeof run !== 'function') throw new Error('A process runner is required to read GitLab issues.');
  const target = normalizeGitLabProject(project);
  if (!target) throw new Error('A GitLab project is required. Use group/subgroup/project.');

  const issueKeys = parseGitLabIssueKeys(issues);
  const hostnameArgs = target.hostname ? ['--hostname', target.hostname] : [];
  const paths = issueKeys.length
    ? issueKeys.slice(0, limit).map((key) => `projects/${encodeURIComponent(target.project)}/issues/${key.slice(3)}`)
    : [`projects/${encodeURIComponent(target.project)}/issues?state=opened&per_page=${Math.min(limit, 100)}&order_by=updated_at&sort=desc`];
  const mapped = [];

  for (const endpoint of paths) {
    let result;
    try {
      result = await run('glab', ['api', ...hostnameArgs, endpoint], { cwd, timeoutMs: 30000 });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('GitLab CLI (glab) is not installed or is not on PATH. Install it from https://docs.gitlab.com/cli/.');
      }
      throw error;
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(detail || `glab api failed (${result.code}). Run "glab auth login" and check project access.`);
    }
    let data;
    try {
      data = JSON.parse(result.stdout);
    } catch {
      throw new Error('Could not read the JSON response from glab api. Update GitLab CLI and try again.');
    }
    const issuesList = Array.isArray(data) ? data : [data];
    mapped.push(...issuesList.filter((issue) => issue.iid != null).map(mapGitLabIssue));
  }

  return mapped;
}
