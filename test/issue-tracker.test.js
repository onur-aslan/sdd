import test from 'node:test';
import assert from 'node:assert/strict';

import {
  closeGitHubIssue,
  closeGitLabIssue,
  closeJiraIssue,
  closeTrackerIssue,
  createGitHubIssue,
  createGitLabIssue,
  createJiraIssue,
  createTrackerIssue,
  normalizeSourceIssue,
  specIssueTitle
} from '../cli/issue-tracker.js';

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
}

test('normalizeSourceIssue keeps a supported key and its tracker target', () => {
  assert.deepEqual(
    normalizeSourceIssue({ source: 'Jira', key: 'abc-12', url: 'https://jira/browse/ABC-12', target: 'ABC' }),
    { source: 'jira', key: 'ABC-12', url: 'https://jira/browse/ABC-12', target: 'ABC' }
  );
  assert.deepEqual(
    normalizeSourceIssue({ source: 'github', key: 'gh-7', target: 'owner/repo' }),
    { source: 'github', key: 'GH-7', number: 7, url: '', target: 'owner/repo' }
  );
  assert.deepEqual(
    normalizeSourceIssue({ source: 'gitlab', key: 'GL-3', target: 'group/project' }),
    { source: 'gitlab', key: 'GL-3', number: 3, url: '', target: 'group/project' }
  );

  assert.equal(normalizeSourceIssue(null), null);
  assert.equal(normalizeSourceIssue({ source: 'github', key: 'ABC-1' }), null);
  assert.equal(normalizeSourceIssue({ source: 'merge', key: 'ABC-1' }), null);
  // A Jira project can legitimately use a key that looks like a forge prefix.
  assert.deepEqual(
    normalizeSourceIssue({ source: 'jira', key: 'GH-1' }),
    { source: 'jira', key: 'GH-1', url: '', target: '' }
  );
});

test('closeJiraIssue transitions an open issue into the Done category', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });

    if (!options.method) {
      return url.includes('?fields=status')
        ? jsonResponse({ fields: { status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } } })
        : jsonResponse({ transitions: [{ id: '31', to: { name: 'Done', statusCategory: { key: 'done' } } }] });
    }

    return jsonResponse({}, { status: 204 });
  };

  const result = await closeJiraIssue({
    key: 'ABC-1',
    baseUrl: 'https://jira.example.com/',
    headers: { Authorization: 'Bearer token' },
    apiVersion: '3',
    fetchImpl
  });

  assert.deepEqual(result, { closed: true, status: 'Done' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://jira.example.com/rest/api/3/issue/ABC-1?fields=status');
  assert.equal(calls[1].url, 'https://jira.example.com/rest/api/3/issue/ABC-1/transitions');
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(calls[2].options.body, JSON.stringify({ transition: { id: '31' } }));
});

test('closeJiraIssue leaves an already-done issue untouched', async () => {
  let posts = 0;
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') {
      posts += 1;
    }

    return jsonResponse({
      fields: { status: { name: 'Done', statusCategory: { key: 'done' } } }
    });
  };

  const result = await closeJiraIssue({
    key: 'ABC-2',
    baseUrl: 'https://jira.example.com',
    headers: {},
    apiVersion: '2',
    fetchImpl
  });

  assert.deepEqual(result, { closed: true, status: 'Done', already: true });
  assert.equal(posts, 0);
});

test('closeGitHubIssue sends a close request to the stored repository', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({ state: 'closed' });
  };

  const result = await closeGitHubIssue({
    repo: 'owner/repo',
    number: 12,
    token: 'secret',
    fetchImpl
  });

  assert.deepEqual(result, { closed: true, status: 'Closed' });
  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/repo/issues/12');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].options.body, JSON.stringify({ state: 'closed' }));
});

test('closeGitLabIssue closes the issue through glab api', async () => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: JSON.stringify({ state: 'closed' }), stderr: '' };
  };

  const result = await closeGitLabIssue({
    project: 'group/subgroup/project',
    number: 9,
    cwd: 'C:/work',
    run
  });

  assert.deepEqual(result, { closed: true, status: 'Closed' });
  assert.equal(calls[0].command, 'glab');
  assert.deepEqual(calls[0].args, [
    'api',
    '--method', 'PUT',
    'projects/group%2Fsubgroup%2Fproject/issues/9',
    '-f', 'state_event=close'
  ]);
  assert.equal(calls[0].options.cwd, 'C:/work');
});

test('closeTrackerIssue prefers the issue target captured at import time', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({});
  };

  await closeTrackerIssue({
    issue: { source: 'github', key: 'GH-4', target: 'captured/repo' },
    github: { repo: 'current/repo', token: '', fetchImpl }
  });

  assert.equal(calls[0].url, 'https://api.github.com/repos/captured/repo/issues/4');
});

test('specIssueTitle reads the deep-spec heading, then the first heading', () => {
  assert.equal(specIssueTitle('# Feature: Saved searches\n\n## Goal\n…'), 'Saved searches');
  assert.equal(specIssueTitle('# Saved searches\n'), 'Saved searches');
  assert.equal(specIssueTitle('No heading here', 'fallback-name'), 'fallback-name');
  assert.equal(specIssueTitle('', ''), 'Feature spec');
});

test('createJiraIssue posts the spec as ADF on Cloud and plain text on Data Center', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({ id: '10001', key: 'ABC-9' });
  };
  const body = '# Feature: Saved searches\n\nRemember filters.';

  const cloud = await createJiraIssue({
    project: 'ABC',
    summary: 'Saved searches',
    description: body,
    baseUrl: 'https://jira.example.com/',
    headers: { Authorization: 'Bearer token' },
    apiVersion: '3',
    fetchImpl
  });

  assert.deepEqual(cloud, {
    created: true,
    source: 'jira',
    key: 'ABC-9',
    id: '10001',
    url: 'https://jira.example.com/browse/ABC-9'
  });
  assert.equal(calls[0].url, 'https://jira.example.com/rest/api/3/issue');
  const fields = JSON.parse(calls[0].options.body).fields;
  assert.equal(fields.project.key, 'ABC');
  assert.equal(fields.issuetype.name, 'Task');
  assert.equal(fields.description.type, 'doc');
  assert.equal(fields.description.content[0].content[0].text, '# Feature: Saved searches');

  await createJiraIssue({
    project: 'ABC',
    summary: 'Saved searches',
    description: body,
    baseUrl: 'https://jira.example.com',
    apiVersion: '2',
    fetchImpl
  });

  assert.equal(calls[1].url, 'https://jira.example.com/rest/api/2/issue');
  assert.equal(JSON.parse(calls[1].options.body).fields.description, body);
});

test('createGitHubIssue posts the title, body, and labels', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({ number: 21, html_url: 'https://github.com/owner/repo/issues/21' });
  };

  const result = await createGitHubIssue({
    repo: 'owner/repo',
    title: 'Saved searches',
    body: '# Feature: Saved searches',
    labels: ['spec', 'feature'],
    token: 'secret',
    fetchImpl
  });

  assert.deepEqual(result, {
    created: true,
    source: 'github',
    key: 'GH-21',
    number: 21,
    url: 'https://github.com/owner/repo/issues/21'
  });
  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/repo/issues');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    title: 'Saved searches',
    body: '# Feature: Saved searches',
    labels: ['spec', 'feature']
  });
});

test('createGitLabIssue posts through glab api and keeps the spec body', async () => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: JSON.stringify({ iid: 7, web_url: 'https://gitlab.example.com/group/repo/-/issues/7' }), stderr: '' };
  };

  const result = await createGitLabIssue({
    project: 'group/repo',
    title: 'Saved searches',
    description: '# Feature: Saved searches',
    labels: ['spec'],
    cwd: 'C:/work',
    run
  });

  assert.deepEqual(result, {
    created: true,
    source: 'gitlab',
    key: 'GL-7',
    number: 7,
    url: 'https://gitlab.example.com/group/repo/-/issues/7'
  });
  assert.deepEqual(calls[0].args, [
    'api',
    '--method', 'POST',
    'projects/group%2Frepo/issues',
    '-f', 'title=Saved searches',
    '-f', 'description=# Feature: Saved searches',
    '-f', 'labels[]=spec'
  ]);
  assert.equal(calls[0].options.cwd, 'C:/work');
});

test('createTrackerIssue dispatches to the requested tracker', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({ number: 3, html_url: 'https://github.com/owner/repo/issues/3' });
  };

  const result = await createTrackerIssue({
    source: 'github',
    target: 'owner/repo',
    title: 'Saved searches',
    body: 'spec',
    github: { token: 'secret', fetchImpl }
  });

  assert.equal(result.key, 'GH-3');
  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/repo/issues');
});
