import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  commitSessionWork,
  createSessionPublishPlan,
  publishSessionWork,
  sessionBranchName,
  sessionSlug
} from '../cli/session-publish.js';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }

  return (result.stdout || '').trim();
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-session-publish-'));

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'studio@example.com']);
  git(root, ['config', 'user.name', 'Studio Bot']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'app.txt'), 'v1\n', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);

  return root;
}

function planFor(overrides = {}) {
  return createSessionPublishPlan({
    flow: 'enhancement',
    brief: 'Add a command palette',
    id: '11111111-2222-3333-4444-555555555555',
    request: { publish: true, mr: false, ...overrides }
  });
}

// A session worktree is created before the agent starts. The tests do the same
// work in the checkout: cut the session branch and tag its starting point.
function beginOnBranch(root, publish) {
  const base = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);

  git(root, ['checkout', '-q', '-b', publish.branch]);
  publish.base = base;
  publish.startedSha = git(root, ['rev-parse', 'HEAD']);
  publish.status = 'branch';

  return publish;
}

test('the session branch name carries the flow, a brief slug, the date, and a short id', () => {
  assert.equal(
    sessionBranchName({
      flow: 'enhancement',
      brief: 'Add a command palette!',
      id: '11111111-2222-3333-4444-555555555555',
      date: new Date(2026, 9, 19)
    }),
    'sdd/enhancement/add-a-command-palette-20261019-111111'
  );
  assert.equal(sessionSlug('  ***  '), 'change');
  assert.match(
    sessionBranchName({ flow: 'feature', brief: 'Saved searches', date: new Date(2026, 9, 19) }),
    /^sdd\/feature\/saved-searches-20261019$/
  );
});

test('the publish plan is plain data and defaults to a push with an MR', () => {
  const plan = createSessionPublishPlan({
    flow: 'feature',
    brief: 'Add saved searches',
    id: 'abcdef12-0000-0000-0000-000000000000',
    request: {},
    saved: { mr: true, prPreset: 'gitlab', prCommand: 'glab mr create' }
  });

  assert.equal(plan.enabled, true);
  assert.equal(plan.flow, 'feature');
  assert.equal(plan.push, true);
  assert.equal(plan.pr, true);
  assert.equal(plan.status, 'idle');
  assert.equal(plan.prPreset, 'gitlab');
  assert.equal(plan.prCommand, 'glab mr create');
  assert.match(plan.branch, /^sdd\/feature\/add-saved-searches-\d{8}-abcdef$/);

  const noMr = planFor({ mr: true });
  const withoutMr = planFor({ mr: false });

  assert.equal(noMr.pr, true);
  assert.equal(withoutMr.pr, false);
});

test('the session commits its work on the branch it started from', async (t) => {
  const root = createRepo();
  const publish = beginOnBranch(root, planFor());

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), publish.branch);

  fs.writeFileSync(path.join(root, 'palette.txt'), 'Search everything.\n', 'utf8');

  await commitSessionWork({
    cwd: root,
    publish,
    title: 'feat: add a command palette',
    body: 'SDD studio enhancement session.'
  });

  assert.equal(publish.status, 'committed');
  assert.match(git(root, ['log', '-1', '--format=%s']), /command palette/);
  assert.equal(git(root, ['status', '--porcelain']), '');

  publish.push = false;

  const pushed = await publishSessionWork({
    cwd: root,
    publish,
    title: 'feat: add a command palette',
    body: 'Body',
    dir: path.join(root, '.sdd', 'sessions', 'enhancement', publish.sessionId)
  });

  assert.equal(pushed.status, 'committed');
});

test('the session keeps a commit the agent made on its own branch', async (t) => {
  const root = createRepo();
  const publish = beginOnBranch(root, planFor());

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, 'palette.txt'), 'Search everything.\n', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'agent: implement palette']);

  await commitSessionWork({
    cwd: root,
    publish,
    title: 'feat: add a command palette',
    body: 'SDD studio enhancement session.'
  });

  assert.equal(publish.status, 'committed');
  assert.equal(publish.commits.length, 1);
  assert.equal(publish.commit, git(root, ['rev-parse', 'HEAD']));
  assert.match(git(root, ['log', '-1', '--format=%s']), /agent: implement palette/);
  assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), publish.branch);
});

test('an idle session reports that there was nothing to commit', async (t) => {
  const root = createRepo();
  const publish = beginOnBranch(root, planFor());

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await commitSessionWork({
    cwd: root,
    publish,
    title: 'feat: add a command palette',
    body: 'Body'
  });

  assert.equal(publish.status, 'no-changes');
  assert.match(publish.reason, /nothing to commit/i);
  assert.equal(publish.commits.length, 0);
});

test('the session pushes the branch and runs the merge request command', async (t) => {
  const root = createRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-session-remote-'));
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-session-tools-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));

  git(remote, ['init', '--bare', '-q']);
  git(root, ['remote', 'add', 'origin', remote]);

  const mrScript = path.join(tools, 'open-mr.js');

  fs.writeFileSync(mrScript, "console.log('https://forge.example/mr/1');\n", 'utf8');

  const publish = beginOnBranch(root, planFor({ mr: true }));

  publish.prCommand = JSON.stringify([process.execPath, mrScript]);

  fs.writeFileSync(path.join(root, 'palette.txt'), 'Search everything.\n', 'utf8');

  await commitSessionWork({
    cwd: root,
    publish,
    title: 'feat: add a command palette',
    body: 'Body'
  });

  await publishSessionWork({
    cwd: root,
    publish,
    title: 'feat: add a command palette',
    body: 'Body',
    dir: path.join(root, '.sdd', 'sessions', 'enhancement', publish.sessionId)
  });

  assert.equal(publish.status, 'published');
  assert.equal(publish.prUrl, 'https://forge.example/mr/1');
  assert.equal(
    git(remote, ['rev-parse', '--verify', `refs/heads/${publish.branch}`]).length > 0,
    true
  );
});
