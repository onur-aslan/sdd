import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.resolve(here, '..', 'cli', 'session-hook.js');

function runHook(requestFile, waitMs, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook, requestFile, String(waitMs)], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', () => resolve(stdout.trim()));
    child.stdin.end(JSON.stringify(input));
  });
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  throw new Error('Timed out waiting for the hook.');
}

test('the permission hook publishes the request and reports an allow', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-hook-'));
  const requestFile = path.join(root, 'permission.json');

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const pending = runHook(requestFile, 5000, {
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm install left-pad' }
  });

  await waitFor(() => fs.existsSync(requestFile));

  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));

  assert.equal(request.tool, 'Bash');
  assert.equal(request.detail, 'npm install left-pad');

  fs.writeFileSync(`${requestFile}.answer`, JSON.stringify({ behavior: 'allow' }), 'utf8');

  assert.match(await pending, /"behavior":"allow"/);
  assert.equal(fs.existsSync(requestFile), false);
});

test('the permission hook reports a deny, and stays silent when nobody answers', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-hook-'));
  const requestFile = path.join(root, 'permission.json');

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const denied = runHook(requestFile, 5000, {
    hook_event_name: 'PermissionRequest',
    tool_name: 'Write',
    tool_input: { file_path: 'C:/repo/src/app.js' }
  });

  await waitFor(() => fs.existsSync(requestFile));
  fs.writeFileSync(`${requestFile}.answer`, JSON.stringify({ behavior: 'deny' }), 'utf8');

  assert.match(await denied, /"behavior":"deny"/);

  // Silence is the safe default: Claude Code denies the tool on its own.
  const silent = await runHook(requestFile, 400, {
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: {}
  });

  assert.equal(silent, '');
  assert.equal(fs.existsSync(requestFile), false);
});
