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
  fetchJiraIssue,
  formatStudioHelp,
  hasSavedToken,
  listJiraBugs,
  listJiraIssues,
  listJiraProjects,
  parseStudioArgs,
  publicSettings,
  readSettings,
  readStore,
  resolveSpecIssueTarget,
  resolveStudioJira,
  shouldOpenBrowser,
  STUDIO_PR_PRESETS,
  writeSettings
} from '../cli/studio.js';
import {
  defaultWorkflowSettings,
  normalizeClaudeEnv,
  parseClaudeModelList,
  resolveWorkflowSelection
} from '../cli/agent-config.js';
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
  for (const skill of ['enhancement', 'deep-spec', 'merge', 'bug-sweep', 'bug-fix', 'sdd-developer', 'spec-to-task', 'feature-tdd']) {
    const skillFile = path.join(root, '.claude', 'skills', skill, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, `---\nname: ${skill}\ndescription: Test fixture skill.\n---\n`, 'utf8');
  }
  fs.writeFileSync(path.join(root, 'app.txt'), 'v1\n', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);

  return root;
}

// A stand-in for the one-shot bug-sweep Claude call. The real sweep passes a
// short skill prompt; the orchestrator owns the JSON result file and git.
function fakeSweepAgent() {
  return async (command, args, options = {}) => {
    const env = options.env ?? {};
    const key = env.SDD_BUG_KEY;

    if (key === 'ABC-1') {
      fs.writeFileSync(
        env.SDD_BUG_RESULT_FILE,
        JSON.stringify({
          key: 'ABC-1',
          status: 'fixed',
          summary: 'Null guard',
          how: 'Added a guard',
          critical: false,
          evidence: ['test']
        }),
        'utf8'
      );
      fs.appendFileSync(path.join(options.cwd, 'app.txt'), 'patched\n', 'utf8');
    } else {
      fs.writeFileSync(
        env.SDD_BUG_RESULT_FILE,
        JSON.stringify({ key, status: 'not-fixed', reason: 'Could not reproduce' }),
        'utf8'
      );
    }

    options.onStdout?.('');

    return { code: 0, stdout: '', stderr: '' };
  };
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
  return (command, args, options) => {
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

        const text = reply(turn, message?.message?.content?.[0]?.text ?? '', options);

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

test('parseStudioArgs reads the port, host, and browser choice', () => {
  // null means "open when the terminal is interactive"; tests and pipes stay quiet.
  assert.deepEqual(parseStudioArgs([]), { help: false, port: 4321, host: '127.0.0.1', open: null });
  assert.deepEqual(parseStudioArgs(['--port=8080', '--host', '0.0.0.0', '--open']), {
    help: false,
    port: 8080,
    host: '0.0.0.0',
    open: true
  });
  assert.deepEqual(parseStudioArgs(['--no-open']), {
    help: false,
    port: 4321,
    host: '127.0.0.1',
    open: false
  });
  assert.equal(parseStudioArgs(['--help']).help, true);
  assert.throws(() => parseStudioArgs(['--port', 'abc']), /positive integer/);
  assert.throws(() => parseStudioArgs(['--nope']), /Unknown option/);
});

test('the studio opens the browser for people, not for pipes or CI', () => {
  // Default: an interactive terminal gets the dashboard, everything else does not.
  assert.equal(shouldOpenBrowser({ open: null }, { isTTY: true, env: {} }), true);
  assert.equal(shouldOpenBrowser({ open: null }, { isTTY: false, env: {} }), false);
  assert.equal(shouldOpenBrowser({ open: null }, { isTTY: true, env: { CI: '1' } }), false);

  // Explicit flags always win.
  assert.equal(shouldOpenBrowser({ open: true }, { isTTY: false, env: {} }), true);
  assert.equal(shouldOpenBrowser({ open: false }, { isTTY: true, env: {} }), false);
});

test('buildSweepArgs turns a dashboard request into bug-sweep flags', () => {
  const args = buildSweepArgs({
    project: 'ABC',
    date: '2026-10-19',
    base: 'main',
    maxTurns: 3,
    dryRun: true,
    worktree: true,
    fetchBase: true,
    closeIssues: true,
    publish: 'commit'
  });

  assert.deepEqual(args, [
    '--project', 'ABC',
    '--date', '2026-10-19',
    '--base', 'main',
    '--max-turns', '3',
    '--dry-run',
    '--worktree',
    '--fetch-base',
    '--close-issues',
    '--no-pr'
  ]);

  assert.deepEqual(buildSweepArgs({ publish: 'pr' }), []);
  assert.deepEqual(buildSweepArgs({ publish: 'push' }), ['--no-pr']);
  // Commit-only is retired: the studio always pushes the branch.
  assert.deepEqual(buildSweepArgs({ publish: 'commit' }), ['--no-pr']);

  // Settings written before the single Publish choice also always push.
  assert.deepEqual(buildSweepArgs({ pr: false }), ['--no-pr']);
  assert.deepEqual(buildSweepArgs({ push: false }), ['--no-pr']);

  assert.deepEqual(buildSweepArgs({ jql: 'project = ABC' }).slice(0, 2), ['--jql', 'project = ABC']);
});

test('formatStudioHelp documents the command', () => {
  const help = formatStudioHelp();

  assert.match(help, /sdd studio/);
  assert.match(help, /--port/);
});

test('the workflow selection resolves model, effort, and the Claude environment', () => {
  const selection = resolveWorkflowSelection(
    {
      claudeEnv: {
        ANTHROPIC_BASE_URL: 'https://proxy.example',
        ANTHROPIC_MODEL: 'nim-model',
        ANTHROPIC_AUTH_TOKEN: 'secret',
        PATH: '/not-allowed'
      },
      workflows: {}
    },
    'enhancement',
    { model: 'nim-model', effort: 'high', mr: false }
  );

  assert.equal(selection.provider, undefined);
  assert.equal(selection.model, 'nim-model');
  assert.equal(selection.effort, 'high');
  assert.equal(selection.mr, false);
  assert.deepEqual(selection.args, ['--model', 'nim-model', '--effort', 'high']);
  assert.deepEqual(selection.environment, {
    ANTHROPIC_BASE_URL: 'https://proxy.example',
    ANTHROPIC_MODEL: 'nim-model',
    ANTHROPIC_AUTH_TOKEN: 'secret'
  });

  // Default is "send no flag"; any gateway model id is accepted because there
  // is no built-in catalog to validate against.
  const defaults = resolveWorkflowSelection({}, 'feature', { model: 'Default', effort: 'Default' });
  assert.deepEqual(defaults.args, []);
  assert.equal(
    resolveWorkflowSelection({}, 'feature', { model: 'some-custom-model' }).model,
    'some-custom-model'
  );
  assert.throws(
    () => resolveWorkflowSelection({}, 'feature', { effort: 'extreme' }),
    /Unknown effort/
  );

  assert.deepEqual(normalizeClaudeEnv({ ANTHROPIC_MODEL: 'nim-model', PATH: '/bad', CLAUDE_CODE_USE_BEDROCK: '' }), {
    ANTHROPIC_MODEL: 'nim-model'
  });

  const listed = parseClaudeModelList(
    'Current model: `nim-model`\nUsage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.',
    { ANTHROPIC_MODEL: 'nim-model' }
  );

  assert.equal(listed.current, 'nim-model');
  assert.ok(listed.models.includes('sonnet'));
  assert.ok(listed.models.includes('nim-model'));

  const saved = publicSettings({
    claudeEnv: {
      ANTHROPIC_MODEL: 'nim-model',
      ANTHROPIC_AUTH_TOKEN: 'secret'
    },
    workflows: {
      enhancement: { model: 'nim-model', effort: 'max', mr: false }
    }
  });

  assert.equal(saved.claudeEnv.ANTHROPIC_MODEL, 'nim-model');
  assert.equal(saved.claudeEnv.ANTHROPIC_AUTH_TOKEN, '');
  assert.deepEqual(saved.claudeEnvSecrets, ['ANTHROPIC_AUTH_TOKEN']);
  assert.equal(saved.workflows.enhancement.model, 'nim-model');
  assert.equal(saved.workflows.enhancement.effort, 'max');
  assert.equal(saved.workflows.enhancement.mr, false);
  assert.equal('provider' in saved.workflows.enhancement, false);
  assert.equal(saved.workflows.feature.mr, true);
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
    const workflows = defaultWorkflowSettings();

    workflows.enhancement = {
      model: 'nim-model',
      effort: 'high',
      mr: false
    };

    const stored = writeSettings(root, {
      project: 'ABC',
      push: false,
      pr: true,
      closeIssues: true,
      jiraAuth: 'bearer',
      jiraCa: '/etc/ssl/jira-ca.pem',
      prCommand: 'glab mr create',
      claudeEnv: {
        ANTHROPIC_MODEL: 'nim-model',
        ANTHROPIC_AUTH_TOKEN: 'secret-env'
      },
      workflows,
      agentPreset: 'claude',
      jiraToken: 'secret',
      jiraUrl: 'https://jira.internal',
      jiraEmail: 'bot@example.com'
    });

    assert.equal(stored.jiraToken, 'secret');
    // The retired agent selection is ignored instead of being written again.
    assert.equal('agentPreset' in stored, false);
    assert.equal('providers' in stored, false);
    assert.equal(hasSavedToken(root), true);

    const publicSettings = readSettings(root);

    assert.deepEqual(publicSettings, {
      project: 'ABC',
      push: false,
      pr: true,
      closeIssues: true,
      jiraAuth: 'bearer',
      jiraCa: '/etc/ssl/jira-ca.pem',
      prCommand: 'glab mr create',
      claudeEnv: {
        ANTHROPIC_MODEL: 'nim-model',
        ANTHROPIC_AUTH_TOKEN: ''
      },
      claudeEnvSecrets: ['ANTHROPIC_AUTH_TOKEN'],
      workflows,
      jiraUrl: 'https://jira.internal',
      jiraEmail: 'bot@example.com'
    });
    assert.equal('jiraToken' in publicSettings, false);
    assert.equal(readStore(root).jiraToken, 'secret');
    assert.ok(fs.existsSync(path.join(root, '.sdd', 'studio.settings.json')));
    assert.ok(fs.existsSync(path.join(root, '.sdd', '.gitignore')));
    assert.equal(fs.existsSync(path.join(root, '.bug-fix', 'studio.settings.json')), false);
    assert.equal(git(root, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('settings left under the bug-sweep work dir move to the studio state dir', () => {
  const root = createRepo();

  try {
    const legacy = path.join(root, '.bug-fix', 'studio.settings.json');

    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ project: 'ABC', agentPreset: 'cursor', jiraToken: 'secret' }), 'utf8');

    assert.deepEqual(readSettings(root), {
      project: 'ABC',
      claudeEnv: {},
      claudeEnvSecrets: [],
      workflows: defaultWorkflowSettings()
    });
    assert.equal(readStore(root).jiraToken, 'secret');
    assert.ok(fs.existsSync(path.join(root, '.sdd', 'studio.settings.json')));
    assert.ok(fs.existsSync(path.join(root, '.sdd', '.gitignore')));
    assert.equal(fs.existsSync(legacy), false);
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
  const workflows = defaultWorkflowSettings();

  workflows.feature = {
    model: 'nim-model',
    effort: 'max',
    mr: false
  };

  const merged = applySettings(
    { project: 'ABC', jql: '' },
    { project: 'OLD', jql: 'project = OLD', workflows, prCommand: 'glab mr create' }
  );

  assert.equal(merged.project, 'ABC');
  assert.equal(merged.jql, '');
  assert.deepEqual(merged.workflows, workflows);
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

test('listJiraIssues and fetchJiraIssue read the project picker and one brief', async () => {
  const calls = [];
  const fake = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });

    return {
      ok: true,
      status: 200,
      json: async () => ({
        issues: [
          {
            key: 'ABC-7',
            fields: {
              summary: 'Saved searches',
              description: 'Put saved searches in the sidebar.',
              priority: { name: 'Medium' },
              status: { name: 'In Progress' },
              issuetype: { name: 'Story' },
              labels: []
            }
          }
        ]
      })
    };
  };

  const listed = await listJiraIssues({
    project: 'ABC',
    jiraUrl: 'https://jira.example.com',
    jiraToken: 'secret',
    fetchImpl: fake
  });

  assert.match(calls[0].body.jql, /project = "ABC"/);
  assert.match(calls[0].body.jql, /statusCategory != Done/);
  assert.deepEqual(listed.issues, [{
    key: 'ABC-7',
    summary: 'Saved searches',
    type: 'Story',
    priority: 'Medium',
    status: 'In Progress',
    url: 'https://jira.example.com/browse/ABC-7'
  }]);

  const detail = await fetchJiraIssue({
    key: 'abc-7',
    jiraUrl: 'https://jira.example.com',
    jiraToken: 'secret',
    fetchImpl: fake
  });

  assert.equal(detail.issue.key, 'ABC-7');
  assert.match(detail.issue.description, /sidebar/);
  assert.equal(calls[1].body.jql, 'key = ABC-7');

  const invalid = await fetchJiraIssue({
    key: 'not a key',
    jiraUrl: 'https://jira.example.com',
    jiraToken: 'secret',
    fetchImpl: fake
  });

  assert.equal(invalid.issue, null);
  assert.match(invalid.error, /ABC-123/);
  assert.equal(calls.length, 2);
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
  assert.equal(config.providers, undefined);
  assert.deepEqual(config.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(config.workflowsAvailable, ['enhancement', 'feature', 'specIssue', 'merge', 'bugSweep']);
  assert.equal(config.workflows.enhancement.model, '');
  assert.equal(config.workflows.enhancement.effort, '');
  assert.equal('provider' in config.workflows.enhancement, false);
  assert.deepEqual(config.settings.claudeEnv, {});
  assert.deepEqual(config.settings.claudeEnvSecrets, []);
  assert.equal(config.defaults.agentPreset, undefined);
  assert.match(config.defaults.branch, /^bug-fix\/.+\/sdd-studio$/);
  assert.equal(config.defaults.tag, null);
  assert.ok(config.prPresets.some((preset) => preset.id === 'gitlab'));
  assert.equal(config.defaults.prPreset, 'github');
  assert.deepEqual(config.featurePipelines.map((pipeline) => pipeline.id), ['direct', 'tdd']);
  assert.equal(config.settings.agentPreset, undefined);
  assert.deepEqual(config.settings.claudeEnv, {});
  assert.ok(config.settings.workflows.feature);

  const saved = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project: 'ABC',
      agentPreset: 'claude',
      verifyCmd: 'npm test',
      base: 'develop',
      publish: 'commit',
      prPreset: 'gitlab',
      claudeEnv: { ANTHROPIC_MODEL: 'nim-model', ANTHROPIC_AUTH_TOKEN: 'secret' },
      jiraToken: 'secret'
    })
  });

  // verifyCmd and the old agent preset are no longer studio settings.
  const savedBody = await saved.json();

  assert.equal(savedBody.settings.project, 'ABC');
  assert.equal(savedBody.settings.base, 'develop');
  assert.equal(savedBody.settings.publish, 'push');
  assert.equal(savedBody.settings.prPreset, 'gitlab');
  assert.equal(savedBody.settings.agentPreset, undefined);
  assert.equal(savedBody.settings.claudeEnv.ANTHROPIC_MODEL, 'nim-model');
  assert.equal(savedBody.settings.claudeEnv.ANTHROPIC_AUTH_TOKEN, '');
  assert.deepEqual(savedBody.settings.claudeEnvSecrets, ['ANTHROPIC_AUTH_TOKEN']);

  const settings = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(settings.settings.project, 'ABC');
  assert.equal(settings.settings.base, 'develop');
  assert.equal(settings.settings.publish, 'push');

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

  // Settings is shared by every workflow, so its tracker targets are not
  // filtered by the bug sweep's source, and the rail reports all of them
  // instead of a Jira-only connection.
  assert.doesNotMatch(page, /class="field hidden" id="(?:github|gitlab)-settings"/);
  assert.match(page, /Each workflow uses the target for its own source picker\./);
  assert.match(page, /id="tracker-info"/);
  assert.match(page, /Trackers: not configured/);
  assert.doesNotMatch(page, /id="jira-info"/);

  const script = await (await fetch(`${base}/app.js`)).text();
  assert.match(script, /EventSource/);

  const styles = await (await fetch(`${base}/styles.css`)).text();
  assert.match(styles, /--accent/);

  const missing = await fetch(`${base}/api/nope`);
  assert.equal(missing.status, 404);
});

test('studio runs a sweep and streams structured progress events', async (t) => {
  const root = createRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-studio-remote-'));

  git(remote, ['init', '--bare', '-q']);
  git(root, ['remote', 'add', 'origin', remote]);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  });

  const studio = createStudioServer({
    cwd: root,
    version: '9.9.9',
    fetchImpl: fakeFetch,
    spawnImpl: fakeSweepAgent()
  });

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
      publish: 'push',
      model: 'nim-model',
      effort: 'high',
      claudeEnv: {
        ANTHROPIC_MODEL: 'nim-model',
        ANTHROPIC_AUTH_TOKEN: 'secret-env'
      },
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
  assert.equal(final.job.selection.environment, undefined);
  assert.equal(final.job.request.claudeEnv.ANTHROPIC_AUTH_TOKEN, '');
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
  assert.equal(settings.publish, 'push');
  assert.equal(settings.push, undefined);
  assert.equal(settings.claudeEnv.ANTHROPIC_MODEL, 'nim-model');
  assert.equal(settings.claudeEnv.ANTHROPIC_AUTH_TOKEN, '');
  assert.deepEqual(settings.claudeEnvSecrets, ['ANTHROPIC_AUTH_TOKEN']);
  assert.deepEqual(settings.workflows.bugSweep, {
    model: 'nim-model',
    effort: 'high',
    mr: true
  });
});

test('the job manager refuses a second sweep while one is running', async (t) => {
  const root = createRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-studio-remote-'));

  git(remote, ['init', '--bare', '-q']);
  git(root, ['remote', 'add', 'origin', remote]);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  });

  const manager = createJobManager({ cwd: root, fetchImpl: fakeFetch, spawnImpl: fakeSweepAgent() });
  const request = {
    project: 'ABC',
    date: '2026-10-19',
    base: 'HEAD',
    publish: 'push',
    jiraUrl: 'https://jira.example.com',
    jiraEmail: 'bot@example.com',
    jiraToken: 'secret'
  };

  const first = manager.startSweep(request);

  assert.throws(() => manager.startSweep(request), /already running/);

  await waitFor(() => first.status === 'done' || first.status === 'failed');
});

test('an enhancement session interviews, implements after plan approval, then records the report', async (t) => {
  const root = createRepo();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Settings the session must remember rather than overwrite.
  writeSettings(root, { project: 'ABC', jiraToken: 'secret', settingsSeen: true });

  let spawns = 0;
  const agent = createFakeLiveAgent((turn, prompt, options) => {
    if (turn === 1) {
      return 'Let me start with storage.\n\nLocal disk or a database?\n';
    }

    if (turn === 2) {
      return '# Plan\n\nUse local disk.\n\n```mermaid\nflowchart LR\nA-->B\n```\n';
    }

    // The approved plan is implemented in the same conversation.
    fs.writeFileSync(path.join(options.cwd, 'palette.js'), 'export const open = () => {};\n', 'utf8');

    return '# Report\n\nAdded palette.js and verified it.\n';
  });
  const manager = createJobManager({
    cwd: root,
    spawnProcess: (command, args, options) => {
      spawns += 1;
      return agent(command, args, options);
    },
    terminate: (child) => child.kill?.()
  });
  const job = await manager.startEnhancement({
    brief: 'Add a command palette.',
    model: 'nim-model',
    effort: 'high',
    mr: false
  });

  assert.equal(job.type, 'enhancement');
  assert.equal(job.flow, 'enhancement');
  assert.equal(job.selection.provider, undefined);
  assert.equal(job.selection.model, 'nim-model');
  assert.equal(job.selection.effort, 'high');

  const questions = () => manager.snapshot(job).events.filter((event) => event.type === 'question');

  await waitFor(() => questions().length === 1);
  assert.equal(manager.snapshot(job).status, 'waiting');

  assert.equal(manager.submitInput(job.id, { answer: 'Local disk.' }), true);

  // The plan is a checkpoint, not the end: approve it to start implementation.
  await waitFor(() => questions().length === 2);
  assert.equal(manager.submitInput(job.id, { answer: 'Approved. Implement it.' }), true);

  await waitFor(() => questions().length === 3);
  assert.match(questions()[2].text, /# Report/);

  // The report has no artifact, so the human closes the session.
  assert.equal(manager.submitInput(job.id, { done: true }), true);

  await waitFor(() => job.status === 'done');

  const snapshot = manager.snapshot(job);
  const events = snapshot.events;
  const types = events.map((event) => event.type);
  const output = events
    .filter((event) => event.type === 'output')
    .map((event) => event.chunk)
    .join('');

  assert.equal(spawns, 1);
  assert.ok(types.includes('question'));
  assert.ok(types.includes('answer'));
  assert.ok(types.includes('job-done'));
  assert.match(output, /Local disk or a database\?/);
  assert.match(output, /# Plan/);
  assert.match(output, /```mermaid/);
  assert.match(output, /# Report/);
  assert.match(job.result.output, /Added palette\.js and verified it/);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));

  const saved = readSettings(root);

  assert.equal(saved.workflows.enhancement.model, 'nim-model');
  assert.equal(saved.workflows.enhancement.effort, 'high');
  assert.equal(saved.workflows.enhancement.mr, false);
  // Remembering the workflow must not drop the rest of the store.
  assert.equal(saved.project, 'ABC');
  assert.equal(saved.settingsSeen, true);
  assert.equal(readStore(root).jiraToken, 'secret');
});

test('two sessions in the same workflow run in parallel worktrees', async (t) => {
  const root = createRepo();
  const worktrees = [];

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const agent = createFakeLiveAgent((turn, prompt, options) => {
    worktrees.push(options.cwd);
    return '```interview\nWhich storage?\n```\n';
  });
  const manager = createJobManager({
    cwd: root,
    spawnProcess: agent,
    terminate: (child) => child.kill?.()
  });

  const first = await manager.startEnhancement({ brief: 'Add a command palette.' });
  const second = await manager.startEnhancement({ brief: 'Add a settings drawer.' });

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.worktree, second.worktree);
  assert.match(first.worktree, /\.sdd[\\/]worktrees[\\/]/);
  assert.match(second.worktree, /\.sdd[\\/]worktrees[\\/]/);

  await waitFor(() => (
    manager.snapshot(first).status === 'waiting' && manager.snapshot(second).status === 'waiting'
  ));

  // Neither session occupies the main checkout.
  assert.equal(fs.existsSync(path.join(root, '.sdd', 'worktrees', first.id)), true);

  manager.cancelJob(first.id);
  manager.cancelJob(second.id);

  await waitFor(() => first.status === 'stopped' && second.status === 'stopped');
  assert.equal(fs.existsSync(path.join(root, '.sdd', 'worktrees', first.id)), false);
  assert.equal(fs.existsSync(path.join(root, '.sdd', 'worktrees', second.id)), false);
});

test('an enhancement closes its source issue after the work succeeds', async (t) => {
  const root = createRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-studio-close-remote-'));
  const calls = [];

  git(remote, ['init', '--bare', '-q']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'HEAD']);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  });

  const base = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);

  writeSettings(root, {
    project: 'ABC',
    jiraUrl: 'https://jira.internal',
    jiraAuth: 'bearer',
    jiraApiVersion: '2',
    jiraToken: 'secret',
    closeIssues: true
  });

  const response = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data)
  });
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });

    if (url.includes('?fields=status')) {
      return response({ fields: { status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } } });
    }

    if (url.endsWith('/transitions') && !options.method) {
      return response({ transitions: [{ id: '31', to: { name: 'Done', statusCategory: { key: 'done' } } }] });
    }

    if (url.endsWith('/transitions') && options.method === 'POST') {
      return response({}, 204);
    }

    throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${url}`);
  };
  const manager = createJobManager({
    cwd: root,
    fetchImpl,
    spawnProcess: createFakeLiveAgent((turn, prompt, options) => {
      if (turn === 1) {
        return 'What should change?\n';
      }

      if (turn === 2) {
        return '# Plan\n\nChange it.\n';
      }

      fs.writeFileSync(path.join(options.cwd, 'change.js'), 'export const changed = true;\n', 'utf8');

      return '# Report\n\nChanged it.\n';
    }),
    terminate: (child) => child.kill?.()
  });
  const job = await manager.startEnhancement({
    brief: 'ABC-1: Fix the thing.',
    base,
    publish: true,
    mr: false,
    issue: { source: 'jira', key: 'ABC-1', url: 'https://jira.internal/browse/ABC-1', target: 'ABC' },
    closeIssues: true
  });

  const questions = () => manager.snapshot(job).events.filter((event) => event.type === 'question');

  await waitFor(() => questions().length === 1);
  manager.submitInput(job.id, { answer: 'Fix it.' });
  await waitFor(() => questions().length === 2);
  manager.submitInput(job.id, { answer: 'Approved.' });
  await waitFor(() => questions().length === 3);
  manager.submitInput(job.id, { done: true });
  await waitFor(() => job.status === 'done');

  const closed = manager.snapshot(job).events.find((event) => event.type === 'issue-closed');
  const transition = calls.find((call) => call.options.method === 'POST');

  assert.equal(closed.key, 'ABC-1');
  assert.equal(closed.status, 'Done');
  assert.ok(transition);
  assert.equal(
    transition.url,
    'https://jira.internal/rest/api/2/issue/ABC-1/transitions'
  );
});

test('a session works on its own branch and leaves the main checkout untouched', async (t) => {
  const root = createRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-studio-branch-remote-'));
  const base = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);

  git(remote, ['init', '--bare', '-q']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'HEAD']);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  });

  const manager = createJobManager({
    cwd: root,
    spawnProcess: createFakeLiveAgent((turn, prompt, options) => {
      if (turn === 1) {
        return 'Local disk or a database?\n';
      }

      if (turn === 2) {
        return '# Plan\n\nUse local disk.\n';
      }

      fs.writeFileSync(path.join(options.cwd, 'palette.js'), 'export const open = () => {};\n', 'utf8');

      return '# Report\n\nAdded palette.js and verified it.\n';
    }),
    terminate: (child) => child.kill?.()
  });
  const job = await manager.startEnhancement({
    brief: 'Add a command palette.',
    mr: false
  });

  const questions = () => manager.snapshot(job).events.filter((event) => event.type === 'question');

  await waitFor(() => questions().length === 1);
  assert.equal(job.publish.status, 'branch');
  assert.equal(job.publish.base, base);
  assert.equal(job.branch, job.publish.branch);
  assert.equal(job.worktree, path.join(root, '.sdd', 'worktrees', job.id));
  assert.equal(fs.existsSync(job.worktree), true);

  // The branch exists, but the main checkout is still on the base branch.
  assert.equal(
    git(root, ['rev-parse', '--verify', `refs/heads/${job.publish.branch}`]).length > 0,
    true
  );
  assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), base);
  assert.equal(git(root, ['status', '--porcelain']), '');

  manager.submitInput(job.id, { answer: 'Local disk.' });
  await waitFor(() => questions().length === 2);
  manager.submitInput(job.id, { answer: 'Approved. Implement it.' });
  await waitFor(() => questions().length === 3);
  manager.submitInput(job.id, { done: true });

  await waitFor(() => job.status === 'done');

  assert.equal(job.publish.status, 'pushed');
  assert.equal(job.publish.commits.length, 1);
  assert.match(git(root, ['log', job.publish.branch, '-1', '--format=%s']), /command palette/);
  assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), base);
  assert.equal(git(root, ['status', '--porcelain']), '');

  // The worktree is gone; the pushed branch stays for the merge request.
  assert.equal(fs.existsSync(job.worktree), false);
  assert.equal(
    git(remote, ['rev-parse', '--verify', `refs/heads/${job.publish.branch}`]).length > 0,
    true
  );

  const types = manager.snapshot(job).events.map((event) => event.type);

  assert.ok(types.includes('publish'));
});

test('a feature session builds the chosen pipeline in the same job after the spec exists', async (t) => {
  const root = createRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-studio-feature-remote-'));
  const prompts = [];
  const trackerCalls = [];

  git(remote, ['init', '--bare', '-q']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'HEAD']);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  });

  const base = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);

  writeSettings(root, {
    jiraUrl: 'https://jira.internal',
    jiraAuth: 'bearer',
    jiraApiVersion: '2',
    jiraToken: 'secret',
    closeIssues: true
  });

  const trackerResponse = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data)
  });
  const manager = createJobManager({
    cwd: root,
    fetchImpl: async (url, options = {}) => {
      trackerCalls.push({ url, options });

      if (url.includes('?fields=status')) {
        return trackerResponse({ fields: { status: { name: 'Open', statusCategory: { key: 'new' } } } });
      }

      if (url.endsWith('/transitions') && !options.method) {
        return trackerResponse({ transitions: [{ id: '41', to: { name: 'Closed', statusCategory: { key: 'done' } } }] });
      }

      if (url.endsWith('/transitions') && options.method === 'POST') {
        return trackerResponse({}, 204);
      }

      throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${url}`);
    },
    spawnProcess: createFakeLiveAgent((turn, prompt, options) => {
      const specPath = path.join(options.cwd, 'docs', 'sdd', 'features', 'saved-searches', 'spec.md');
      const featurePath = path.join(path.dirname(specPath), 'feature.md');

      if (turn === 1) {
        prompts.push('deep-spec');
        fs.mkdirSync(path.dirname(specPath), { recursive: true });
        fs.writeFileSync(specPath, '# Spec\n\nSaved searches live in the sidebar.\n', 'utf8');

        return '# Spec written.\n';
      }

      if (turn === 2) {
        prompts.push('spec-to-task');
        fs.writeFileSync(featurePath, '# Tasks\n', 'utf8');

        return 'Tasks written.\n';
      }

      prompts.push('feature-tdd');

      return '# Report\n\nImplemented every task.\n';
    }),
    terminate: (child) => child.kill?.()
  });

  const session = await manager.startFeature({
    brief: 'Add saved searches.',
    base,
    mr: false,
    issue: { source: 'jira', key: 'ABC-7', url: 'https://jira.internal/browse/ABC-7', target: 'ABC' }
  });

  await waitFor(() => manager.snapshot(session).events.some((event) => event.type === 'build-choice'));
  assert.equal(manager.snapshot(session).status, 'waiting');

  assert.equal(manager.submitBuild(session.id, { pipeline: 'tdd', verify: false }), true);
  assert.equal(manager.submitBuild(session.id, { pipeline: 'tdd' }), false);

  await waitFor(() => session.status === 'done');

  const events = manager.snapshot(session).events;
  const done = events.filter((event) => event.type === 'build-step' && event.status === 'done');

  assert.match(session.result.artifact, /spec\.md$/);
  assert.equal(events.find((event) => event.type === 'build-started').verify, false);
  assert.deepEqual(done.map((event) => event.skill), ['spec-to-task', 'feature-tdd']);
  assert.equal(session.result.build.verify, false);
  assert.equal(session.result.build.verified, false);
  assert.deepEqual(prompts, ['deep-spec', 'spec-to-task', 'feature-tdd']);
  assert.equal(events.some((event) => event.type === 'build-done'), true);
  assert.equal(session.publish.status, 'pushed');
  assert.equal(events.find((event) => event.type === 'issue-closed').key, 'ABC-7');
  assert.ok(trackerCalls.some((call) => call.options.method === 'POST'));
  // The build is the same job, and its worktree is removed when it ends.
  assert.equal(fs.existsSync(session.worktree), false);
});

test('resolveSpecIssueTarget prefers the imported issue, then the requested source, then the saved one', () => {
  assert.deepEqual(
    resolveSpecIssueTarget({
      request: { issue: { source: 'gitlab', key: 'GL-2', target: 'group/repo' } },
      saved: { specIssueSource: 'github', githubRepo: 'owner/repo' }
    }),
    { source: 'gitlab', target: 'group/repo' }
  );

  assert.deepEqual(
    resolveSpecIssueTarget({
      request: { specIssueSource: 'github' },
      saved: { specIssueSource: 'jira', project: 'ABC', githubRepo: 'owner/repo' }
    }),
    { source: 'github', target: 'owner/repo' }
  );

  assert.deepEqual(
    resolveSpecIssueTarget({ request: {}, saved: { specIssueSource: 'jira', project: 'ABC' } }),
    { source: 'jira', target: 'ABC' }
  );

  assert.deepEqual(resolveSpecIssueTarget({ request: {}, saved: {} }), { source: 'jira', target: '' });
});

test('a spec issue session files the written spec without branching or publishing', async (t) => {
  const root = createRepo();
  const specPath = path.join(root, 'docs', 'sdd', 'features', 'saved-searches', 'spec.md');
  const trackerCalls = [];

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeSettings(root, {
    project: 'ABC',
    jiraUrl: 'https://jira.internal',
    jiraAuth: 'bearer',
    jiraApiVersion: '2',
    jiraToken: 'secret',
    specIssueSource: 'jira'
  });

  const response = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data)
  });
  const manager = createJobManager({
    cwd: root,
    fetchImpl: async (url, options = {}) => {
      trackerCalls.push({ url, options });

      if (url.endsWith('/rest/api/2/issue') && options.method === 'POST') {
        return response({ id: '20001', key: 'ABC-42' });
      }

      throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${url}`);
    },
    spawnProcess: createFakeLiveAgent((turn, prompt, options) => {
      const file = path.join(options.cwd, 'docs', 'sdd', 'features', 'saved-searches', 'spec.md');

      // The interview turn writes the spec, which ends the session structurally.
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '# Feature: Saved searches\n\nRemember filters.\n', 'utf8');

      return '# Spec written.\n';
    }),
    terminate: (child) => child.kill?.()
  });

  const session = await manager.startSpecIssue({
    brief: 'Add saved searches.',
    specIssueSource: 'jira',
    publish: true,
    closeIssues: true
  });

  await waitFor(() => session.status === 'done');

  const snapshot = manager.snapshot(session);
  const types = snapshot.events.map((event) => event.type);
  const created = snapshot.events.find((event) => event.type === 'issue-created');

  assert.equal(snapshot.flow, 'specIssue');
  assert.equal(session.publish, null);
  assert.equal(session.result.artifact, specPath);
  assert.equal(fs.readFileSync(specPath, 'utf8'), '# Feature: Saved searches\n\nRemember filters.\n');
  assert.ok(types.includes('issue-created'));
  assert.equal(created.type, 'issue-created');
  assert.equal(created.source, 'jira');
  assert.equal(created.key, 'ABC-42');
  assert.equal(created.url, 'https://jira.internal/browse/ABC-42');
  assert.equal(snapshot.events.some((event) => event.type === 'publish'), false);
  assert.equal(snapshot.events.some((event) => event.type === 'issue-closed'), false);
  assert.equal(snapshot.worktree, '');
  assert.equal(fs.existsSync(path.join(root, '.sdd', 'worktrees', session.id)), false);

  assert.equal(trackerCalls[0].url, 'https://jira.internal/rest/api/2/issue');
  assert.equal(JSON.parse(trackerCalls[0].options.body).fields.summary, 'Saved searches');
  assert.equal(
    JSON.parse(trackerCalls[0].options.body).fields.description,
    '# Feature: Saved searches\n\nRemember filters.\n'
  );

  assert.deepEqual(session.specIssue, {
    status: 'created',
    created: true,
    source: 'jira',
    key: 'ABC-42',
    id: '20001',
    url: 'https://jira.internal/browse/ABC-42'
  });
  assert.equal(snapshot.events.find((event) => event.type === 'job-done').summary.issue.key, 'ABC-42');
});

test('a spec issue session stays done when no tracker target is set', async (t) => {
  const root = createRepo();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const manager = createJobManager({
    cwd: root,
    spawnProcess: createFakeLiveAgent((turn, prompt, options) => {
      const file = path.join(options.cwd, 'docs', 'sdd', 'features', 'saved-searches', 'spec.md');

      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '# Feature: Saved searches\n', 'utf8');

      return '# Spec written.\n';
    }),
    terminate: (child) => child.kill?.()
  });

  const session = await manager.startSpecIssue({
    brief: 'Add saved searches.',
    specIssueSource: 'jira'
  });

  await waitFor(() => session.status === 'done');

  const skipped = manager.snapshot(session).events.find((event) => event.type === 'issue-skipped');

  assert.equal(skipped.source, 'jira');
  assert.match(skipped.reason, /Pick a Jira project/);
  assert.equal(session.specIssue.status, 'skipped');
});

test('a spec issue session stays done when the tracker rejects the issue', async (t) => {
  const root = createRepo();
  const specPath = path.join(root, 'docs', 'sdd', 'features', 'saved-searches', 'spec.md');

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeSettings(root, {
    project: 'ABC',
    jiraUrl: 'https://jira.internal',
    jiraAuth: 'bearer',
    jiraApiVersion: '2',
    jiraToken: 'secret',
    specIssueSource: 'jira'
  });

  const manager = createJobManager({
    cwd: root,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => '{"errorMessages":["No permission"]}'
    }),
    spawnProcess: createFakeLiveAgent((turn, prompt, options) => {
      const file = path.join(options.cwd, 'docs', 'sdd', 'features', 'saved-searches', 'spec.md');

      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '# Feature: Saved searches\n', 'utf8');

      return '# Spec written.\n';
    }),
    terminate: (child) => child.kill?.()
  });

  const session = await manager.startSpecIssue({
    brief: 'Add saved searches.'
  });

  await waitFor(() => session.status === 'done');

  const failed = manager.snapshot(session).events.find((event) => event.type === 'issue-create-failed');

  assert.match(failed.error, /Jira issue create failed \(403\)/);
  assert.equal(session.specIssue.status, 'failed');
  assert.ok(fs.existsSync(specPath));
});

test('the studio exposes the spec issue route', async (t) => {
  const root = createRepo();
  const specPath = path.join(root, 'docs', 'sdd', 'features', 'saved-searches', 'spec.md');
  const studio = createStudioServer({
    cwd: root,
    version: '9.9.9',
    spawnProcess: createFakeLiveAgent((turn, prompt, options) => {
      const file = path.join(options.cwd, 'docs', 'sdd', 'features', 'saved-searches', 'spec.md');

      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '# Feature: Saved searches\n', 'utf8');

      return '# Spec written.\n';
    }),
    terminate: (child) => child.kill?.()
  });

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve));

  const base = `http://127.0.0.1:${studio.server.address().port}`;

  t.after(() => studio.close());

  const started = await fetch(`${base}/api/spec-issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brief: 'Add saved searches.',
      specIssueSource: 'jira'
    })
  });

  assert.equal(started.status, 202);

  const { job } = await started.json();

  assert.equal(job.flow, 'specIssue');

  await waitFor(async () => (
    await collectSession(base, '/api/spec-issues', job.id)
  ).job.status === 'done');

  const finished = await collectSession(base, '/api/spec-issues', job.id);
  const list = await (await fetch(`${base}/api/spec-issues`)).json();

  assert.equal(finished.job.flow, 'specIssue');
  assert.equal(finished.job.specIssue.status, 'skipped');
  assert.match(finished.markdown, /specIssue session/);
  assert.equal(fs.existsSync(specPath), true);
  assert.equal(list.jobs.length, 1);
  assert.equal((await fetch(`${base}/api/features/${job.id}`)).status, 404);
});

function createMergeFixture() {
  const root = createRepo();
  const target = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const source = 'feature';
  const ref = `merge/${source}-into-${target}`;

  git(root, ['checkout', '-q', '-b', source]);
  fs.writeFileSync(path.join(root, 'feature.txt'), 'feature\n', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'feature work']);
  git(root, ['checkout', '-q', target]);

  return { root, target, source, ref };
}

function createMergeAgent({ source, target, ref }) {
  return createFakeLiveAgent((turn, prompt, options) => {
    // What the merge skill does inside its worktree: branch from the target,
    // then merge the source. The main checkout is never touched.
    if (turn === 1) {
      git(options.cwd, ['checkout', '-q', '-b', ref, target]);
      git(options.cwd, ['merge', '--no-ff', '-q', '-m', 'Merge feature', source]);
    }

    return '# Merge report\n\nMerged feature; no conflicts.\n';
  });
}

test('a merge session starts from a dirty checkout and refuses an existing integration branch', async (t) => {
  const fixture = createMergeFixture();
  const manager = createJobManager({
    cwd: fixture.root,
    spawnProcess: createMergeAgent(fixture),
    terminate: (child) => child.kill?.()
  });

  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const dirtyFile = path.join(fixture.root, 'scratch.txt');

  fs.writeFileSync(dirtyFile, 'dirty\n', 'utf8');

  // The worktree isolates the merge, so a dirty main checkout is allowed.
  const job = await manager.startMerge({
    source: fixture.source,
    target: fixture.target
  });

  await waitFor(() => job.status === 'done');
  assert.equal(job.result.ref, fixture.ref);
  assert.equal(git(fixture.root, ['rev-parse', '--abbrev-ref', 'HEAD']), fixture.target);

  fs.rmSync(dirtyFile, { force: true });

  await assert.rejects(
    manager.startMerge({
      source: fixture.source,
      target: fixture.target
    }),
    /already exists/
  );
});

test('a merge session ends at the integration branch and lands it by fast-forward', async (t) => {
  const fixture = createMergeFixture();
  const manager = createJobManager({
    cwd: fixture.root,
    spawnProcess: createMergeAgent(fixture),
    terminate: (child) => child.kill?.()
  });

  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const job = await manager.startMerge({
    source: fixture.source,
    target: fixture.target
  });

  assert.equal(job.flow, 'merge');
  assert.equal(job.request.merge.ref, fixture.ref);

  await waitFor(() => job.status === 'done');

  const done = manager.snapshot(job).events.find((event) => event.type === 'job-done');

  assert.equal(job.result.ref, fixture.ref);
  assert.equal(done.summary.ref, fixture.ref);
  // The integration branch exists; the target itself was not checked out or moved.
  assert.equal(git(fixture.root, ['rev-parse', '--abbrev-ref', 'HEAD']), fixture.target);
  assert.equal(fs.existsSync(job.worktree), false);

  // A dirty tree blocks landing, and the target stays put.
  const scratch = path.join(fixture.root, 'scratch.txt');

  fs.writeFileSync(scratch, 'not committed\n', 'utf8');

  await assert.rejects(manager.landMerge(job.id), /working tree has changes/);
  assert.equal(git(fixture.root, ['rev-parse', '--abbrev-ref', 'HEAD']), fixture.target);

  fs.rmSync(scratch, { force: true });

  const landed = await manager.landMerge(job.id);

  assert.equal(landed.target, fixture.target);
  assert.equal(landed.fastForward, true);
  assert.equal(landed.previousBranch, fixture.target);
  assert.equal(git(fixture.root, ['rev-parse', '--abbrev-ref', 'HEAD']), fixture.target);
  assert.equal(
    git(fixture.root, ['rev-parse', 'HEAD']),
    git(fixture.root, ['rev-parse', fixture.ref])
  );
  assert.equal(fs.existsSync(path.join(fixture.root, 'feature.txt')), true);
});

test('a merge session refuses to land when the target moved', async (t) => {
  const fixture = createMergeFixture();
  const manager = createJobManager({
    cwd: fixture.root,
    spawnProcess: createMergeAgent(fixture),
    terminate: (child) => child.kill?.()
  });

  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const job = await manager.startMerge({
    source: fixture.source,
    target: fixture.target
  });

  await waitFor(() => job.status === 'done');

  // Someone lands another change on the target after the integration branch
  // was cut. A fast-forward is no longer possible, and the studio refuses.
  fs.writeFileSync(path.join(fixture.root, 'later.txt'), 'later\n', 'utf8');
  git(fixture.root, ['add', '-A']);
  git(fixture.root, ['commit', '-q', '-m', 'later target work']);

  await assert.rejects(manager.landMerge(job.id), /has moved/);
  assert.equal(git(fixture.root, ['rev-parse', '--abbrev-ref', 'HEAD']), fixture.target);
});

test('the studio exposes the merge route and the explicit land endpoint', async (t) => {
  const fixture = createMergeFixture();
  const studio = createStudioServer({
    cwd: fixture.root,
    version: '9.9.9',
    spawnProcess: createMergeAgent(fixture),
    terminate: (child) => child.kill?.()
  });

  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve));

  const base = `http://127.0.0.1:${studio.server.address().port}`;

  t.after(() => studio.close());

  const started = await fetch(`${base}/api/merges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: fixture.source,
      target: fixture.target
    })
  });

  assert.equal(started.status, 202);

  const { job } = await started.json();

  await waitFor(async () => (
    await collectSession(base, '/api/merges', job.id)
  ).job.status === 'done');

  const finished = await collectSession(base, '/api/merges', job.id);

  assert.equal(finished.job.flow, 'merge');
  assert.equal(finished.job.result.ref, fixture.ref);
  assert.equal(finished.job.events.find((event) => event.type === 'job-done').summary.ref, fixture.ref);
  assert.equal((await fetch(`${base}/api/features/${job.id}`)).status, 404);

  const land = await fetch(`${base}/api/merges/${job.id}/land`, { method: 'POST' });

  assert.equal(land.status, 200);

  const result = await land.json();

  assert.equal(result.target, fixture.target);
  assert.equal(result.fastForward, true);
  assert.equal(git(fixture.root, ['rev-parse', '--abbrev-ref', 'HEAD']), fixture.target);

  // An unknown session is a clear 404, not a crash.
  assert.equal((await fetch(`${base}/api/merges/nope/land`, { method: 'POST' })).status, 404);
});

test('a live Claude session streams questions and answers over one process', async (t) => {
  const root = createRepo();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const manager = createJobManager({
    cwd: root,
    spawnProcess: createFakeLiveAgent((turn) => (
      turn === 1
        ? 'Which storage should we use?\n\nLocal disk or a database?\n'
        : '# Plan\n\nLocal disk it is.\n'
    )),
    terminate: (child) => child.kill?.()
  });
  const job = await manager.startEnhancement({
    brief: 'Add a command palette.'
  });

  assert.equal(job.result, null);

  await waitFor(() => manager.snapshot(job).events.some((event) => event.type === 'question'));
  assert.equal(manager.snapshot(job).status, 'waiting');

  assert.equal(manager.submitInput(job.id, { answer: 'Local disk.' }), true);

  // The human may still finish at the plan instead of implementing it.
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

test('a live turn with no assistant text fails with the agent diagnostic', async (t) => {
  const root = createRepo();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const manager = createJobManager({
    cwd: root,
    spawnProcess: () => {
      const child = new EventEmitter();

      child.pid = 4343;
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

      child.stdin.on('data', () => {
        child.stderr.write('[claude-code:unrecognized_model] {"model":"gemma3-270m:free"}\n');
        child.stdout.write(`${JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: ''
        })}\n`);
      });

      return child;
    },
    terminate: (child) => child.kill?.()
  });
  const job = await manager.startEnhancement({
    brief: 'Add a command palette.'
  });

  await waitFor(() => job.status === 'failed');

  assert.match(job.error, /returned no reply: .*unrecognized_model/);

  const events = manager.snapshot(job).events;

  // Keep diagnostics in the failure message without displaying stderr as a reply.
  assert.equal(events.some((event) => event.type === 'question'), false);
  assert.equal(events.some((event) => event.type === 'output' && event.stream === 'stderr'), false);
});

test('the job manager routes a permission request to the browser', async (t) => {
  const root = createRepo();
  const spawnAgent = createFakeLiveAgent(() => '# Plan\n\nLocal disk.');

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const manager = createJobManager({
    cwd: root,
    spawnProcess: (command, args, options) => {
      // startSession picks the id, so the fake writes where the session reads.
      const dir = path.join(root, '.sdd', 'sessions', 'enhancement', options.env.SDD_SESSION_ID);

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
  const job = await manager.startEnhancement({
    brief: 'Add a command palette.'
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

test('cancelling a session stops the live process and removes its worktree', async (t) => {
  const root = createRepo();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let killed = false;
  const manager = createJobManager({
    cwd: root,
    spawnProcess: createFakeLiveAgent(() => 'Still going?\n'),
    terminate: (child) => {
      killed = true;
      child.kill?.();
    }
  });
  const job = await manager.startEnhancement({
    brief: 'Add a command palette.'
  });

  await waitFor(() => manager.snapshot(job).events.some((event) => event.type === 'question'));

  assert.equal(manager.cancelJob(job.id), true);

  await waitFor(() => job.status === 'stopped');
  assert.ok(killed);
  assert.equal(fs.existsSync(job.worktree), false);

  const types = manager.snapshot(job).events.map((event) => event.type);

  assert.ok(types.includes('job-stopped'));
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
    publish: 'push',
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

test('resolveStudioJira defaults to basic auth and v3 for Jira Cloud', () => {
  const cloud = resolveStudioJira({
    jiraType: 'cloud',
    jiraUrl: 'https://company.atlassian.net',
    jiraToken: 'api-token',
    jiraEmail: 'user@company.com'
  });

  assert.equal(cloud.jiraType, 'cloud');
  assert.equal(cloud.auth, 'basic');
  assert.equal(cloud.apiVersion, '3');
  assert.equal(cloud.email, 'user@company.com');
  assert.equal(cloud.token, 'api-token');
});

test('resolveStudioJira defaults to bearer auth, v2, and strips email for Jira Data Center', () => {
  const dc = resolveStudioJira({
    jiraType: 'datacenter',
    jiraUrl: 'https://jira.company.com',
    jiraToken: 'pat-token',
    jiraEmail: 'unused@company.com'
  });

  assert.equal(dc.jiraType, 'datacenter');
  assert.equal(dc.auth, 'bearer');
  assert.equal(dc.apiVersion, '2');
  assert.equal(dc.email, '');
  assert.equal(dc.token, 'pat-token');
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
      jiraApiVersion: '2',
      closeIssues: true
    })
  })).json();

  assert.equal(saved.hasSavedToken, true);
  assert.equal(saved.settings.jiraToken, undefined);
  assert.equal(saved.settings.jiraUrl, 'https://jira.internal');
  assert.equal(saved.settings.closeIssues, true);

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
      brief: 'Add a command palette.'
    })
  });

  assert.equal(started.status, 202);

  const { job } = await started.json();

  await waitFor(async () => (
    await collectSession(base, '/api/enhancements', job.id)
  ).job.status === 'waiting');

  // Sessions run in their own worktrees, so a second one may start in parallel.
  const parallel = await fetch(`${base}/api/features`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brief: 'A new feature.' })
  });

  assert.equal(parallel.status, 202);

  const parallelJob = (await parallel.json()).job;

  await waitFor(async () => (
    await collectSession(base, '/api/features', parallelJob.id)
  ).job.status === 'waiting');

  await fetch(`${base}/api/features/${parallelJob.id}/cancel`, { method: 'POST' });
  await waitFor(async () => (
    await collectSession(base, '/api/features', parallelJob.id)
  ).job.status === 'stopped');

  const answered = await fetch(`${base}/api/jobs/${job.id}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: 'Local disk.' })
  });

  assert.equal(answered.status, 200);

  await waitFor(async () => (
    await collectSession(base, '/api/enhancements', job.id)
  ).job.status === 'waiting');

  // Enhancement has no artifact: the human finishes the session.
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
  assert.match(final.markdown, /enhancement session/);

  // The feature tab runs the same engine under its own prefix.
  const feature = await fetch(`${base}/api/features`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brief: 'Add saved searches.'
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

  assert.equal(features.jobs.length, 2);
  assert.ok(features.jobs.some((entry) => entry.flow === 'feature' && entry.status === 'done'));
  assert.ok(features.jobs.some((entry) => entry.flow === 'feature' && entry.status === 'stopped'));
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
