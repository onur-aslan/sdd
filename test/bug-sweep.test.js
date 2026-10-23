import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_AGENT_COMMAND,
  assessCritical,
  buildAgentInvocation,
  buildBranchPushArgs,
  buildCommitMessage,
  buildJiraAuthHeader,
  buildJql,
  buildResumeJql,
  buildSpawnSpec,
  createJiraFetch,
  describeJiraError,
  describeJiraStatus,
  extractMergeRequestUrl,
  fetchJiraBugs,
  fetchJiraProjects,
  flattenAdf,
  formatDelay,
  nextOccurrence,
  normalizeAgentCommand,
  normalizeJiraApiVersion,
  openMergeRequest,
  parseBugSweepArgs,
  parseClockTime,
  parseDuration,
  parseIssueKeys,
  parseScheduleArgs,
  probeJira,
  renderBugPrompt,
  renderPrBody,
  runBugSweep,
  tokenizeCommand,
  validateBugResult
} from '../cli/bug-sweep.js';
import { run } from '../cli/index.js';
import { buildNativeSkillCall } from '../cli/native-skills.js';

function installSweepFixtureSkills(root) {
  for (const skill of ['bug-sweep', 'bug-fix']) {
    const skillFile = path.join(root, '.claude', 'skills', skill, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, `---\nname: ${skill}\ndescription: Test fixture skill.\n---\n`, 'utf8');
  }
}

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

const jiraFlags = [
  '--jira-url', 'https://jira.example.com',
  '--jira-email', 'bot@example.com',
  '--jira-token', 'secret'
];

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }

  return (result.stdout || '').trim();
}

function createFakeAgent(root, argsFile = null) {
  if (process.platform === 'win32') {
    const scriptPath = path.join(root, 'fake-agent.cmd');
    const lines = ['@echo off'];

    if (argsFile) {
      lines.push(`> "${argsFile}" echo %*`);
    }

    lines.push(
      'if not "%SDD_BUG_KEY%"=="ABC-1" goto notfixed',
      '> "%SDD_BUG_RESULT_FILE%" echo {"key":"ABC-1","status":"fixed","summary":"Null guard","how":"Added a guard","critical":false,"evidence":["test"]}',
      'echo patched>> app.txt',
      'exit /b 0',
      ':notfixed',
      '> "%SDD_BUG_RESULT_FILE%" echo {"key":"ABC-2","status":"not-fixed","reason":"Could not reproduce"}',
      'exit /b 0',
      ''
    );
    fs.writeFileSync(scriptPath, lines.join('\r\n'), 'utf8');

    return scriptPath;
  }

  const scriptPath = path.join(root, 'fake-agent.sh');
  const lines = ['#!/bin/sh'];

  if (argsFile) {
    lines.push(`printf '%s\\n' "$@" > "${argsFile}"`);
  }

  lines.push(
    'if [ "$SDD_BUG_KEY" = "ABC-1" ]; then',
    '  printf \'%s\\n\' \'{"key":"ABC-1","status":"fixed","summary":"Null guard","how":"Added a guard","critical":false,"evidence":["test"]}\' > "$SDD_BUG_RESULT_FILE"',
    '  printf \'patched\\n\' >> app.txt',
    'else',
    '  printf \'%s\\n\' \'{"key":"ABC-2","status":"not-fixed","reason":"Could not reproduce"}\' > "$SDD_BUG_RESULT_FILE"',
    'fi',
    'exit 0',
    ''
  );
  fs.writeFileSync(scriptPath, lines.join('\n'), 'utf8');
  fs.chmodSync(scriptPath, 0o755);

  return scriptPath;
}

test('bug-sweep defaults to a dated branch, tag, and the Claude Code agent', () => {
  const options = parseBugSweepArgs(['--project', 'ABC']);

  assert.equal(options.project, 'ABC');
  assert.match(options.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(options.branch, `bug-fix/${options.date}`);
  assert.equal(options.tag, `bug-fix-${options.date}`);
  assert.equal(options.limit, 50);
  assert.equal(options.maxTurns, 5);
  assert.equal(options.timeoutSeconds, 1800);
  assert.equal(options.workDir, '.bug-fix');
  assert.equal(options.push, true);
  assert.equal(options.pr, true);
  assert.equal(options.resume, false);
  assert.equal(options.worktree, false);
  assert.equal(options.fetchBase, false);
  assert.equal(options.gitlabPush, false);
  assert.deepEqual(options.issues, []);
  assert.deepEqual(options.agentCommand, { kind: 'argv', argv: JSON.parse(DEFAULT_AGENT_COMMAND) });
});

test('bug-sweep derives the project from a custom JQL and accepts overrides', () => {
  const options = parseBugSweepArgs([
    '--jql', 'project = "WEB" AND labels = regression',
    '--date', '2026-10-19',
    '--branch', 'sweep/2026-10-19',
    '--tag', 'sweep-2026-10-19',
    '--max-turns', '3',
    '--worktree',
    '--fetch-base',
    '--gitlab-push',
    '--no-push',
    '--no-pr'
  ]);

  assert.equal(options.project, 'WEB');
  assert.equal(options.date, '2026-10-19');
  assert.equal(options.branch, 'sweep/2026-10-19');
  assert.equal(options.tag, 'sweep-2026-10-19');
  assert.equal(options.maxTurns, 3);
  assert.equal(options.worktree, true);
  assert.equal(options.fetchBase, true);
  assert.equal(options.gitlabPush, true);
  assert.equal(options.push, false);
  assert.equal(options.pr, false);
});

test('bug-sweep parses a comma-separated issue selection', () => {
  const options = parseBugSweepArgs(['--project', 'ABC', '--issues', 'ABC-2, abc-1,ABC-2']);

  assert.deepEqual(options.issues, ['ABC-2', 'ABC-1']);
  assert.throws(() => parseIssueKeys('not-a-key'), /Invalid Jira key/);
  assert.throws(() => parseBugSweepArgs(['--project', 'ABC', '--issues', 'ABC-x']), /Invalid Jira key/);
});

test('bug-sweep rejects invalid arguments', () => {
  assert.throws(() => parseBugSweepArgs([]), /Either --project, --jql, or --issues/);
  assert.throws(() => parseBugSweepArgs(['--project', 'ABC', '--date', '2026-13-01']), /Invalid --date/);
  assert.throws(() => parseBugSweepArgs(['--project', 'ABC', '--max-turns', '0']), /positive integer/);
  assert.throws(() => parseBugSweepArgs(['--project', 'ABC', '--branch', 'bad name']), /Invalid --branch/);
  assert.throws(() => parseBugSweepArgs(['--project']), /Missing value for --project/);
  assert.throws(() => parseBugSweepArgs(['--project', 'ABC', '--unknown']), /Unknown option/);
});

test('buildJql scopes to open bugs and keeps a custom query untouched', () => {
  assert.equal(
    buildJql({ project: 'ABC' }),
    'project = "ABC" AND issuetype = Bug AND statusCategory != Done ORDER BY priority DESC, key ASC'
  );
  assert.equal(buildJql({ project: 'ABC', jql: 'project = ABC ORDER BY created' }), 'project = ABC ORDER BY created');
  assert.equal(
    buildJql({ project: 'ABC', issues: ['ABC-2', 'ABC-1'] }),
    'key IN (ABC-2, ABC-1) ORDER BY priority DESC, key ASC'
  );
});

test('schedule helpers parse clock times, durations, and delays', () => {
  assert.deepEqual(parseClockTime('00:00'), { hours: 0, minutes: 0 });
  assert.deepEqual(parseClockTime('23:45'), { hours: 23, minutes: 45 });
  assert.throws(() => parseClockTime('24:00'), /Invalid --at/);
  assert.throws(() => parseClockTime('7:5'), /Invalid --at/);

  assert.equal(parseDuration('30s'), 30000);
  assert.equal(parseDuration('15m'), 900000);
  assert.equal(parseDuration('2h'), 7200000);
  assert.equal(parseDuration('1d'), 86400000);
  assert.throws(() => parseDuration('1w'), /Invalid --every/);

  assert.equal(formatDelay(3600000), '1h');
  assert.equal(formatDelay(86400000), '1d');
  assert.equal(formatDelay(5400000), '1h 30m');
});

test('nextOccurrence picks today or tomorrow in local time', () => {
  const from = new Date(2026, 9, 19, 23, 0, 0);

  assert.equal(nextOccurrence({ hours: 0, minutes: 0 }, from).getTime(), new Date(2026, 9, 20, 0, 0, 0).getTime());
  assert.equal(nextOccurrence({ hours: 23, minutes: 30 }, from).getTime(), new Date(2026, 9, 19, 23, 30, 0).getTime());
});

test('parseScheduleArgs separates scheduling flags from the sweep arguments', () => {
  const schedule = parseScheduleArgs([
    '--project', 'ABC',
    '--at', '00:00',
    '--every=1d',
    '--run-now',
    '--no-push'
  ]);

  assert.equal(schedule.at, '00:00');
  assert.equal(schedule.every, '1d');
  assert.equal(schedule.runNow, true);
  assert.deepEqual(schedule.rest, ['--project', 'ABC', '--no-push']);

  assert.throws(() => parseScheduleArgs(['--at']), /Missing value for --at/);
});

test('a scheduled sweep validates the sweep arguments before waiting', async () => {
  await assert.rejects(
    () => runBugSweep(['--at', '00:00', '--jira-url', 'https://x', '--jira-email', 'a@b', '--jira-token', 't'], {
      logger: () => {},
      now: () => new Date(2026, 9, 19, 23, 0, 0),
      sleep: async () => {},
      output: () => {}
    }),
    /Either --project, --jql, or --issues/
  );
});

test('a scheduled sweep waits for the target time before running', async () => {
  const output = [];
  const sleeps = [];

  const summary = await runBugSweep(
    ['--project', 'ABC', '--dry-run', '--at', '00:00', ...jiraFlags],
    {
      fetchImpl: fakeFetch,
      logger: () => {},
      output: (text) => output.push(text),
      now: () => new Date(2026, 9, 19, 23, 0, 0),
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      maxRuns: 1
    }
  );

  assert.equal(summary, '');
  assert.deepEqual(sleeps, [3600000]);
  assert.match(output.join(''), /Bug sweep plan — ABC/);
});

test('a recurring sweep runs immediately with --run-now and then waits for the interval', async () => {
  const output = [];
  const sleeps = [];

  await runBugSweep(
    ['--project', 'ABC', '--dry-run', '--every', '2h', '--run-now', ...jiraFlags],
    {
      fetchImpl: fakeFetch,
      logger: () => {},
      output: (text) => output.push(text),
      now: () => new Date(2026, 9, 19, 8, 0, 0),
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      maxRuns: 2
    }
  );

  assert.equal(output.length, 2);
  assert.deepEqual(sleeps, [7200000]);
});

test('buildResumeJql excludes bugs a previous run already handled', () => {
  assert.equal(buildResumeJql('project = ABC', []), 'project = ABC');
  assert.equal(buildResumeJql('project = ABC', ['ABC-1']), '(project = ABC) AND key NOT IN (ABC-1)');
  assert.equal(buildResumeJql('project = ABC', ['ABC-1', 'ABC-2']), '(project = ABC) AND key NOT IN (ABC-1, ABC-2)');
  assert.equal(
    buildResumeJql('project = ABC ORDER BY priority DESC, key ASC', ['ABC-1']),
    '(project = ABC) AND key NOT IN (ABC-1) ORDER BY priority DESC, key ASC'
  );
});

test('flattenAdf turns a Jira document into readable text', () => {
  const document = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'hardBreak' },
          { type: 'text', text: 'World' }
        ]
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }
    ]
  };

  assert.equal(flattenAdf(document), 'Hello\nWorld\nSecond\n');
  assert.equal(flattenAdf('plain text'), 'plain text');
  assert.equal(flattenAdf(null), '');
});

test('validateBugResult enforces the automation contract', () => {
  const fixed = validateBugResult(
    { key: 'ABC-1', status: 'fixed', summary: 'Guard', how: 'Added a guard' },
    { key: 'ABC-1' }
  );
  assert.equal(fixed.ok, true);
  assert.equal(fixed.value.critical, false);

  const missingFields = validateBugResult({ key: 'ABC-1', status: 'fixed' }, { key: 'ABC-1' });
  assert.equal(missingFields.ok, false);
  assert.match(missingFields.errors.join(' '), /summary/);

  const wrongKey = validateBugResult({ key: 'ABC-9', status: 'not-fixed', reason: 'nope' }, { key: 'ABC-1' });
  assert.equal(wrongKey.ok, false);

  const criticalWithoutReason = validateBugResult(
    { key: 'ABC-1', status: 'fixed', summary: 's', how: 'h', critical: true },
    { key: 'ABC-1' }
  );
  assert.equal(criticalWithoutReason.ok, false);
  assert.match(criticalWithoutReason.errors.join(' '), /criticalReason/);

  const notFixed = validateBugResult({ key: 'ABC-1', status: 'not-fixed', reason: 'Cannot reproduce' }, { key: 'ABC-1' });
  assert.equal(notFixed.ok, true);
  assert.equal(notFixed.value.reason, 'Cannot reproduce');
});

test('assessCritical flags the agent verdict and sensitive paths', () => {
  const fromAgent = assessCritical({
    result: { critical: true, criticalReason: 'Auth flow' },
    files: ['src/app.ts']
  });
  assert.equal(fromAgent.critical, true);
  assert.match(fromAgent.reason, /Auth flow/);

  const fromPath = assessCritical({
    result: { critical: false, criticalReason: '' },
    files: ['src/auth/session.ts']
  });
  assert.equal(fromPath.critical, true);
  assert.match(fromPath.reason, /authentication/);

  const clean = assessCritical({
    result: { critical: false, criticalReason: '' },
    files: ['src/app.ts', 'README.md']
  });
  assert.equal(clean.critical, false);
});

test('buildCommitMessage produces a conventional commit with the Jira link', () => {
  const commit = buildCommitMessage({
    key: 'ABC-1',
    summary: 'Null guard',
    how: 'Added a guard',
    url: 'https://jira.example.com/browse/ABC-1'
  });

  assert.equal(commit.title, 'fix(ABC-1): Null guard');
  assert.match(commit.body, /Added a guard/);
  assert.match(commit.body, /https:\/\/jira.example.com\/browse\/ABC-1/);
});

test('renderPrBody lists fixes, failures, and human review reasons', () => {
  const body = renderPrBody({
    project: 'ABC',
    date: '2026-10-19',
    branch: 'bug-fix/2026-10-19',
    tag: 'bug-fix-2026-10-19',
    bugs: [
      {
        key: 'ABC-1',
        status: 'fixed',
        fixSummary: 'Null guard',
        how: 'Added a guard',
        critical: true,
        criticalReason: 'Touches authentication',
        url: 'https://jira.example.com/browse/ABC-1'
      },
      { key: 'ABC-2', status: 'not-fixed', reason: 'Could not reproduce', url: 'https://jira.example.com/browse/ABC-2' }
    ]
  });

  assert.match(body, /2 bugs · 1 fixed · 1 not fixed/);
  assert.match(body, /\[ABC-1\]\(https:\/\/jira.example.com\/browse\/ABC-1\)/);
  assert.match(body, /### Human review required/);
  assert.match(body, /Touches authentication/);
  assert.match(body, /### Not fixed/);
  assert.match(body, /Could not reproduce/);
});

test('renderBugPrompt includes the result contract and the attempt limit', () => {
  const prompt = renderBugPrompt({
    bug: {
      key: 'ABC-1',
      summary: 'Crash on save',
      priority: 'High',
      jiraStatus: 'Open',
      url: 'https://jira.example.com/browse/ABC-1',
      labels: ['bug'],
      description: 'Steps to reproduce',
      extraFields: {}
    },
    maxTurns: 5,
    resultFile: '/tmp/ABC-1.result.json'
  });

  assert.match(prompt, /ABC-1/);
  assert.match(prompt, /Pass max_turns=5 to the bug-fix skill/);
  assert.match(prompt, /Result contract for bug-sweep/);
  assert.match(prompt, /The bug-sweep orchestrator writes/);
  assert.match(prompt, /\/tmp\/ABC-1.result.json/);
  assert.match(prompt, /"status": "fixed"/);
});

test('the sweep invokes the bug-sweep skill and passes the attempt limit', () => {
  assert.match(buildNativeSkillCall('bug-sweep', 'claude', { max_turns: 3 }), /^\/bug-sweep/);
  assert.match(buildNativeSkillCall('bug-sweep', 'claude', { max_turns: 3 }), /max_turns=3/);
  assert.match(buildNativeSkillCall('bug-sweep', 'codex', { max_turns: 3 }), /\$bug-sweep/);
  assert.match(buildNativeSkillCall('bug-sweep', 'opencode', { max_turns: 3 }), /bug-sweep skill/);
});

test('bug-sweep delegates the fix and owns the JSON result', () => {
  const sweepSkill = fs.readFileSync(new URL('../sdd/skills/bug-sweep/SKILL.md', import.meta.url), 'utf8');
  const fixSkill = fs.readFileSync(new URL('../sdd/skills/bug-fix/SKILL.md', import.meta.url), 'utf8');

  assert.match(sweepSkill, /name: bug-sweep/);
  assert.match(sweepSkill, /disable-model-invocation: true/);
  assert.match(sweepSkill, /fresh general-purpose subagent/);
  assert.match(sweepSkill, /Invoke the `bug-fix` skill/);
  assert.match(sweepSkill, /prepare the JSON object required by the task file/);
  assert.match(sweepSkill, /You prepare this object from the subagent's report/);
  assert.doesNotMatch(fixSkill, /disable-model-invocation/);
  assert.doesNotMatch(fixSkill, /JSON/);
});

test('bug-sweep requires the bug-sweep skill, not only bug-fix', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-bug-sweep-missing-skill-'));
  const fixSkill = path.join(root, '.claude', 'skills', 'bug-fix', 'SKILL.md');

  try {
    fs.mkdirSync(path.dirname(fixSkill), { recursive: true });
    fs.writeFileSync(fixSkill, '---\nname: bug-fix\ndescription: Test fixture skill.\n---\n', 'utf8');

    await assert.rejects(
      () => runBugSweep(['--project', 'ABC', ...jiraFlags], {
        cwd: root,
        agentPreset: 'claude',
        logger: () => {}
      }),
      /cannot invoke \/bug-sweep/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tokenizeCommand keeps quoted arguments and Windows backslashes', () => {
  assert.deepEqual(tokenizeCommand('opencode run --agent build'), ['opencode', 'run', '--agent', 'build']);
  assert.deepEqual(tokenizeCommand('"C:\\Program Files\\agent.cmd" --flag'), ['C:\\Program Files\\agent.cmd', '--flag']);
  assert.deepEqual(tokenizeCommand("'single quoted' plain"), ['single quoted', 'plain']);
  assert.throws(() => tokenizeCommand('"unterminated'), /Unterminated quote/);
});

test('normalizeAgentCommand accepts JSON arrays and command templates', () => {
  assert.deepEqual(normalizeAgentCommand('["opencode","run"]'), { kind: 'argv', argv: ['opencode', 'run'] });
  assert.deepEqual(normalizeAgentCommand('opencode run'), { kind: 'argv', argv: ['opencode', 'run'] });
  assert.throws(() => normalizeAgentCommand('[]'), /non-empty array/);
  assert.throws(() => normalizeAgentCommand('[1,2]'), /array of strings/);
  assert.throws(() => normalizeAgentCommand('[not json'), /valid JSON/);
});

test('buildAgentInvocation appends or substitutes the prompt', () => {
  assert.deepEqual(
    buildAgentInvocation({ kind: 'argv', argv: ['opencode', 'run'] }, { prompt: 'P', promptFile: '/tmp/p.md' }),
    { command: 'opencode', args: ['run', 'P'] }
  );
  assert.deepEqual(
    buildAgentInvocation({ kind: 'argv', argv: ['agent', '--prompt={prompt}'] }, { prompt: 'P', promptFile: '/tmp/p.md' }),
    { command: 'agent', args: ['--prompt=P'] }
  );
  assert.deepEqual(
    buildAgentInvocation({ kind: 'argv', argv: ['agent', '{promptFile}'] }, { prompt: 'P', promptFile: '/tmp/p.md' }),
    { command: 'agent', args: ['/tmp/p.md'] }
  );
});

test('buildSpawnSpec routes Windows commands through cmd.exe for .cmd shims', () => {
  assert.deepEqual(
    buildSpawnSpec({ command: 'opencode', args: ['run', 'P'] }, 'linux'),
    { command: 'opencode', args: ['run', 'P'] }
  );
  assert.deepEqual(
    buildSpawnSpec({ command: 'opencode', args: ['run', 'P'] }, 'win32'),
    { command: 'cmd.exe', args: ['/d', '/s', '/c', 'opencode', 'run', 'P'] }
  );
});

test('the CLI exposes bug-sweep help and dry runs without touching git', async () => {
  const sweepHelp = await run(['bug-sweep', '--help']);
  assert.match(sweepHelp, /sdd bug-sweep/);
  assert.match(sweepHelp, /--agent-cmd/);

  const topLevelHelp = await run(['--help']);
  assert.match(topLevelHelp, /bug-sweep/);

  const output = await runBugSweep(
    ['--project', 'ABC', '--date', '2026-10-19', '--dry-run', ...jiraFlags],
    { fetchImpl: fakeFetch, logger: () => {} }
  );

  assert.match(output, /Bug sweep plan — ABC \(2026-10-19\)/);
  assert.match(output, /ABC-1/);
  assert.match(output, /Dry run: git was not touched/);
});

function createFilteringJiraFetch() {
  const issues = [
    {
      key: 'ABC-1',
      id: '1',
      fields: { summary: 'Crash on save', description: 'Steps', priority: { name: 'High' }, status: { name: 'Open' }, labels: [] }
    },
    {
      key: 'ABC-2',
      id: '2',
      fields: { summary: 'Flaky login', description: 'Sometimes', priority: { name: 'Low' }, status: { name: 'Open' }, labels: [] }
    }
  ];

  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const notIn = /key NOT IN \(([^)]*)\)/.exec(body.jql);
    const excluded = notIn ? notIn[1].split(',').map((entry) => entry.trim()) : [];

    return {
      ok: true,
      status: 200,
      json: async () => ({ issues: issues.filter((issue) => !excluded.includes(issue.key)), isLast: true }),
      text: async () => ''
    };
  };
}

test('a limited sweep waits for resume before tagging and publishing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-bug-sweep-resume-'));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-bug-sweep-resume-agent-'));

  try {
    installSweepFixtureSkills(root);
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'sweep@example.com']);
    git(root, ['config', 'user.name', 'Sweep Bot']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(root, 'app.txt'), 'v1\n', 'utf8');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);

    const agentPath = createFakeAgent(agentDir);
    const baseArgs = [
      '--project', 'ABC',
      '--date', '2026-10-19',
      '--base', 'HEAD',
      '--limit', '1',
      '--agent-cmd', JSON.stringify([agentPath]),
      '--no-push',
      '--no-pr',
      ...jiraFlags
    ];
    const jiraFetch = createFilteringJiraFetch();

    const first = await runBugSweep(baseArgs, { cwd: root, agentPreset: 'claude', fetchImpl: jiraFetch, logger: () => {} });

    assert.match(first, /1 bug\(s\) still pending/);
    assert.equal(git(root, ['tag', '-l', 'bug-fix-2026-10-19']), '');
    assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '2');

    const second = await runBugSweep([...baseArgs, '--resume'], { cwd: root, agentPreset: 'claude', fetchImpl: jiraFetch, logger: () => {} });

    assert.match(second, /Fixed: 1\/2/);
    assert.equal(git(root, ['tag', '-l', 'bug-fix-2026-10-19']), 'bug-fix-2026-10-19');
    assert.equal(git(root, ['status', '--porcelain']), '');

    const state = JSON.parse(fs.readFileSync(path.join(root, '.bug-fix', 'state-2026-10-19.json'), 'utf8'));
    assert.equal(state.bugs.find((bug) => bug.key === 'ABC-2').status, 'not-fixed');
    assert.equal(state.phase, 'complete');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('a bug sweep commits fixed bugs, records failures, and tags the branch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-bug-sweep-'));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-bug-sweep-agent-'));

  try {
    installSweepFixtureSkills(root);
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'sweep@example.com']);
    git(root, ['config', 'user.name', 'Sweep Bot']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(root, 'app.txt'), 'v1\n', 'utf8');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);

    const argsFile = path.join(agentDir, 'agent-args.txt');
    const agentPath = createFakeAgent(agentDir, argsFile);
    const output = await runBugSweep([
      '--project', 'ABC',
      '--date', '2026-10-19',
      '--base', 'HEAD',
      '--agent-cmd', JSON.stringify([agentPath]),
      '--no-push',
      '--no-pr',
      ...jiraFlags
    ], { cwd: root, agentPreset: 'claude', fetchImpl: fakeFetch, logger: () => {} });

    assert.match(output, /Fixed: 1\/2/);
    const agentArgs = fs.readFileSync(argsFile, 'utf8');
    assert.match(agentArgs, /\/bug-sweep/);
    const taskPrompt = fs.readFileSync(path.join(root, '.bug-fix', 'ABC-1.prompt.md'), 'utf8');
    assert.match(taskPrompt, /Pass max_turns=5 to the bug-fix skill/);
    assert.match(output, /✅ ABC-1/);
    assert.match(output, /❌ ABC-2  Not fixed — Could not reproduce/);

    assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'bug-fix/2026-10-19');
    assert.equal(git(root, ['log', '-1', '--pretty=%s']), 'fix(ABC-1): Null guard');
    assert.equal(git(root, ['tag', '-l', 'bug-fix-2026-10-19']), 'bug-fix-2026-10-19');
    assert.equal(git(root, ['status', '--porcelain']), '');
    assert.match(git(root, ['show', '--name-only', '--pretty=format:', 'HEAD']), /app\.txt/);

    assert.ok(fs.existsSync(path.join(root, '.bug-fix', 'ABC-1.result.json')));
    assert.ok(fs.existsSync(path.join(root, '.bug-fix', 'ABC-2.result.json')));
    assert.ok(fs.existsSync(path.join(root, '.bug-fix', 'report-2026-10-19.md')));
    assert.ok(!fs.existsSync(path.join(root, '.bug-fix', '.lock')), 'the lock is released after the sweep');

    const state = JSON.parse(fs.readFileSync(path.join(root, '.bug-fix', 'state-2026-10-19.json'), 'utf8'));
    assert.equal(state.bugs.find((bug) => bug.key === 'ABC-1').status, 'fixed');
    assert.equal(state.bugs.find((bug) => bug.key === 'ABC-2').status, 'not-fixed');
    assert.equal(state.phase, 'complete');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('--worktree fixes bugs in an isolated checkout and leaves the main tree untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-bug-sweep-worktree-'));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-bug-sweep-worktree-agent-'));

  try {
    installSweepFixtureSkills(root);
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'sweep@example.com']);
    git(root, ['config', 'user.name', 'Sweep Bot']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(root, 'app.txt'), 'v1\n', 'utf8');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);

    const originalBranch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    // A dirty checkout must not block the sweep and must not be changed by it.
    fs.writeFileSync(path.join(root, 'app.txt'), 'local edit\n', 'utf8');

    const agentPath = createFakeAgent(agentDir);
    const output = await runBugSweep([
      '--project', 'ABC',
      '--date', '2026-10-19',
      '--base', 'HEAD',
      '--agent-cmd', JSON.stringify([agentPath]),
      '--worktree',
      '--no-push',
      '--no-pr',
      ...jiraFlags
    ], { cwd: root, agentPreset: 'claude', fetchImpl: fakeFetch, logger: () => {} });

    assert.match(output, /Fixed: 1\/2/);

    // The user's checkout kept its branch and its uncommitted edit.
    assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), originalBranch);
    assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'local edit\n');

    // The commits live on the sweep branch in the shared repository.
    assert.equal(git(root, ['log', '-1', '--pretty=%s', 'bug-fix/2026-10-19']), 'fix(ABC-1): Null guard');
    assert.equal(git(root, ['tag', '-l', 'bug-fix-2026-10-19']), 'bug-fix-2026-10-19');

    // The temporary worktree was removed after publishing.
    assert.equal(fs.existsSync(path.join(root, '.bug-fix', 'worktrees', 'bug-fix-2026-10-19')), false);
    const remaining = git(root, ['worktree', 'list', '--porcelain'])
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '));
    assert.equal(remaining.length, 1, 'only the main worktree remains');

    const state = JSON.parse(fs.readFileSync(path.join(root, '.bug-fix', 'state-2026-10-19.json'), 'utf8'));
    assert.equal(state.phase, 'complete');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('--fetch-base starts the worktree from the up-to-date remote branch', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-bug-sweep-remote-'));
  const remoteDir = path.join(parent, 'remote.git');
  const root = path.join(parent, 'work');
  const other = path.join(parent, 'other');
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-bug-sweep-remote-agent-'));

  try {
    fs.mkdirSync(remoteDir);
    git(remoteDir, ['init', '--bare', '-q']);
    git(parent, ['clone', '-q', remoteDir, root]);

    git(root, ['config', 'user.email', 'sweep@example.com']);
    git(root, ['config', 'user.name', 'Sweep Bot']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    installSweepFixtureSkills(root);

    fs.writeFileSync(path.join(root, 'app.txt'), 'v1\n', 'utf8');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);
    git(root, ['branch', '-M', 'main']);
    git(root, ['push', '-q', '-u', 'origin', 'main']);
    // Point the bare repo's HEAD at main so the next clone checks it out.
    git(remoteDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    // Another clone advances the remote after `root` last fetched.
    git(parent, ['clone', '-q', remoteDir, other]);
    git(other, ['config', 'user.email', 'sweep@example.com']);
    git(other, ['config', 'user.name', 'Sweep Bot']);
    git(other, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(other, 'remote-only.txt'), 'from-remote\n', 'utf8');
    git(other, ['add', '-A']);
    git(other, ['commit', '-q', '-m', 'remote follow-up']);
    git(other, ['push', '-q', 'origin', 'main']);

    const stale = spawnSync('git', ['show', 'origin/main:remote-only.txt'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(stale.status, 0, 'origin/main is stale before the sweep');

    const agentPath = createFakeAgent(agentDir);
    const output = await runBugSweep([
      '--project', 'ABC',
      '--date', '2026-10-19',
      '--base', 'main',
      '--fetch-base',
      '--agent-cmd', JSON.stringify([agentPath]),
      '--worktree',
      '--no-push',
      '--no-pr',
      ...jiraFlags
    ], { cwd: root, agentPreset: 'claude', fetchImpl: fakeFetch, logger: () => {} });

    assert.match(output, /Fixed: 1\/2/);

    // The sweep branch starts from the fetched remote commit, not the stale local ref.
    assert.equal(git(root, ['show', 'bug-fix/2026-10-19:remote-only.txt']), 'from-remote');
    assert.equal(git(root, ['show', 'origin/main:remote-only.txt']), 'from-remote');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});


test('--worktree keeps the checkout for --resume and removes it on completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-bug-sweep-worktree-resume-'));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-bug-sweep-worktree-resume-agent-'));

  try {
    installSweepFixtureSkills(root);
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'sweep@example.com']);
    git(root, ['config', 'user.name', 'Sweep Bot']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(root, 'app.txt'), 'v1\n', 'utf8');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);

    const originalBranch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const worktreePath = path.join(root, '.bug-fix', 'worktrees', 'bug-fix-2026-10-19');
    const agentPath = createFakeAgent(agentDir);
    const baseArgs = [
      '--project', 'ABC',
      '--date', '2026-10-19',
      '--base', 'HEAD',
      '--limit', '1',
      '--agent-cmd', JSON.stringify([agentPath]),
      '--worktree',
      '--no-push',
      '--no-pr',
      ...jiraFlags
    ];
    const jiraFetch = createFilteringJiraFetch();

    const first = await runBugSweep(baseArgs, { cwd: root, agentPreset: 'claude', fetchImpl: jiraFetch, logger: () => {} });

    assert.match(first, /1 bug\(s\) still pending/);
    assert.equal(fs.existsSync(worktreePath), true, 'the worktree is kept while bugs are pending');
    assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), originalBranch);

    const second = await runBugSweep([...baseArgs, '--resume'], { cwd: root, agentPreset: 'claude', fetchImpl: jiraFetch, logger: () => {} });

    assert.match(second, /Fixed: 1\/2/);
    assert.equal(fs.existsSync(worktreePath), false, 'the worktree is removed after the sweep completes');
    assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), originalBranch);
    assert.equal(git(root, ['rev-list', '--count', 'bug-fix/2026-10-19']), '2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('buildJiraAuthHeader picks basic or bearer from the email', () => {
  assert.equal(
    buildJiraAuthHeader({ auth: 'auto', email: 'bot@example.com', token: 't' }),
    `Basic ${Buffer.from('bot@example.com:t').toString('base64')}`
  );
  assert.equal(buildJiraAuthHeader({ auth: 'auto', email: null, token: 'pat' }), 'Bearer pat');
  assert.equal(buildJiraAuthHeader({ auth: 'bearer', email: 'bot@example.com', token: 'pat' }), 'Bearer pat');
  assert.equal(
    buildJiraAuthHeader({ auth: 'basic', email: 'bot@example.com', token: 'p' }),
    `Basic ${Buffer.from('bot@example.com:p').toString('base64')}`
  );
  assert.throws(() => buildJiraAuthHeader({ auth: 'nope', token: 'x' }), /Invalid --jira-auth/);
});

test('normalizeJiraApiVersion accepts auto, 2, v3, and rejects the rest', () => {
  assert.equal(normalizeJiraApiVersion('auto'), 'auto');
  assert.equal(normalizeJiraApiVersion('2'), '2');
  assert.equal(normalizeJiraApiVersion('v3'), '3');
  assert.throws(() => normalizeJiraApiVersion('4'), /Invalid --jira-api-version/);
});

test('describeJiraError separates TLS, DNS, and connection failures', () => {
  assert.equal(describeJiraError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }).kind, 'tls');
  assert.match(describeJiraError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }).hint, /--jira-ca/);
  assert.equal(describeJiraError({ code: 'ENOTFOUND' }).kind, 'dns');
  assert.equal(describeJiraError({ code: 'ECONNREFUSED' }).kind, 'connection');
  assert.equal(describeJiraError({ code: 'ETIMEDOUT' }).kind, 'network');
  assert.match(describeJiraStatus(401), /rejected the credentials/);
  assert.match(describeJiraStatus(403), /permission/);
  assert.match(describeJiraStatus(404), /base URL/);
});

test('parseBugSweepArgs accepts the Data Center Jira and forge flags', () => {
  const options = parseBugSweepArgs([
    '--project', 'ABC',
    '--jira-auth', 'bearer',
    '--jira-api-version', '2',
    '--jira-ca', '/etc/ssl/jira-ca.pem',
    '--jira-insecure',
    '--pr-cmd', 'glab mr create'
  ]);

  assert.equal(options.jiraAuth, 'bearer');
  assert.equal(options.jiraApiVersion, '2');
  assert.equal(options.jiraCa, '/etc/ssl/jira-ca.pem');
  assert.equal(options.jiraInsecure, true);
  assert.equal(options.prCommand, 'glab mr create');
});

test('fetchJiraBugs uses REST v2 and a bearer token for Data Center', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, headers: init.headers });

    return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
  };

  await fetchJiraBugs({
    baseUrl: 'https://jira.internal',
    auth: 'bearer',
    token: 'pat',
    apiVersion: '2',
    jql: 'project = ABC',
    limit: 5,
    fetchImpl: fake
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/api\/2\/search$/);
  assert.equal(calls[0].headers.Authorization, 'Bearer pat');
});

test('fetchJiraProjects falls back from v3 to v2 on Data Center', async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);

    if (url.includes('/rest/api/3/project/search')) {
      return { ok: false, status: 404, text: async () => 'not found' };
    }

    return { ok: true, status: 200, json: async () => [{ key: 'ABC', name: 'Alpha Team' }] };
  };

  const projects = await fetchJiraProjects({
    baseUrl: 'https://jira.internal',
    headers: {},
    apiVersion: 'auto',
    fetchImpl: fake
  });

  assert.deepEqual(projects, [{ key: 'ABC', name: 'Alpha Team' }]);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/rest\/api\/2\/project/);
});

test('probeJira reports success and TLS failures', async () => {
  const ok = await probeJira({
    baseUrl: 'https://jira.internal/',
    auth: 'bearer',
    token: 'pat',
    apiVersion: '2',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ name: 'jdoe', displayName: 'Jane Doe' })
    })
  });

  assert.equal(ok.ok, true);
  assert.equal(ok.apiVersion, '2');
  assert.equal(ok.user.displayName, 'Jane Doe');

  const failed = await probeJira({
    baseUrl: 'https://jira.internal',
    auth: 'bearer',
    token: 'pat',
    fetchImpl: async () => {
      throw Object.assign(new Error('self signed'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
    }
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.error.kind, 'tls');
});

test('createJiraFetch explains a bad CA path', () => {
  assert.throws(
    () => createJiraFetch({ caPath: path.join(os.tmpdir(), 'sdd-missing-ca.pem') }),
    /Could not read the Jira CA file/
  );
});

test('openMergeRequest runs a JSON argv command with placeholders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-pr-json-'));
  const bodyFile = path.join(dir, 'body.md');
  const outFile = path.join(dir, 'received.json');
  const script = path.join(dir, 'pr.js');

  try {
    fs.writeFileSync(bodyFile, 'Body line\n', 'utf8');
    fs.writeFileSync(script, [
      "const fs = require('node:fs');",
      'fs.writeFileSync(process.argv[2], JSON.stringify({',
      '  args: process.argv.slice(3),',
      '  body: process.env.SDD_PR_BODY,',
      '  title: process.env.SDD_PR_TITLE',
      '}));',
      "console.log('https://forge.example.com/mr/7');",
      ''
    ].join('\n'), 'utf8');

    const url = await openMergeRequest({
      cwd: dir,
      options: {
        prCommand: JSON.stringify([process.execPath, script, outFile, '{title}', '{bodyFile}', '{base}', '{head}']),
        branch: 'bug-fix/2026-10-19',
        remote: 'origin'
      },
      state: { base: 'main', project: 'ABC', date: '2026-10-19' },
      title: 'Fix 1 bug',
      bodyFile,
      logger: () => {}
    });

    assert.equal(url, 'https://forge.example.com/mr/7');

    const received = JSON.parse(fs.readFileSync(outFile, 'utf8'));

    assert.deepEqual(received.args, ['Fix 1 bug', bodyFile, 'main', 'bug-fix/2026-10-19']);
    assert.equal(received.body, 'Body line\n');
    assert.equal(received.title, 'Fix 1 bug');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openMergeRequest still runs a plain shell command', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-pr-shell-'));
  const bodyFile = path.join(dir, 'body.md');

  try {
    fs.writeFileSync(bodyFile, 'Body\n', 'utf8');

    const url = await openMergeRequest({
      cwd: dir,
      options: { prCommand: 'echo https://forge.example.com/mr/8', branch: 'b', remote: 'origin' },
      state: { base: 'main', project: 'ABC', date: '2026-10-19' },
      title: 't',
      bodyFile,
      logger: () => {}
    });

    assert.equal(url, 'https://forge.example.com/mr/8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildBranchPushArgs adds GitLab merge request push options', () => {
  const state = { base: 'main' };
  const title = 'fix: Jira bug sweep ABC 2026-10-21 (1 fixed)';
  const body = 'Body\n';

  assert.deepEqual(
    buildBranchPushArgs({
      options: { remote: 'origin', branch: 'bug-fix/2026-10-21', pr: true, gitlabPush: false },
      state,
      title,
      body
    }),
    ['push', '-u', 'origin', 'bug-fix/2026-10-21']
  );

  assert.deepEqual(
    buildBranchPushArgs({
      options: { remote: 'origin', branch: 'bug-fix/2026-10-21', pr: true, gitlabPush: true },
      state,
      title,
      body
    }),
    [
      'push', '-u', 'origin', 'bug-fix/2026-10-21',
      '-o', 'merge_request.create',
      '-o', 'merge_request.target=main',
      '-o', `merge_request.title=${title}`,
      '-o', `merge_request.description=${body}`
    ]
  );
});

test('extractMergeRequestUrl reads the URL from the GitLab push output', () => {
  const output = [
    'remote:',
    "remote: View merge request for 'bug-fix/2026-10-21':",
    'remote:   https://gitlab.example.com/group/project/-/merge_requests/42',
    'remote:'
  ].join('\n');

  assert.equal(extractMergeRequestUrl(output), 'https://gitlab.example.com/group/project/-/merge_requests/42');
  assert.equal(extractMergeRequestUrl('remote: nothing here'), null);
});
