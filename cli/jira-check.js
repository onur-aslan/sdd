import {
  createJiraFetch,
  fetchJiraBugs,
  normalizeJiraApiVersion,
  normalizeJiraAuth,
  probeJira
} from './bug-sweep.js';

const VALUE_FLAGS = new Set([
  '--jira-url',
  '--jira-email',
  '--jira-token',
  '--jira-auth',
  '--jira-api-version',
  '--jira-ca',
  '--project'
]);

const BOOLEAN_FLAGS = new Set([
  '--jira-insecure',
  '--json'
]);

export function formatJiraCheckHelp() {
  return `sdd jira-check - verify Jira reachability, TLS, and credentials

Usage:
  sdd jira-check [options]

Options:
  --jira-url <url>         Base URL; JIRA_BASE_URL also works
  --jira-token <token>     API token or personal access token; JIRA_API_TOKEN also works
  --jira-email <email>     Only for Basic auth (Cloud, or DC with a password)
  --jira-auth <mode>       auto | basic | bearer (default: auto)
                           A Data Center personal access token needs bearer and no email.
  --jira-api-version <v>   auto | 2 | 3 (default: auto). Data Center and Server use v2.
  --jira-ca <path>         PEM file for an internal or self-signed CA
  --jira-insecure          Skip TLS verification (last resort; prefer --jira-ca)
  --project <KEY>          Also verify a search against this project
  --json                   Print the result as JSON

Environment:
  JIRA_BASE_URL, JIRA_API_TOKEN, JIRA_EMAIL, JIRA_AUTH, JIRA_API_VERSION,
  JIRA_CA_CERT, JIRA_INSECURE=1

The command separates DNS, TCP, TLS, and HTTP failures and prints the fix for each,
which is what usually blocks Jira in air-gapped or self-hosted networks.`;
}

export function parseJiraCheckArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }

  const raw = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}". Use --help for usage.`);
    }

    const equalsIndex = token.indexOf('=');
    const name = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : token.slice(equalsIndex + 1);

    if (VALUE_FLAGS.has(name)) {
      const value = inlineValue ?? argv[index + 1];

      if (value === undefined || (inlineValue === null && value.startsWith('--'))) {
        throw new Error(`Missing value for ${name}.`);
      }

      if (inlineValue === null) {
        index += 1;
      }

      raw[name] = value;
      continue;
    }

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== null) {
        throw new Error(`${name} does not take a value.`);
      }

      raw[name] = true;
      continue;
    }

    throw new Error(`Unknown option ${name}. Use --help for usage.`);
  }

  return {
    help: false,
    json: Boolean(raw['--json']),
    project: raw['--project'] ?? null,
    baseUrl: raw['--jira-url'] ?? null,
    email: raw['--jira-email'] ?? null,
    token: raw['--jira-token'] ?? null,
    auth: raw['--jira-auth'] ?? null,
    apiVersion: raw['--jira-api-version'] ?? null,
    ca: raw['--jira-ca'] ?? null,
    insecure: Boolean(raw['--jira-insecure'])
  };
}

function resolveTarget(options, env) {
  const baseUrl = options.baseUrl ?? env.JIRA_BASE_URL ?? null;
  const email = options.email ?? env.JIRA_EMAIL ?? null;
  const token = options.token ?? env.JIRA_API_TOKEN ?? null;
  const auth = options.auth ?? env.JIRA_AUTH ?? 'auto';
  const apiVersion = options.apiVersion ?? env.JIRA_API_VERSION ?? 'auto';
  const ca = options.ca ?? env.JIRA_CA_CERT ?? null;
  const insecure = options.insecure || env.JIRA_INSECURE === '1';

  if (!baseUrl) {
    throw new Error('Jira base URL is required. Set JIRA_BASE_URL or pass --jira-url.');
  }
  if (!token) {
    throw new Error('Jira credentials are required. Set JIRA_API_TOKEN or pass --jira-token (a Data Center personal access token works without an email).');
  }

  const mode = normalizeJiraAuth(auth, email);

  if (mode === 'basic' && !email) {
    throw new Error('Basic authentication needs an email. Set JIRA_EMAIL or pass --jira-email, or use --jira-auth bearer with a personal access token.');
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ''), email, token, auth: mode, apiVersion, ca, insecure };
}

function formatTransportLine({ ca, insecure }) {
  if (insecure) {
    return 'insecure (TLS verification disabled)';
  }
  if (ca) {
    return `internal CA (${ca})`;
  }

  return 'system trust store';
}

function fail({ json }, message) {
  if (json) {
    return JSON.stringify({ ok: false, error: message }, null, 2);
  }

  return `Jira check\n\n  FAILED: ${message}`;
}

export async function runJiraCheck(argv = [], dependencies = {}) {
  const options = parseJiraCheckArgs(argv);

  if (options.help) {
    return formatJiraCheckHelp();
  }

  const env = dependencies.env ?? process.env;
  let target;

  try {
    target = resolveTarget(options, env);
  } catch (error) {
    if (dependencies.exitOnFailure) {
      process.exitCode = 1;
    }

    return fail(options, error.message);
  }

  const transport = dependencies.fetchImpl ?? createJiraFetch({ caPath: target.ca, insecure: target.insecure });

  const probe = await probeJira({
    baseUrl: target.baseUrl,
    auth: target.auth,
    email: target.email,
    token: target.token,
    apiVersion: target.apiVersion,
    ca: target.ca,
    insecure: target.insecure,
    fetchImpl: transport
  });

  const search = await trySearch({
    target,
    probe,
    project: options.project,
    transport
  });

  if (!probe.ok || search?.ok === false) {
    if (dependencies.exitOnFailure) {
      process.exitCode = 1;
    }
  }

  if (options.json) {
    return JSON.stringify({
      url: target.baseUrl,
      auth: target.auth,
      apiVersion: probe.apiVersion,
      transport: formatTransportLine(target),
      ok: probe.ok,
      user: probe.user ?? null,
      status: probe.status ?? null,
      error: probe.error ?? null,
      search
    }, null, 2);
  }

  const lines = [
    'Jira check',
    `  URL:       ${target.baseUrl}`,
    `  Auth:      ${target.auth}`,
    `  TLS:       ${formatTransportLine(target)}`,
    `  API:       ${probe.ok ? `v${probe.apiVersion}` : normalizeJiraApiVersion(target.apiVersion)}`
  ];

  if (probe.ok) {
    const who = probe.user?.displayName || probe.user?.name;

    lines.push(`  User:      ${who ? `${who}${probe.user?.name && who !== probe.user.name ? ` (${probe.user.name})` : ''}` : 'authenticated'}`);
  }

  if (search) {
    lines.push('', `  Search:    ${search.ok ? `ok${search.detail ? ` (${search.detail})` : ''}` : `FAILED - ${search.detail}`}`);
  }

  if (!probe.ok) {
    lines.push('', `  FAILED:    ${probe.error?.hint ?? 'Unknown Jira error.'}`);

    if (probe.error?.code) {
      lines.push(`  Code:      ${probe.error.code}`);
    }

    return lines.join('\n');
  }

  lines.push('', '  Jira is reachable and the credentials work.');

  return lines.join('\n');
}

async function trySearch({ target, probe, project, transport }) {
  if (!probe.ok) {
    return null;
  }

  const jql = project ? `project = "${project}"` : 'created >= -1d';

  try {
    const bugs = await fetchJiraBugs({
      baseUrl: target.baseUrl,
      auth: target.auth,
      email: target.email,
      token: target.token,
      apiVersion: probe.apiVersion,
      jql,
      limit: 5,
      fetchImpl: transport
    });

    return {
      ok: true,
      jql,
      detail: `${bugs.length} issue(s) for ${jql}`
    };
  } catch (error) {
    return { ok: false, jql, detail: error.message };
  }
}
