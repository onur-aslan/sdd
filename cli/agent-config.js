// Studio runs Claude Code exclusively. Provider and model details are not
// hardcoded: the user supplies an environment map in Studio settings, and only
// that map is merged into the Claude child process. Model names come from the
// installed Claude Code model picker when it can be read.
export const STUDIO_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const STUDIO_WORKFLOWS = ['enhancement', 'feature', 'specIssue', 'merge', 'bugSweep'];

// Claude Code reads these families of variables. Keeping the surface narrow
// avoids turning a settings field into arbitrary process-environment injection.
const CLAUDE_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'AWS_',
  'CLOUD_ML_',
  'VERTEX_',
  'GOOGLE_'
];

export const SECRET_CLAUDE_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN'
]);

const DEFAULT_WORKFLOW = Object.freeze({
  model: '',
  effort: '',
  mr: true
});

const WORKFLOW_DEFAULTS = Object.freeze({
  enhancement: { ...DEFAULT_WORKFLOW },
  feature: { ...DEFAULT_WORKFLOW },
  specIssue: { ...DEFAULT_WORKFLOW, mr: false },
  merge: { ...DEFAULT_WORKFLOW, mr: false },
  bugSweep: { ...DEFAULT_WORKFLOW }
});

const MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL'
];

function text(value, limit = 500) {
  return String(value ?? '').trim().slice(0, limit);
}

export function isAllowedClaudeEnvKey(key) {
  const name = text(key, 120);

  return Boolean(name) && CLAUDE_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function isSecretClaudeEnvKey(key) {
  return SECRET_CLAUDE_ENV_KEYS.has(text(key, 120));
}

// A flat string map is deliberate: Claude Code's configuration is environment
// based, and the child process is the only consumer.
export function normalizeClaudeEnv(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const env = {};

  for (const [key, raw] of Object.entries(input)) {
    const name = text(key, 120);

    if (!isAllowedClaudeEnvKey(name)) {
      continue;
    }

    const entry = text(raw, 4000);

    if (entry) {
      env[name] = entry;
    }
  }

  return env;
}

// Missing workflows inherit the documented defaults. Extra keys are dropped.
export function normalizeWorkflowSettings(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const workflows = {};

  for (const flow of STUDIO_WORKFLOWS) {
    const defaults = WORKFLOW_DEFAULTS[flow] ?? DEFAULT_WORKFLOW;
    const saved = input[flow] && typeof input[flow] === 'object' ? input[flow] : {};
    const effort = text(saved.effort, 20).toLowerCase();
    const model = text(saved.model, 200);
    const base = text(saved.base, 255);

    workflows[flow] = {
      model: model.toLowerCase() === 'default' ? '' : model,
      effort: effort === 'default' ? '' : STUDIO_EFFORTS.includes(effort) ? effort : '',
      base,
      mr: saved.mr === undefined ? defaults.mr : saved.mr === true || saved.mr === 'true'
    };
  }

  return workflows;
}

export function defaultWorkflowSettings() {
  return normalizeWorkflowSettings({});
}

// The selected model is a per-workflow override. An empty value means "use the
// environment and Claude Code's own default"; no model catalog is consulted.
export function resolveWorkflowSelection(settings = {}, flow, request = {}) {
  const workflows = normalizeWorkflowSettings(settings.workflows);
  const defaults = workflows[flow] ?? WORKFLOW_DEFAULTS[flow] ?? DEFAULT_WORKFLOW;
  const requestedModel = request.model !== undefined ? request.model : defaults.model;
  const model = text(requestedModel, 200).toLowerCase() === 'default'
    ? ''
    : text(requestedModel, 200);
  const requestedEffort = request.effort !== undefined ? request.effort : defaults.effort;
  const effort = text(requestedEffort, 20).toLowerCase() === 'default'
    ? ''
    : text(requestedEffort, 20).toLowerCase();
  const requestedBase = request.base !== undefined ? request.base : defaults.base;
  const base = text(requestedBase, 255);

  if (effort && !STUDIO_EFFORTS.includes(effort)) {
    const error = new Error(
      `Unknown effort "${effort}". Use one of ${STUDIO_EFFORTS.join(', ')}, or leave it on Default.`
    );

    error.statusCode = 400;
    throw error;
  }

  const mr = request.mr === undefined
    ? defaults.mr !== false
    : request.mr === true || request.mr === 'true';
  const args = [];

  if (model) {
    args.push('--model', model);
  }

  if (effort) {
    args.push('--effort', effort);
  }

  return {
    model,
    effort,
    base,
    mr,
    args,
    environment: normalizeClaudeEnv(settings.claudeEnv)
  };
}

// The model picker in Claude Code can be read with `claude -p "/model"
// --output-format json`; it is a local command and does not call the model.
// The response is human text, so parsing stays deliberately conservative.
export function parseClaudeModelList(result = '', claudeEnv = {}) {
  const textValue = String(result ?? '');
  const currentMatch = /Current model:\s*`([^`]+)`/i.exec(textValue);
  const availableMatch = /Available:\s*([^\n]+)/i.exec(textValue);
  const current = currentMatch?.[1]?.trim() ?? '';
  const available = [];

  if (availableMatch) {
    const cleaned = availableMatch[1]
      .replace(/\.\s*$/, '')
      .replace(/,?\s*or a full model ID\.?$/i, '')
      .trim();

    for (const item of cleaned.split(',')) {
      const value = item.trim();

      if (value && !/^or a full model ID$/i.test(value)) {
        available.push(value);
      }
    }
  }

  const env = normalizeClaudeEnv(claudeEnv);
  const fromEnv = MODEL_ENV_KEYS.map((key) => env[key]).filter(Boolean);
  const models = [...new Set([...available, current, ...fromEnv].filter(Boolean))];

  return { models, available, current };
}

export function modelOptionsFromEnv(claudeEnv = {}) {
  const env = normalizeClaudeEnv(claudeEnv);

  return [...new Set(MODEL_ENV_KEYS.map((key) => env[key]).filter(Boolean))];
}
