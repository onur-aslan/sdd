import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applySettings,
  buildSweepArgs,
  checkJiraHealth,
  createJobManager,
  createStudioServer,
  detectVerifyCommand,
  formatStudioHelp,
  hasSavedToken,
  listJiraBugs,
  listJiraProjects,
  parseStudioArgs,
  readSettings,
  readStore,
  resolveStudioJira,
  STUDIO_AGENT_PRESETS,
  STUDIO_PR_PRESETS,
  writeSettings
} from '../cli/studio.js';
import { DEFAULT_AGENT_COMMAND } from '../cli/bug-sweep.js';
import { run } from '../cli/index.js';

const fakeFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    issues: [
      {
        key: 'ABC-1',
        id: '1',
        fields: {
          summary: 'Crash on save',
          description: 'Steps to reproduce',
          priority: { name: 'High' },
          status: { name: 'Open' },
          labels: ['bug']
        }
      },
      {
        key: 'ABC-2',
        id: '2',
        fields: {
          summary: 'Flaky login',
          description: 'Sometimes fails',
          priority: { name: 'Low' },
          status: { name: 'Open' },
          labels: []
        }
      }
    ],
    isLast: true
  }),
  text: async () => ''
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }

  return (result.stdout || '').trim();
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-studio-'));

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'studio@example.com']);
  git(root, ['config', 'user.name', 'Studio Bot']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'app.txt'), 'v1\n', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);

  return root;
}

function createFakeAgent(root) {
  if (process.platform === 'win32') {
    const scriptPath = path.join(root, 'fake-agent.cmd');

    fs.writeFileSync(scriptPath, [
      '@echo off',
      'if not "%SDD_BUG_KEY%"=="ABC-1" goto notfixed',
      '> "%SDD_BUG_RESULT_FILE%" echo {"key":"ABC-1","status":"fixed","summary":"Null guard","how":"Added a guard","critical":false,"evidence":["test"]}',
      'echo patched>> app.txt',
      'exit /b 0',
      ':notfixed',
      '> "%SDD_BUG_RESULT_FILE%" echo {"key":"ABC-2","status":"not-fixed","reason":"Could not reproduce"}',
      'exit /b 0',
      ''
    ].join('\r\n'), 'utf8');

    return scriptPath;
  }

  const scriptPath = path.join(root, 'fake-agent.sh');

  fs.writeFileSync(scriptPath, [
    '#!/bin/sh',
    'if [ "$SDD_BUG_KEY" = "ABC-1" ]; then',
    '  printf \'%s\\n\' \'{"key":"ABC-1","status":"fixed","summary":"Null guard","how":"Added a guard","critical":false,"evidence":["test"]}\' > "$SDD_BUG_RESULT_FILE"',
    '  printf \'patched\\n\' >> app.txt',
    'else',
    '  printf \'%s\\n\' \'{"key":"ABC-2","status":"not-fixed","reason":"Could not reproduce"}\' > "$SDD_BUG_RESULT_FILE"',
    'fi',
    'exit 0',
    ''
  ].join('\n'), 'utf8');
  fs.chmodSync(scriptPath, 0o755);

  return scriptPath;
}

async function waitFor(predicate, timeoutMs = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Timed out waiting for the condition.');
}

// A stand-in for a Claude Code process in stream-json mode. It reads the studio's
// user messages from stdin and answers each with an assistant message and the
// `result` that ends the turn, so the live engine can be tested without Claude.
function createFakeLiveAgent(reply) {
  return () => {
    const child = new EventEmitter();

    child.pid = 4242;
    child.killed = false;
    child.exitCode = null;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
      child.emit('close', 0);
      return true;
    };

    let buffer = '';
    let turn = 0;

    child.stdin.on('data', (chunk) => {
      buffer += chunk.toString();

      let index;

      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();

        buffer = buffer.slice(index + 1);

        if (!line) {
          continue;
        }

        let message;

        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        turn += 1;

        const text = reply(turn, message?.message?.content?.[0]?.text ?? '');

        child.stdout.write(`${JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] }
        })}\n`);
        child.stdout.write(`${JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: text
        })}\n`);
      }
    });

    return child;
  };
}

async function collectSession(base, prefix, id) {
  const response = await fetch(`${base}${prefix}/${id}`);

  return response.json();
}

test('parseStudioArgs reads the port, host, and open flag', () => {
  assert.deepEqual(parseStudioArgs([]), { help: false, port: 4321, host: '127.0.0.1', open: false });
  assert.deepEqual(parseStudioArgs(['--port=8080', '--host', '0.0.0.0', '--open']), {
    help: false,
    port: 8080,
    host: '0.0.0.0',
    open: true
  });
  assert.equal(parseStudioArgs(['--help']).help, true);
  assert.throws(() => parseStudioArgs(['--port', 'abc']), /positive integer/);
  assert.throws(() => parseStudioArgs(['--nope']), /Unknown option/);
});

test('buildSweepArgs turns a dashboard request into bug-sweep flags', () => {
  const args = buildSweepArgs({
    project: 'ABC',
    date: '2026-10-19',
    base: 'main',
    agentCmd: '["opencode"]',
    maxTurns: 3,
    dryRun: true,
    worktree: true,
    fetchBase: true,
    push: false,
    pr: false
  });

  assert.deepEqual(args, [
    '--project', 'ABC',
    '--date', '2026-10-19',
    '--base', 'main',
    '--agent-cmd', '["opencode"]',
    '--max-turns', '3',
    '--dry-run',
    '--worktree',
    '--fetch-base',
    '--no-push',
    '--no-pr'
  ]);

  assert.deepEqual(buildSweepArgs({ jql: 'project = ABC' }).slice(0, 2), ['--jql', 'project = ABC']);
});

test('formatStudioHelp documents the command', () => {
  const help = formatStudioHelp();

  assert.match(help, /sdd studio/);
  assert.match(help, /--port/);
});

test('the studio offers a one-click agent choice and forwards it', () => {
  assert.deepEqual(STUDIO_AGENT_PRESETS.map((agent) => agent.id), ['claude', 'cursor', 'opencode', 'codex', 'custom']);
  assert.equal(STUDIO_AGENT_PRESETS[0].command, DEFAULT_AGENT_COMMAND);
  assert.match(STUDIO_AGENT_PRESETS.find((agent) => agent.id === 'claude').command, /claude/);
  assert.equal(STUDIO_AGENT_PRESETS.find((agent) => agent.id === 'cursor').command, '["cursor-agent","-p","--force"]');
  assert.equal(STUDIO_AGENT_PRESETS.find((agent) => agent.id === 'custom').command, '');

  assert.deepEqual(
    buildSweepArgs({ project: 'ABC', agentCmd: STUDIO_AGENT_PRESETS.find((agent) => agent.id === 'claude').command }),
    ['--project', 'ABC', '--agent-cmd', '["claude","-p"]']
  );
  assert.deepEqual(
    buildSweepArgs({ project: 'ABC', agentCmd: STUDIO_AGENT_PRESETS.find((agent) => agent.id === 'cursor').command }),
    ['--project', 'ABC', '--agent-cmd', '["cursor-agent","-p","--force"]']
  );
});

test('the studio offers a one-click forge choice and forwards it', () => {
  assert.deepEqual(STUDIO_PR_PRESETS.map((preset) => preset.id), ['github', 'gitlab', 'gitlab-push', 'gitea', 'custom']);
  assert.equal(STUDIO_PR_PRESETS.find((preset) => preset.id === 'github').command, '');
  assert.equal(STUDIO_PR_PRESETS.find((preset) => preset.id === 'gitlab-push').command, '');

  const gitlab = STUDIO_PR_PRESETS.find((preset) => preset.id === 'gitlab').command;
  const argv = JSON.parse(gitlab);

  assert.deepEqual(argv.slice(0, 4), ['glab', 'mr', 'create', '--title']);
  assert.ok(argv.includes('{bodyFile}'));
  assert.ok(argv.includes('--yes'));

  assert.deepEqual(buildSweepArgs({ project: 'ABC', prCommand: gitlab }), ['--project', 'ABC', '--pr-cmd', gitlab]);
  assert.deepEqual(buildSweepArgs({ project: 'ABC', prCommand: '' }), ['--project', 'ABC']);
  assert.deepEqual(buildSweepArgs({ project: 'ABC', gitlabPush: true }), ['--project', 'ABC', '--gitlab-push']);
  assert.deepEqual(
    buildSweepArgs({ project: 'ABC', issues: ['ABC-2', 'ABC-1'] }),
    ['--project', 'ABC', '--issues', 'ABC-2,ABC-1']
  );
});

test('detectVerifyCommand reads the project scripts and package manager', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-studio-detect-'));

  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8');
    assert.equal(detectVerifyCommand(root), 'npm test');

    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '', 'utf8');
    assert.equal(detectVerifyCommand(root), 'pnpm test');

    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint .' } }),
      'utf8'
    );
    assert.equal(detectVerifyCommand(root), 'pnpm run lint');

    fs.rmSync(path.join(root, 'package.json'));
    assert.equal(detectVerifyCommand(root), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('settings remember the Jira connection locally but keep the token off the API', () => {
  const root = createRepo();

  try {
    const stored = writeSettings(root, {
      project: 'ABC',
      push: false,
      pr: true,
      jiraAuth: 'bearer',
      jiraCa: '/etc/ssl/jira-ca.pem',
      prCommand: 'glab mr create',
      agentPreset: 'claude',
      jiraToken: 'secret',
      jiraUrl: 'https://jira.internal',
      jiraEmail: 'bot@example.com'
    });

    assert.equal(stored.jiraToken, 'secret');
    assert.equal(hasSavedToken(root), true);

    const publicSettings = readSettings(root);

    assert.deepEqual(publicSettings, {
      project: 'ABC',
      push: false,
      pr: true,
      jiraAuth: 'bearer',
      jiraCa: '/etc/ssl/jira-ca.pem',
      prCommand: 'glab mr create',
      agentPreset: 'claude',
      jiraUrl: 'https://jira.internal',
      jiraEmail: 'bot@example.com'
    });
    assert.equal('jiraToken' in publicSettings, false);
    assert.equal(readStore(root).jiraToken, 'secret');
    assert.ok(fs.existsSync(path.join(root, '.bug-fix', '.gitignore')));
    assert.equal(git(root, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applySettings keeps the saved token when the form leaves it blank', () => {
  const merged = applySettings(
    { project: 'ABC', jiraToken: '' },
    { jiraToken: 'saved-token', jiraUrl: 'https://jira.internal', jiraAuth: 'bearer' }
  );

  assert.equal(merged.jiraToken, 'saved-token');
  assert.equal(merged.jiraUrl, 'https://jira.internal');
  assert.equal(merged.jiraAuth, 'bearer');
});

test('resolveStudioJira falls back to the locally saved connection', () => {
  const jira = resolveStudioJira(
    { jiraToken: '' },
    { jiraToken: 'saved', jiraUrl: 'https://jira.internal', jiraAuth: 'bearer', jiraApiVersion: '2' }
  );

  assert.equal(jira.token, 'saved');
  assert.equal(jira.url, 'https://jira.internal');
  assert.equal(jira.auth, 'bearer');
  assert.equal(jira.apiVersion, '2');
});

test('applySettings fills only the values a request leaves undefined', () => {
  const merged = applySettings(
    { project: 'ABC', jql: '' },
    { project: 'OLD', jql: 'project = OLD', agentPreset: 'claude', prCommand: 'glab mr create' }
  );

  assert.equal(merged.project, 'ABC');
  assert.equal(merged.jql, '');
  assert.equal(merged.agentPreset, 'claude');
  assert.equal(merged.prCommand, 'glab mr create');
});

test('listJiraProjects maps the Jira response and reports missing credentials', async () => {
  const fake = async () => ({
    ok: true,
    json: async () => ({ values: [{ key: 'ABC', name: 'Alpha Team' }] })
  });

  const listed = await listJiraProjects({
    jiraUrl: 'https://jira.example.com',
    jiraEmail: 'bot@example.com',
    jiraToken: 'secret',
    jiraAuth: 'basic',
    fetchImpl: fake
  });

  assert.deepEqual(listed.projects, [{ key: 'ABC', name: 'Alpha Team' }]);

  const missing = await listJiraProjects({ fetchImpl: fake });

  assert.equal(missing.configured, false);
  assert.deepEqual(missing.projects, []);
});

test('listJiraBugs returns the project bug list and reports missing credentials', async () => {
  const calls = [];
  const fake = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });

    return {
      ok: true,
      status: 200,
      json: async () => ({
        issues: [
          {
            key: 'ABC-2',
            fields: {
              summary: 'Crash on save',
              priority: { name: 'High' },
              status: { name: 'Open' },
              description: null
            }
          },
          {
            key: 'ABC-1',
            fields: {
              summary: 'Typo in the title',
              priority: { name: 'Low' },
              status: { name: 'Open' },
              description: null
            }
          }
        ]
      })
    };
  };

  const listed = await listJiraBugs({
    project: 'ABC',
    jiraUrl: 'https://jira.example.com',
    jiraToken: 'secret',
    fetchImpl: fake
  });

  assert.equal(listed.configured, true);
  assert.match(calls[0].body.jql, /project = "ABC"/);
  assert.deepEqual(listed.bugs.map((bug) => bug.key), ['ABC-2', 'ABC-1']);
  assert.equal(listed.bugs[0].summary, 'Crash on save');
  assert.equal(listed.bugs[0].status, 'Open');
  assert.equal(listed.bugs[0].url, 'https://jira.example.com/browse/ABC-2');

  const missing = await listJiraBugs({ project: 'ABC', fetchImpl: fake });

  assert.equal(missing.configured, false);
  assert.deepEqual(missing.bugs, []);
});

test('studio exposes health, config, and the dashboard assets', async (t) => {
  const root = createRepo();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const studio = createStudioServer({ cwd: root, version: '9.9.9', fetchImpl: fakeFetch });

  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve));

  const base = `http://127.0.0.1:${studio.server.address().port}`;

  t.after(() => studio.close());

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.version, '9.9.9');

  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.git.repo, true);
  assert.equal(config.cwd, root);
  assert.equal(config.defaults.verifyCommand, '');
  assert.ok(config.agents.some((agent) => agent.id === 'opencode'));
  assert.ok(config.agents.some((agent) => agent.id === 'cursor'));
  assert.equal(config.defaults.agentPreset, 'claude');
  assert.ok(config.prPresets.some((preset) => preset.id === 'gitlab'));
  assert.equal(config.defaults.prPreset, 'github');
  assert.deepEqual(config.settings, {});

  const saved = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'ABC', agentPreset: 'claude', verifyCmd: 'npm test', base: 'develop', fetchBase: false, prPreset: 'gitlab', jiraToken: 'secret' })
  });

  // verifyCmd is no longer a studio setting; the verify command is auto-detected.
  assert.deepEqual(
    (await saved.json()).settings,
    { project: 'ABC', agentPreset: 'claude', base: 'develop', fetchBase: false, prPreset: 'gitlab' }
  );

  const settings = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(settings.settings.project, 'ABC');
  assert.equal(settings.settings.base, 'develop');
  assert.equal(settings.settings.fetchBase, false);

  const configAfter = await (await fetch(`${base}/api/config`)).json();
  assert.equal(configAfter.settings.project, 'ABC');
  assert.equal(configAfter.settings.jiraToken, undefined);

  const projects = await fetch(`${base}/api/jira/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jiraUrl: 'https://jira.example.com', jiraEmail: 'bot@example.com', jiraToken: 'secret' })
  });
  const listed = await projects.json();
  assert.equal(listed.configured, true);
  assert.ok(Array.isArray(listed.projects));

  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /sdd <em>studio<\/em>/);

  const script = await (await fetch(`${base}/app.js`)).text();
  assert.match(script, /EventSource/);

  const styles = await (await fetch(`${base}/styles.css`)).text();
  assert.match(styles, /--accent/);

  const missing = await fetch(`${base}/api/nope`);
  assert.equal(missing.status, 404);
});

test('studio runs a sweep and streams structured progress events', async (t) => {
  const root = createRepo();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-studio-agent-'));

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  const agentPath = createFakeAgent(agentDir);
  const studio = createStudioServer({ cwd: root, version: '9.9.9', fetchImpl: fakeFetch });

  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve));

  const base = `http://127.0.0.1:${studio.server.address().port}`;

  t.after(() => studio.close());

  const started = await fetch(`${base}/api/sweeps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project: 'ABC',
      date: '2026-10-19',
      base: 'HEAD',
      agentCmd: JSON.stringify([agentPath]),
      push: false,
      pr: false,
      jiraUrl: 'https://jira.example.com',
      jiraEmail: 'bot@example.com',
      jiraToken: 'secret'
    })
  });

  assert.equal(started.status, 202);

  const { job } = await started.json();

  await waitFor(async () => {
    const current = await (await fetch(`${base}/api/sweeps/${job.id}`)).json();

    return current.job.status === 'done' || current.job.status === 'failed';
  });

  const final = await (await fetch(`${base}/api/sweeps/${job.id}`)).json();
  const events = final.job.events;
  const types = events.map((event) => event.type);

  assert.equal(final.job.status, 'done');
  assert.ok(types.includes('sweep-started'));
  assert.ok(types.includes('bugs-found'));
  assert.ok(types.includes('job-done'));

  const found = events.find((event) => event.type === 'bugs-found');
  assert.equal(found.total, 2);

  const fixed = events.find((event) => event.type === 'bug-finished' && event.key === 'ABC-1');
  assert.equal(fixed.status, 'fixed');
  assert.match(fixed.how, /guard/);

  const failed = events.find((event) => event.type === 'bug-finished' && event.key === 'ABC-2');
  assert.equal(failed.status, 'not-fixed');
  assert.match(failed.reason, /reproduce/);

  assert.equal(git(root, ['log', '-1', '--pretty=%s']), 'fix(ABC-1): Null guard');
  assert.equal(git(root, ['status', '--porcelain']), '');

  const settings = readSettings(root);

  assert.equal(settings.project, 'ABC');
  assert.equal(settings.jiraToken, undefined);
  assert.equal(settings.push, false);
});

test('the job manager refuses a second sweep while one is running', async (t) => {
  const root = createRepo();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-studio-agent-'));

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  const agentPath = createFakeAgent(agentDir);
  const manager = createJobManager({ cwd: root, fetchImpl: fakeFetch });
  const request = {
    project: 'ABC',
    date: '2026-10-19',
    base: 'HEAD',
    agentCmd: JSON.stringify([agentPath]),
    push: false,
    pr: false,
    jiraUrl: 'https://jira.example.com',
    jiraEmail: 'bot@example.com',
    jiraToken: 'secret'
  };

  const first = manager.startSweep(request);

  assert.throws(() => manager.startSweep(request), /already running/);

  await waitFor(() => first.status === 'done' || first.status === 'failed');
});

test('an enhancement session interviews one question at a time, then records the plan', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-studio-session-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Settings the session must remember rather than overwrite.
  writeSettings(root, { project: 'ABC', jiraToken: 'secret', settingsSeen: true });

  let calls = 0;
  const manager = createJobManager({
    cwd: root,
    // A non-Claude command uses the replay-per-turn engine: one prompt per turn.
    spawnImpl: async (command, args, options) => {      calls += 1;

      const text = calls === 1
        ? 'Let me start with storage.\n\n```interview\nLocal disk or a database?\n```\n'
        : '# Plan\n\nUse local disk.\n\n```mermaid\nflowchart LR\nA-->B\n```\n';

      options.onStdout(text);

      return { code: 0, stdout: text, stderr: '' };
    }
  });
  const job = manager.startEnhancement({
    brief: 'Add a command palette.',
    agentPreset: 'cursor',
    agentCmd: '["cursor-agent","-p"]'
  });

  assert.equal(job.type, 'enhancement');
  assert.equal(job.flow, 'enhancement');
  assert.throws(
    () => manager.startEnhancement({ brief: 'Another change.', agentCmd: '["cursor-agent","-p"]' }),
    /already running/
  );
  assert.throws(() => manager.startSweep({ project: 'ABC' }), /already running/);

  await waitFor(() => manager.snapshot(job).events.some((event) => event.type === 'question'));
  assert.equal(manager.snapshot(job).status, 'waiting');

  assert.equal(manager.submitInput(job.id, { answer: 'Local disk.' }), true);

  // The plan turn has no artifact, so the human ends the interview.
  await waitFor(() => manager.snapshot(job).events.filter((event) => event.type === 'question').length === 2);
  assert.equal(manager.submitInput(job.id, { done: true }), true);

  await waitFor(() => job.status === 'done');

  const snapshot = manager.snapshot(job);
  const events = snapshot.events;
  const types = events.map((event) => event.type);
  const output = events
    .filter((event) => event.type === 'output')
    .map((event) => event.chunk)
    .join('');

  assert.ok(types.includes('question'));
  assert.ok(types.includes('answer'));
  assert.ok(types.includes('job-done'));
  assert.match(output, /Local disk or a database\?/);
  assert.match(output, /# Plan/);
  assert.match(output, /```mermaid/);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));

  const saved = readSettings(root);

  assert.equal(saved.agentPreset, 'cursor');
  assert.equal(saved.agentCmd, '["cursor-agent","-p"]');
  // Remembering the agent must not drop the rest of the store.
  assert.equal(saved.project, 'ABC');
  assert.equal(saved.settingsSeen, true);
  assert.equal(readStore(root).jiraToken, 'secret');
});

test('a live Claude session streams questions and answers over one process', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-studio-live-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const manager = createJobManager({
    cwd: root,
    spawnProcess: createFakeLiveAgent((turn) => (
      turn === 1
        ? 'Which storage should we use?\n\n```interview\nLocal disk or a database?\n```\n'
        : '# Plan\n\nLocal disk it is.\n'
    )),
    terminate: (child) => child.kill?.()
  });
  const job = manager.startEnhancement({
    brief: 'Add a command palette.',
    agentPreset: 'claude',
    agentCmd: DEFAULT_AGENT_COMMAND
  });

  assert.equal(job.result, null);

  await waitFor(() => manager.snapshot(job).events.some((event) => event.type === 'question'));
  assert.equal(manager.snapshot(job).status, 'waiting');

  assert.equal(manager.submitInput(job.id, { answer: 'Local disk.' }), true);

  // The plan turn has no artifact, so the human ends the interview.
  await waitFor(() => manager.snapshot(job).events.filter((event) => event.type === 'question').length === 2);
  assert.equal(manager.submitInput(job.id, { done: true }), true);

  await waitFor(() => job.status === 'done');

  const events = manager.snapshot(job).events;
  const output = events
    .filter((event) => event.type === 'output' && event.stream === 'stdout')
    .map((event) => event.chunk)
    .join('');

  assert.match(output, /Local disk or a database\?/);
  assert.match(output, /# Plan/);
  assert.equal(job.result.engine, 'live');
  assert.equal(manager.snapshot(job).flow, 'enhancement');
});

test('the job manager routes a permission request to the browser', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-studio-perm-'));
  const spawnAgent = createFakeLiveAgent(() => '# Plan\n\nLocal disk.');

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const manager = createJobManager({
    cwd: root,
    spawnProcess: (command, args, options) => {
      // startSession picks the id, so the fake writes where the session reads.
      const dir = path.join(root, '.bug-fix', 'enhancements', options.env.SDD_SESSION_ID);

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'permission.json'),
        JSON.stringify({ id: 'p1', tool: 'Bash', detail: 'npm test' }),
        'utf8'
      );

      return spawnAgent(command, args, options);
    },
    terminate: (child) => child.kill?.()
  });
  const job = manager.startEnhancement({
    brief: 'Add a command palette.',
    agentPreset: 'claude',
    agentCmd: DEFAULT_AGENT_COMMAND
  });

  await waitFor(() => manager.snapshot(job).events.some((event) => event.type === 'permission'));

  const asked = manager.snapshot(job).events.find((event) => event.type === 'permission');

  assert.equal(asked.tool, 'Bash');
  assert.equal(asked.detail, 'npm test');
  assert.equal(manager.submitPermission(job.id, { id: asked.id, behavior: 'allow' }), true);
  // A second answer for the same request is refused instead of resolving twice.
  assert.equal(manager.submitPermission(job.id, { behavior: 'allow' }), false);

  await waitFor(() => manager.snapshot(job).events.some((event) => event.type === 'permission-answer'));

  const answered = manager.snapshot(job).events.find((event) => event.type === 'permission-answer');

  assert.equal(answered.behavior, 'allow');

  await waitFor(() => manager.snapshot(job).events.some((event) => event.type === 'question'));
  manager.submitInput(job.id, { done: true });

  await waitFor(() => job.status === 'done');
});

test('cancelling a session stops the live process', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-studio-live-cancel-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let killed = false;
  const manager = createJobManager({
    cwd: root,
    spawnProcess: createFakeLiveAgent(() => '```interview\nStill going?\n```\n'),
    terminate: (child) => {
      killed = true;
      child.kill?.();
    }
  });
  const job = manager.startEnhancement({
    brief: 'Add a command palette.',
    agentPreset: 'claude',
    agentCmd: DEFAULT_AGENT_COMMAND
  });

  await waitFor(() => manager.snapshot(job).events.some((event) => event.type === 'question'));

  assert.equal(manager.cancelJob(job.id), true);

  await waitFor(() => job.status === 'cancelled');
  assert.ok(killed);

  const types = manager.snapshot(job).events.map((event) => event.type);

  assert.ok(types.includes('job-cancelled'));
});


test('cancelling a sweep stops it and reports a cancelled job', async (t) => {
  const root = createRepo();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // An agent that never finishes on its own: it only resolves when the sweep is aborted.
  const spawnImpl = (command, args, options) => new Promise((resolve) => {
    options.signal?.addEventListener('abort', () => {
      resolve({ code: 1, stdout: '', stderr: '', timedOut: false, aborted: true });
    }, { once: true });
  });
  const manager = createJobManager({ cwd: root, fetchImpl: fakeFetch, spawnImpl });
  const job = manager.startSweep({
    project: 'ABC',
    date: '2026-10-19',
    base: 'HEAD',
    agentCmd: JSON.stringify(['fake-agent']),
    push: false,
    pr: false,
    jiraUrl: 'https://jira.example.com',
    jiraEmail: 'bot@example.com',
    jiraToken: 'secret'
  });

  await waitFor(() => manager.snapshot(job).events.some((event) => event.type === 'bug-started'));

  assert.equal(manager.cancelJob(job.id), true);

  await waitFor(() => job.status === 'cancelled');

  const events = manager.snapshot(job).events.map((event) => event.type);

  assert.ok(events.includes('sweep-cancelled'));
  assert.ok(events.includes('job-cancelled'));
  assert.equal(git(root, ['status', '--porcelain']), '');
});

test('the studio command routes through the CLI and prints its help', async () => {
  const help = await run(['studio', '--help']);

  assert.match(help, /SDD Studio/);

  const topLevel = await run(['--help']);

  assert.match(topLevel, /studio      Open the local web dashboard/);
});

test('buildSweepArgs forwards the air-gapped Jira and forge options', () => {
  const args = buildSweepArgs({
    project: 'ABC',
    jiraAuth: 'bearer',
    jiraApiVersion: '2',
    jiraCa: '/etc/ssl/jira-ca.pem',
    jiraInsecure: true,
    prCommand: 'glab mr create'
  });

  assert.deepEqual(args, [
    '--project', 'ABC',
    '--jira-auth', 'bearer',
    '--jira-api-version', '2',
    '--jira-ca', '/etc/ssl/jira-ca.pem',
    '--pr-cmd', 'glab mr create',
    '--jira-insecure'
  ]);
});

test('resolveStudioJira keeps auto auth when no email is set', () => {
  const jira = resolveStudioJira({ jiraUrl: 'https://jira.internal', jiraToken: 'pat' });

  assert.equal(jira.auth, 'auto');
  assert.equal(jira.email, '');
  assert.equal(jira.token, 'pat');
  assert.equal(jira.apiVersion, 'auto');
});

test('resolveStudioJira ignores an email unless Basic auth is selected', () => {
  const auto = resolveStudioJira({
    jiraUrl: 'https://jira.internal',
    jiraToken: 'pat',
    jiraEmail: 'bot@example.com'
  });

  assert.equal(auto.auth, 'auto');
  assert.equal(auto.email, '');

  const basic = resolveStudioJira({
    jiraUrl: 'https://jira.internal',
    jiraToken: 'pat',
    jiraEmail: 'bot@example.com',
    jiraAuth: 'basic'
  });

  assert.equal(basic.email, 'bot@example.com');
});

test('checkJiraHealth probes v2 with a bearer token', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });

    return {
      ok: true,
      status: 200,
      json: async () => ({ name: 'jdoe', displayName: 'Jane Doe' })
    };
  };

  const health = await checkJiraHealth({
    jiraUrl: 'https://jira.internal',
    jiraToken: 'pat',
    jiraApiVersion: '2',
    fetchImpl: fake
  });

  assert.equal(health.ok, true);
  assert.equal(health.apiVersion, '2');
  assert.equal(health.user.displayName, 'Jane Doe');
  assert.match(calls[0].url, /\/rest\/api\/2\/myself$/);
  assert.equal(calls[0].auth, 'Bearer pat');
});

test('checkJiraHealth reports missing credentials', async () => {
  const health = await checkJiraHealth({
    fetchImpl: async () => {
      throw new Error('should not be called');
    }
  });

  assert.equal(health.configured, false);
  assert.equal(health.ok, false);
});

test('POST /api/settings saves the Jira token locally and reuses it', async (t) => {
  const root = createRepo();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });

    return {
      ok: true,
      status: 200,
      json: async () => ({ name: 'jdoe', displayName: 'Jane Doe' })
    };
  };

  const studio = createStudioServer({ cwd: root, version: '9.9.9', fetchImpl: fake });

  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve));

  const base = `http://127.0.0.1:${studio.server.address().port}`;

  t.after(() => studio.close());

  const saved = await (await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jiraUrl: 'https://jira.internal',
      jiraToken: 'pat',
      jiraApiVersion: '2'
    })
  })).json();

  assert.equal(saved.hasSavedToken, true);
  assert.equal(saved.settings.jiraToken, undefined);
  assert.equal(saved.settings.jiraUrl, 'https://jira.internal');

  const config = await (await fetch(`${base}/api/config`)).json();

  assert.equal(config.jira.hasSavedToken, true);
  assert.equal(config.settings.jiraToken, undefined);

  // No token or auth in the body: the server reuses the saved token, and with no
  // email the default auth resolves to bearer.
  const health = await (await fetch(`${base}/api/jira/health`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })).json();

  assert.equal(health.ok, true);
  assert.equal(health.auth, 'bearer');
  assert.equal(health.apiVersion, '2');
  assert.equal(health.user.displayName, 'Jane Doe');
  assert.equal(calls[0].auth, 'Bearer pat');
  assert.match(calls[0].url, /\/rest\/api\/2\/myself$/);

  // An explicit empty token clears the saved credential.
  const cleared = await (await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jiraToken: '' })
  })).json();

  assert.equal(cleared.hasSavedToken, false);
});

test('studio runs interview sessions and keeps them separate from sweeps', async (t) => {
  const root = createRepo();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const studio = createStudioServer({
    cwd: root,
    version: '9.9.9',
    fetchImpl: fakeFetch,
    spawnProcess: createFakeLiveAgent((turn) => (
      turn === 1
        ? '```interview\nWhich storage?\n```\n'
        : '# Result\n\n```mermaid\nflowchart LR\nA-->B\n```\n'
    )),
    terminate: (child) => child.kill?.()
  });

  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve));

  const base = `http://127.0.0.1:${studio.server.address().port}`;

  t.after(() => studio.close());

  const empty = await fetch(`${base}/api/enhancements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brief: '   ' })
  });

  assert.equal(empty.status, 400);

  const started = await fetch(`${base}/api/enhancements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brief: 'Add a command palette.',
      agentPreset: 'claude',
      agentCmd: DEFAULT_AGENT_COMMAND
    })
  });

  assert.equal(started.status, 202);

  const { job } = await started.json();

  await waitFor(async () => (
    await collectSession(base, '/api/enhancements', job.id)
  ).job.status === 'waiting');

  // A second session while one is waiting is refused.
  const busy = await fetch(`${base}/api/features`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brief: 'A new feature.' })
  });

  assert.equal(busy.status, 409);

  const answered = await fetch(`${base}/api/jobs/${job.id}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: 'Local disk.' })
  });

  assert.equal(answered.status, 200);

  await waitFor(async () => (
    await collectSession(base, '/api/enhancements', job.id)
  ).job.status === 'waiting');

  // A plan has no artifact: the human finishes the session.
  await fetch(`${base}/api/jobs/${job.id}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: true })
  });

  await waitFor(async () => (
    await collectSession(base, '/api/enhancements', job.id)
  ).job.status === 'done');

  const final = await collectSession(base, '/api/enhancements', job.id);
  const types = final.job.events.map((event) => event.type);
  const output = final.job.events
    .filter((event) => event.type === 'output')
    .map((event) => event.chunk)
    .join('');

  assert.equal(final.job.flow, 'enhancement');
  assert.equal(final.job.status, 'done');
  assert.ok(types.includes('question'));
  assert.ok(types.includes('answer'));
  assert.ok(types.includes('job-done'));
  assert.match(output, /# Result/);
  assert.match(output, /```mermaid/);
  assert.ok(final.job.events.every((event) => Number.isInteger(event.seq)));

  // The feature tab runs the same engine under its own prefix.
  const feature = await fetch(`${base}/api/features`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brief: 'Add saved searches.',
      agentPreset: 'claude',
      agentCmd: DEFAULT_AGENT_COMMAND
    })
  });

  assert.equal(feature.status, 202);

  const featureJob = (await feature.json()).job;

  await waitFor(async () => (
    await collectSession(base, '/api/features', featureJob.id)
  ).job.status === 'waiting');

  await fetch(`${base}/api/jobs/${featureJob.id}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: 'Yes.' })
  });

  await waitFor(async () => (
    await collectSession(base, '/api/features', featureJob.id)
  ).job.status === 'waiting');

  await fetch(`${base}/api/jobs/${featureJob.id}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: true })
  });

  await waitFor(async () => (
    await collectSession(base, '/api/features', featureJob.id)
  ).job.status === 'done');

  const features = await (await fetch(`${base}/api/features`)).json();
  const sessions = await (await fetch(`${base}/api/enhancements`)).json();
  const sweeps = await (await fetch(`${base}/api/sweeps`)).json();

  assert.equal(features.jobs.length, 1);
  assert.equal(features.jobs[0].flow, 'feature');
  assert.equal(sessions.jobs.length, 1);
  assert.equal(sweeps.jobs.length, 0);

  // Session ids do not leak across prefixes.
  assert.equal((await fetch(`${base}/api/features/${job.id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/enhancements/nope`)).status, 404);

  const markdown = await fetch(`${base}/markdown.js`);

  assert.equal(markdown.status, 200);
  assert.match(await markdown.text(), /SDDMarkdown/);

  const license = await fetch(`${base}/vendor/mermaid/LICENSE`);

  assert.equal(license.status, 200);
});
