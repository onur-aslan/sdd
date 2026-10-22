import fs from 'node:fs';
import path from 'node:path';

import {
  extractMergeRequestUrl,
  openMergeRequest,
  runProcess
} from './bug-sweep.js';

const DEFAULT_REMOTE = 'origin';

function pad(value) {
  return String(value).padStart(2, '0');
}

function localDate(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

export function sessionSlug(value, fallback = 'change') {
  const slug = String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');

  return slug || fallback;
}

export function sessionBranchName({ flow, brief, id = '', date = new Date() }) {
  const prefix = flow === 'feature' ? 'feature' : 'enhancement';
  const suffix = id ? `-${String(id).replace(/-/g, '').slice(0, 6)}` : '';

  return `sdd/${prefix}/${sessionSlug(brief)}-${localDate(date)}${suffix}`;
}

// A session publishes only when the dashboard asked for it. The plan is plain
// data: the job snapshot can replay it, and the UI shows the same branch name
// while the agent is still working.
export function createSessionPublishPlan({
  flow,
  brief,
  id = '',
  request = {},
  saved = {},
  date = new Date()
} = {}) {
  const base = String(request.base ?? saved.base ?? '').trim().replace(/^origin\//, '');
  const push = request.push === undefined ? saved.push !== false : Boolean(request.push);
  const pr = request.pr === undefined ? saved.pr !== false : Boolean(request.pr);

  return {
    enabled: request.publish === true,
    flow,
    sessionId: id,
    base,
    remote: DEFAULT_REMOTE,
    branch: sessionBranchName({ flow, brief, id, date }),
    push,
    pr: pr && push,
    prPreset: String(saved.prPreset ?? 'github'),
    prCommand: String(saved.prCommand ?? ''),
    status: 'idle',
    reason: '',
    error: '',
    commit: '',
    commits: [],
    prUrl: '',
    startedSha: ''
  };
}

function event(publish, emit) {
  emit({ type: 'publish', ...publish, commits: [...publish.commits] });
}

function skip(publish, reason, emit) {
  publish.status = 'skipped';
  publish.reason = reason;
  event(publish, emit);

  return publish;
}

function fail(publish, error, emit) {
  publish.status = 'failed';
  publish.error = error?.message ?? String(error ?? 'Publishing failed.');
  event(publish, emit);

  return publish;
}

async function git(run, cwd, args, { allowFailure = false } = {}) {
  const result = await run('git', args, { cwd, timeoutMs: 120000 });

  if (!allowFailure && result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();

    throw new Error(`git ${args.join(' ')} failed (${result.code})${detail ? `: ${detail}` : ''}`);
  }

  return result;
}

async function detectBase(run, cwd) {
  const remoteHead = await git(run, cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
    allowFailure: true
  });

  if (remoteHead.code === 0 && remoteHead.stdout.trim()) {
    return remoteHead.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  }

  for (const candidate of ['main', 'master']) {
    const exists = await git(run, cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], {
      allowFailure: true
    });

    if (exists.code === 0) {
      return candidate;
    }
  }

  const current = await git(run, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });

  return current.code === 0 ? current.stdout.trim() : '';
}

async function branchExists(run, cwd, branch) {
  const result = await git(run, cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    allowFailure: true
  });

  return result.code === 0;
}

async function workingTree(run, cwd) {
  const result = await git(run, cwd, ['status', '--porcelain']);

  return result.stdout.trim();
}

async function returnToBase({ run, cwd, publish, emit, reason }) {
  const clean = !(await workingTree(run, cwd));

  if (!clean) {
    publish.status = 'abandoned';
    publish.reason = `${reason} The branch was left in place because it has uncommitted changes.`;
    event(publish, emit);

    return publish;
  }

  const switched = await git(run, cwd, ['switch', publish.base], { allowFailure: true });

  if (switched.code === 0) {
    await git(run, cwd, ['branch', '-D', publish.branch], { allowFailure: true });
  }

  publish.status = 'abandoned';
  publish.reason = reason;
  event(publish, emit);

  return publish;
}

// A branch is created before the first turn. The agent therefore works on the
// same branch from the first plan through the final verification, and the MR
// can be opened without switching branches under the user's feet later.
export async function beginSessionPublish({
  cwd,
  publish,
  emit = () => {},
  run = runProcess
} = {}) {
  if (!publish) {
    return null;
  }

  if (!publish.enabled) {
    return skip(publish, 'Publishing is off for this session.', emit);
  }

  try {
    const inside = await git(run, cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });

    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      return skip(publish, 'This directory is not a git repository, so no publishing branch was created.', emit);
    }

    if (await workingTree(run, cwd)) {
      return skip(
        publish,
        'The checkout had uncommitted changes before the session, so no publishing branch was created. Commit or stash them first.',
        emit
      );
    }

    if (!publish.base) {
      publish.base = await detectBase(run, cwd);
    }

    if (!publish.base) {
      return skip(publish, 'Could not detect the base branch.', emit);
    }

    const baseExists = await git(run, cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${publish.base}`], {
      allowFailure: true
    });

    if (baseExists.code !== 0) {
      return skip(publish, `The base branch "${publish.base}" does not exist locally.`, emit);
    }

    const current = (await git(run, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();

    if (current !== publish.base) {
      return skip(
        publish,
        `Switch to "${publish.base}" before starting; the session branches from the base, not from "${current}".`,
        emit
      );
    }

    if (await branchExists(run, cwd, publish.branch)) {
      publish.branch = `${publish.branch}-${String(publish.sessionId).replace(/-/g, '').slice(0, 6) || '2'}`;
    }

    const switched = await git(run, cwd, ['switch', '-c', publish.branch], { allowFailure: true });

    if (switched.code !== 0) {
      const detail = (switched.stderr || switched.stdout).trim();

      return fail(publish, new Error(`Could not create the branch "${publish.branch}"${detail ? `: ${detail}` : '.'}`), emit);
    }

    publish.startedSha = (await git(run, cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    publish.status = 'branch';
    event(publish, emit);

    return publish;
  } catch (error) {
    return fail(publish, error, emit);
  }
}

export async function commitSessionWork({
  cwd,
  publish,
  title,
  body = '',
  emit = () => {},
  run = runProcess,
  cleanupWhenEmpty = true
} = {}) {
  if (!publish || !['branch', 'committed'].includes(publish.status)) {
    return publish;
  }

  try {
    if (!(await workingTree(run, cwd))) {
      publish.status = 'no-changes';
      publish.reason = 'No changes were made, so there was nothing to commit.';

      if (cleanupWhenEmpty && publish.commits.length === 0) {
        return returnToBase({ run, cwd, publish, emit, reason: publish.reason });
      }

      event(publish, emit);

      return publish;
    }

    await git(run, cwd, ['add', '-A']);

    const commit = await git(run, cwd, ['commit', '-m', title, '-m', body], { allowFailure: true });

    if (commit.code !== 0) {
      const detail = (commit.stderr || commit.stdout).trim();

      // A clean tree after a raced write is not a failure; everything else is.
      if (/nothing to commit/i.test(detail)) {
        publish.status = 'no-changes';
        publish.reason = detail;

        if (cleanupWhenEmpty && publish.commits.length === 0) {
          return returnToBase({ run, cwd, publish, emit, reason: publish.reason });
        }

        event(publish, emit);

        return publish;
      }

      throw new Error(`git commit failed (${commit.code})${detail ? `: ${detail}` : ''}`);
    }

    publish.commit = (await git(run, cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    publish.commits.push(publish.commit);
    publish.status = 'committed';
    event(publish, emit);

    return publish;
  } catch (error) {
    return fail(publish, error, emit);
  }
}

async function pushBranch({ run, cwd, publish, title, body }) {
  const args = ['push', '-u', publish.remote, publish.branch];

  if (publish.pr && publish.prPreset === 'gitlab-push') {
    args.push(
      '-o', 'merge_request.create',
      '-o', `merge_request.target=${publish.base}`,
      '-o', `merge_request.title=${title}`,
      '-o', `merge_request.description=${body}`
    );
  }

  const pushed = await git(run, cwd, args, { allowFailure: true });

  if (pushed.code !== 0) {
    const detail = (pushed.stderr || pushed.stdout).trim();

    throw new Error(`git push failed (${pushed.code})${detail ? `: ${detail}` : ''}`);
  }

  return pushed;
}

async function openGitHubPullRequest({ run, cwd, publish, title, bodyFile }) {
  const auth = await run('gh', ['auth', 'status'], { cwd, timeoutMs: 30000 });

  if (auth.code !== 0) {
    const detail = (auth.stderr || auth.stdout).trim();

    throw new Error(`The GitHub CLI must be installed and authenticated for a merge request${detail ? `: ${detail}` : '.'}`);
  }

  const existing = await run('gh', ['pr', 'view', publish.branch, '--json', 'url', '--jq', '.url'], {
    cwd,
    timeoutMs: 60000
  });

  if (existing.code === 0 && existing.stdout.trim()) {
    const url = existing.stdout.trim();
    const edited = await run('gh', ['pr', 'edit', publish.branch, '--body-file', bodyFile], {
      cwd,
      timeoutMs: 60000
    });

    if (edited.code !== 0) {
      const detail = (edited.stderr || edited.stdout).trim();

      throw new Error(`Could not update the pull request${detail ? `: ${detail}` : '.'}`);
    }

    return url;
  }

  const created = await run('gh', [
    'pr',
    'create',
    '--base',
    publish.base,
    '--head',
    publish.branch,
    '--title',
    title,
    '--body-file',
    bodyFile
  ], { cwd, timeoutMs: 120000 });

  if (created.code !== 0) {
    const detail = (created.stderr || created.stdout).trim();

    throw new Error(`Could not create the pull request${detail ? `: ${detail}` : '.'}`);
  }

  return created.stdout.trim();
}

export async function publishSessionWork({
  cwd,
  publish,
  title,
  body = '',
  dir,
  emit = () => {},
  run = runProcess,
  openPr = openMergeRequest
} = {}) {
  if (!publish || !publish.commits.length) {
    return publish;
  }

  if (!publish.push) {
    publish.status = 'committed';
    return publish;
  }

  try {
    const pushed = await pushBranch({ run, cwd, publish, title, body });

    publish.status = 'pushed';
    event(publish, emit);

    if (!publish.pr) {
      return publish;
    }

    if (publish.prPreset === 'gitlab-push') {
      publish.prUrl = extractMergeRequestUrl(`${pushed.stdout}\n${pushed.stderr}`) ?? '';
      publish.status = 'published';
      event(publish, emit);

      return publish;
    }

    fs.mkdirSync(dir, { recursive: true });

    const bodyFile = path.join(dir, 'pr.md');

    fs.writeFileSync(bodyFile, body, 'utf8');

    if (publish.prCommand) {
      publish.prUrl = await openPr({
        cwd,
        options: {
          branch: publish.branch,
          remote: publish.remote,
          prCommand: publish.prCommand
        },
        state: {
          base: publish.base,
          project: '',
          date: localDate()
        },
        title,
        bodyFile,
        logger: () => {}
      }) ?? '';
    } else {
      publish.prUrl = await openGitHubPullRequest({ run, cwd, publish, title, bodyFile });
    }

    publish.status = 'published';
    event(publish, emit);

    return publish;
  } catch (error) {
    return fail(publish, error, emit);
  }
}

export async function abandonSessionPublish({
  cwd,
  publish,
  emit = () => {},
  run = runProcess,
  reason = 'The session did not finish, so its changes were not published.'
} = {}) {
  if (!publish || publish.status !== 'branch') {
    return publish;
  }

  if (publish.commits.length > 0) {
    publish.status = 'abandoned';
    publish.reason = `${reason} The branch and its commit were left in place.`;
    event(publish, emit);

    return publish;
  }

  try {
    return await returnToBase({ run, cwd, publish, emit, reason });
  } catch (error) {
    return fail(publish, error, emit);
  }
}
