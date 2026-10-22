import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatJiraCheckHelp,
  parseJiraCheckArgs,
  runJiraCheck
} from '../cli/jira-check.js';
import { run } from '../cli/index.js';

test('parseJiraCheckArgs reads the Data Center flags', () => {
  const options = parseJiraCheckArgs([
    '--jira-url', 'https://jira.internal',
    '--jira-token', 'pat',
    '--jira-auth', 'bearer',
    '--jira-api-version', '2',
    '--jira-ca', '/etc/ssl/jira-ca.pem',
    '--jira-insecure',
    '--project', 'ABC',
    '--json'
  ]);

  assert.equal(options.baseUrl, 'https://jira.internal');
  assert.equal(options.auth, 'bearer');
  assert.equal(options.apiVersion, '2');
  assert.equal(options.ca, '/etc/ssl/jira-ca.pem');
  assert.equal(options.insecure, true);
  assert.equal(options.project, 'ABC');
  assert.equal(options.json, true);
});

test('runJiraCheck reports a healthy v2 Data Center connection', async () => {
  const fake = async (url) => {
    if (url.endsWith('/rest/api/2/myself')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: 'jdoe', displayName: 'Jane Doe' })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        issues: [{ key: 'ABC-1', id: '1', fields: { summary: 'Crash' } }],
        isLast: true
      })
    };
  };

  const output = await runJiraCheck([
    '--jira-url', 'https://jira.internal',
    '--jira-token', 'pat',
    '--jira-api-version', '2',
    '--project', 'ABC'
  ], { env: {}, fetchImpl: fake });

  assert.match(output, /Auth:\s+bearer/);
  assert.match(output, /API:\s+v2/);
  assert.match(output, /User:\s+Jane Doe \(jdoe\)/);
  assert.match(output, /Search:\s+ok/);
  assert.match(output, /Jira is reachable/);
});

test('runJiraCheck explains a TLS trust failure', async () => {
  const fake = async () => {
    throw Object.assign(new Error('self signed certificate'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
  };

  const output = await runJiraCheck([
    '--jira-url', 'https://jira.internal',
    '--jira-token', 'pat'
  ], { env: {}, fetchImpl: fake });

  assert.match(output, /FAILED:/);
  assert.match(output, /--jira-ca/);
  assert.match(output, /SELF_SIGNED_CERT_IN_CHAIN/);
});

test('runJiraCheck answers config errors without a stack trace', async () => {
  const missing = await runJiraCheck([], { env: {} });

  assert.match(missing, /FAILED: Jira base URL is required/);

  const noEmail = await runJiraCheck([
    '--jira-url', 'https://jira.internal',
    '--jira-token', 'pat',
    '--jira-auth', 'basic'
  ], { env: {} });

  assert.match(noEmail, /Basic authentication needs an email/);
});

test('runJiraCheck --json returns a machine-readable result', async () => {
  const fake = async (url) => {
    if (url.endsWith('/myself')) {
      return {
        ok: false,
        status: 401,
        json: async () => ({})
      };
    }

    return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
  };

  const output = await runJiraCheck([
    '--jira-url', 'https://jira.internal',
    '--jira-token', 'expired',
    '--json'
  ], { env: {}, fetchImpl: fake });
  const parsed = JSON.parse(output);

  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, 401);
  assert.match(parsed.error.hint, /rejected the credentials/);
});

test('jira-check help and CLI routing work', async () => {
  assert.match(formatJiraCheckHelp(), /sdd jira-check/);

  const routed = await run(['jira-check', '--help']);

  assert.match(routed, /verify Jira reachability/);
});
