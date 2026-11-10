import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run } from '../cli/index.js';
import {
  findNewestSpec,
  parseSpecIssueArgs,
  runSpecIssue
} from '../cli/spec-issue.js';

function tempWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-spec-issue-'));

  return cwd;
}

function writeSpec(cwd, feature, markdown, { mtime } = {}) {
  const dir = path.join(cwd, 'docs', 'sdd', 'features', feature);

  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'spec.md');

  fs.writeFileSync(file, markdown, 'utf8');

  if (mtime) {
    fs.utimesSync(file, mtime, mtime);
  }

  return file;
}

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
}

test('parseSpecIssueArgs reads the spec path and tracker options', () => {
  assert.deepEqual(
    parseSpecIssueArgs([
      'spec.md',
      '--source', 'GitHub',
      '--target', 'owner/repo',
      '--type', 'Story',
      '--labels', 'spec, feature',
      '--dry-run',
      '--json'
    ]),
    {
      specPath: 'spec.md',
      source: 'github',
      target: 'owner/repo',
      issueType: 'Story',
      labels: ['spec', 'feature'],
      dryRun: true,
      json: true,
      help: false
    }
  );

  assert.equal(parseSpecIssueArgs(['--source=jira', '--target=ABC']).source, 'jira');
  assert.throws(() => parseSpecIssueArgs(['--source', 'trello']), /--source expects/);
  assert.throws(() => parseSpecIssueArgs(['--target']), /Missing value/);
  assert.throws(() => parseSpecIssueArgs(['--unknown']), /Unknown option/);
});

test('findNewestSpec picks the most recently written spec', () => {
  const cwd = tempWorkspace();

  writeSpec(cwd, 'older', '# Feature: Older', { mtime: new Date('2024-01-01T00:00:00Z') });
  const newer = writeSpec(cwd, 'newer', '# Feature: Newer', { mtime: new Date('2025-01-01T00:00:00Z') });

  assert.equal(findNewestSpec(cwd), newer);
  assert.equal(findNewestSpec(path.join(cwd, 'missing')), '');
});

test('spec-issue dry run prints the plan without calling a tracker', async () => {
  const cwd = tempWorkspace();

  writeSpec(cwd, 'saved-searches', '# Feature: Saved searches\n\nRemember filters.');

  const text = await runSpecIssue(['--source', 'github', '--target', 'owner/repo', '--dry-run'], {
    cwd,
    settings: {}
  });

  assert.match(text, /Spec issue plan/);
  assert.match(text, /source {2}github/);
  assert.match(text, /target {2}owner\/repo/);
  assert.match(text, /title {3}Saved searches/);
  assert.ok(text.includes('spec    docs/sdd/features/saved-searches/spec.md'));

  const json = JSON.parse(await runSpecIssue(['--source', 'github', '--target', 'owner/repo', '--dry-run', '--json'], {
    cwd,
    settings: {}
  }));

  assert.equal(json.plan.title, 'Saved searches');
  assert.equal(json.plan.source, 'github');
});

test('spec-issue uses the saved source and target when flags are absent', async () => {
  const cwd = tempWorkspace();

  writeSpec(cwd, 'saved-searches', '# Feature: Saved searches', { mtime: new Date() });

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({ number: 5, html_url: 'https://github.com/owner/repo/issues/5' });
  };

  const result = await runSpecIssue([], {
    cwd,
    settings: { specIssueSource: 'github', githubRepo: 'owner/repo' },
    githubToken: 'secret',
    fetchImpl
  });

  assert.equal(result, 'Created GH-5: https://github.com/owner/repo/issues/5');
  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/repo/issues');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(JSON.parse(calls[0].options.body).title, 'Saved searches');
  assert.equal(JSON.parse(calls[0].options.body).body, '# Feature: Saved searches');
});

test('spec-issue files the spec in Jira with the configured project', async () => {
  const cwd = tempWorkspace();

  writeSpec(cwd, 'saved-searches', '# Feature: Saved searches');

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({ id: '9', key: 'ABC-9' });
  };

  const result = await runSpecIssue([], {
    cwd,
    settings: {
      specIssueSource: 'jira',
      project: 'ABC',
      jiraUrl: 'https://jira.example.com',
      jiraToken: 'token',
      jiraAuth: 'bearer',
      jiraApiVersion: '2'
    },
    fetchImpl
  });

  assert.equal(result, 'Created ABC-9: https://jira.example.com/browse/ABC-9');
  assert.equal(calls[0].url, 'https://jira.example.com/rest/api/2/issue');
  assert.equal(JSON.parse(calls[0].options.body).fields.description, '# Feature: Saved searches');
});

test('spec-issue refuses a missing target and a missing spec', async () => {
  const cwd = tempWorkspace();

  writeSpec(cwd, 'saved-searches', '# Feature: Saved searches');

  await assert.rejects(
    runSpecIssue([], { cwd, settings: { specIssueSource: 'github' } }),
    /Set a GitHub repository/
  );

  await assert.rejects(
    runSpecIssue(['missing.md'], { cwd, settings: {} }),
    /Spec file not found/
  );

  const empty = tempWorkspace();

  await assert.rejects(
    runSpecIssue([], { cwd: empty, settings: {} }),
    /No spec\.md found/
  );
});

test('the CLI routes spec-issue help', async () => {
  const help = await run(['spec-issue', '--help']);

  assert.match(help, /sdd spec-issue/);
  assert.match(help, /--source <jira\|github\|gitlab>/);
});
