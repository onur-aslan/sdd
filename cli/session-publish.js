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
  const prefix = flow === 'feature' ? 'feature' : flow === 'merge' ? 'merge' : 'enhancement';
  const suffix = id ? `-${String(id).replace(/-/g, '').slice(0, 6)}` : '';

  return `sdd/${prefix}/${sessionSlug(brief)}-${localDate(date)}${suffix}`;
}

// A session publishes from its worktree. The plan is plain data: the job
// snapshot can replay it, and the UI shows the same branch while the agent is
// still working. enhancement and feature always push; the MR is optional.
export function createSessionPublishPlan({
  flow,
  brief,
  id = '',
  request = {},
  saved = {},
  date = new Date()
} = {}) {
  const mr = request.mr === undefined ? saved.mr !== false : request.mr !== false;

  return {
    enabled: request.publish !== false,
    flow,
    sessionId: id,
    base: '',
    remote: DEFAULT_REMOTE,
    branch: sessionBranchName({ flow, brief, id, date }),
    push: true,
    pr: mr,
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

async function workingTree(run, cwd) {
  const result = await git(run, cwd, ['status', '--porcelain']);

  return result.stdout.trim();
}

// Commit everything the agent left in the worktree. An agent-created commit is
// also a session commit, so it is published instead of being treated as empty.
export async function commitSessionWork({
  cwd,
  publish,
  title,
  body = '',
  emit = () => {},
  run = runProcess
} = {}) {
  if (!publish || !['idle', 'branch', 'committed'].includes(publish.status)) {
    return publish;
  }

  try {
    if (!(await workingTree(run, cwd))) {
      const head = (await git(run, cwd, ['rev-parse', 'HEAD'], { allowFailure: true })).stdout.trim();

      if (publish.startedSha && head && head !== publish.startedSha) {
        publish.commit = head;
        publish.commits.push(head);
        publish.status = 'committed';
        event(publish, emit);

        return publish;
      }

      publish.status = 'no-changes';
      publish.reason = 'No changes were made, so there was nothing to commit.';
      event(publish, emit);

      return publish;
    }

    await git(run, cwd, ['add', '-A']);

    const commit = await git(run, cwd, ['commit', '-m', title, '-m', body], { allowFailure: true });

    if (commit.code !== 0) {
      const detail = (commit.stderr || commit.stdout).trim();

      if (/nothing to commit/i.test(detail)) {
        publish.status = 'no-changes';
        publish.reason = detail;
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
    'pr', 'create', '--base', publish.base, '--head', publish.branch,
    '--title', title, '--body-file', bodyFile
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
