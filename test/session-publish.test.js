import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beginSessionPublish,
  commitSessionWork,
  createSessionPublishPlan,
  publishSessionWork
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

function planFor(root, overrides = {}) {
  return createSessionPublishPlan({
    flow: 'enhancement',
    brief: 'Add a command palette',
    id: '11111111-2222-3333-4444-555555555555',
    request: { publish: true, push: false, pr: false, ...overrides }
  });
}

test('session publishing refuses a dirty checkout before creating a branch', async (t) => {
  const root = createRepo();
  const before = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, 'scratch.txt'), 'dirty\n', 'utf8');

  const publish = planFor(root);

  await beginSessionPublish({ cwd: root, publish });

  assert.equal(publish.status, 'skipped');
  assert.match(publish.reason, /uncommitted changes/);
  assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), before);
});

test('session publishing creates the branch up front and commits on finish', async (t) => {
  const root = createRepo();
  const base = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const publish = planFor(root);

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await beginSessionPublish({ cwd: root, publish });

  assert.equal(publish.status, 'branch');
  assert.equal(publish.base, base);
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

  const pushed = await publishSessionWork({
    cwd: root,
    publish,
    title: 'feat: add a command palette',
    body: 'Body',
    dir: path.join(root, '.bug-fix', 'sessions', publish.sessionId)
  });

  assert.equal(pushed.status, 'committed');
});

test('session publishing pushes the branch and runs the merge request command', async (t) => {
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

  const publish = planFor(root, { push: true, pr: true });

  publish.prCommand = JSON.stringify([process.execPath, mrScript]);

  await beginSessionPublish({ cwd: root, publish });
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
    dir: path.join(root, '.bug-fix', 'sessions', publish.sessionId)
  });

  assert.equal(publish.status, 'published');
  assert.equal(publish.prUrl, 'https://forge.example/mr/1');
  assert.equal(
    git(remote, ['rev-parse', '--verify', `refs/heads/${publish.branch}`]).length > 0,
    true
  );
});
