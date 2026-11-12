import fs from 'node:fs';
import path from 'node:path';

import { runProcess } from './bug-sweep.js';
import { sessionBranchName } from './session-publish.js';

// Every live session owns one worktree. The main checkout is only used for
// bug-sweep and for the explicit merge land action.
export const WORKTREE_DIR = path.join('.sdd', 'worktrees');

export function worktreesRoot(cwd) {
  return path.resolve(cwd, WORKTREE_DIR);
}

export function sessionWorktreePath(cwd, id) {
  return path.join(worktreesRoot(cwd), String(id));
}

function gitError(args, result) {
  const detail = (result.stderr || result.stdout || '').trim();

  return new Error(`git ${args.join(' ')} failed (${result.code})${detail ? `: ${detail}` : ''}`);
}

async function git(cwd, args, { allowFailure = false, run = runProcess } = {}) {
  const result = await run('git', args, { cwd, timeoutMs: 120000 });

  if (!allowFailure && result.code !== 0) {
    throw gitError(args, result);
  }

  return result;
}

async function refExists(cwd, ref, run) {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true, run });

  return result.code === 0;
}

export async function detectBaseBranch(cwd, run = runProcess) {
  const remoteHead = await git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
    allowFailure: true,
    run
  });

  if (remoteHead.code === 0 && remoteHead.stdout.trim()) {
    return remoteHead.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  }

  for (const candidate of ['main', 'master']) {
    if (await refExists(cwd, `refs/heads/${candidate}`, run)) {
      return candidate;
    }
  }

  const current = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true, run });

  return current.code === 0 ? current.stdout.trim() : '';
}

// A base is valid when it resolves locally or through origin. The worktree is
// always created from the base ref, never from whatever the main checkout has
// checked out.
export async function resolveBaseRef(cwd, base, run = runProcess) {
  const requested = String(base ?? '').trim();

  if (!requested) {
    const detected = await detectBaseBranch(cwd, run);

    if (!detected) {
      const error = new Error('Could not detect a base branch for this session.');
      error.statusCode = 400;
      throw error;
    }

    return resolveBaseRef(cwd, detected, run);
  }

  const local = requested.replace(/^origin\//, '');

  if (await refExists(cwd, `refs/heads/${local}`, run)) {
    return { base: local, ref: local };
  }

  if (await refExists(cwd, `refs/remotes/origin/${local}`, run)) {
    return { base: local, ref: `origin/${local}` };
  }

  const error = new Error(`The base branch "${local}" does not exist locally or on origin.`);
  error.statusCode = 400;
  throw error;
}

async function nextBranchName(cwd, branch, run) {
  let candidate = branch;
  let suffix = 2;

  while (await refExists(cwd, `refs/heads/${candidate}`, run)) {
    candidate = `${branch}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

// Create `.sdd/worktrees/<session-id>` from the chosen base and a new session
// branch. Nothing in the main checkout is switched or touched.
export async function createSessionWorktree({
  cwd,
  id,
  flow,
  brief,
  base,
  branch,
  run = runProcess
} = {}) {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true, run });

  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    const error = new Error('The Studio is not running inside a git repository, so it cannot create a worktree.');
    error.statusCode = 400;
    throw error;
  }

  const resolved = await resolveBaseRef(cwd, base, run);
  const root = worktreesRoot(cwd);
  const worktreePath = sessionWorktreePath(cwd, id);

  fs.mkdirSync(root, { recursive: true });

  if (fs.existsSync(worktreePath)) {
    await removeSessionWorktree({ cwd, worktreePath, run, deleteBranch: false });
  }

  const requestedBranch = branch || sessionBranchName({ flow, brief, id });
  const branchName = await nextBranchName(cwd, requestedBranch, run);
  const added = await git(cwd, ['worktree', 'add', '-b', branchName, worktreePath, resolved.ref], {
    allowFailure: true,
    run
  });

  if (added.code !== 0) {
    throw gitError(['worktree', 'add', branchName, resolved.ref], added);
  }

  const head = await git(worktreePath, ['rev-parse', 'HEAD'], { allowFailure: true, run });

  return {
    path: worktreePath,
    branch: branchName,
    base: resolved.base,
    baseRef: resolved.ref,
    startedSha: head.code === 0 ? head.stdout.trim() : ''
  };
}

// Remove the worktree on success, failure, and stop. A failed or stopped
// session also loses its branch; a successful session keeps the pushed branch.
export async function removeSessionWorktree({
  cwd,
  worktreePath,
  branch = '',
  deleteBranch = false,
  run = runProcess
} = {}) {
  if (!worktreePath) {
    return false;
  }

  const removed = await git(cwd, ['worktree', 'remove', '--force', worktreePath], {
    allowFailure: true,
    run
  });

  if (removed.code !== 0) {
    // Windows can keep a handle open briefly. Removing the directory directly
    // and pruning the administrative entry still leaves no orphan behind.
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // Best effort: prune still removes a missing administration entry.
    }

    await git(cwd, ['worktree', 'prune'], { allowFailure: true, run });
  }

  if (deleteBranch && branch) {
    await git(cwd, ['branch', '-D', branch], { allowFailure: true, run });
  }

  return true;
}

// Studio startup passes every known active session id. Anything else under
// `.sdd/worktrees` is an orphan from an earlier process and is removed.
export async function cleanupOrphanWorktrees(cwd, { keep = [], run = runProcess } = {}) {
  const root = worktreesRoot(cwd);
  let entries;

  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const keepIds = new Set([...keep].map(String));
  const removed = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || keepIds.has(entry.name)) {
      continue;
    }

    const worktreePath = path.join(root, entry.name);

    await removeSessionWorktree({ cwd, worktreePath, run });
    removed.push(worktreePath);
  }

  await git(cwd, ['worktree', 'prune'], { allowFailure: true, run });

  return removed;
}

// specIssue never commits or pushes. Its spec is copied into the main checkout
// before the worktree is removed, so the tracker handoff reads a stable file.
export function copySpecToMainCheckout({ cwd, source, featureName = '' } = {}) {
  const name = String(featureName || path.basename(path.dirname(String(source ?? ''))) || 'feature').trim();
  const destination = path.join(path.resolve(cwd, 'docs', 'sdd', 'features'), name, 'spec.md');

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);

  return destination;
}
