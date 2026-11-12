const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeText(value) {
  return window.SDDMarkdown ? window.SDDMarkdown.escapeHtml(value) : String(value ?? '');
}

const el = {
  repoInfo: $('#repo-info'),
  versionChip: $('#version-chip'),
  connection: $('#connection'),
  connectionText: $('#connection-text'),
  trackerInfo: $('#tracker-info'),
  form: $('#sweep-form'),
  formError: $('#form-error'),
  startBtn: $('#start-btn'),
  cancelBtn: $('#cancel-btn'),
  previewBtn: $('#preview-btn'),
  reloadProjects: $('#reload-projects'),
  projectList: $('#project-list'),
  projectLabel: $('#project-label'),
  source: $('#bug-source'),
  githubRepoLabel: $('#github-repo-label'),
  githubInfo: $('#github-info'),
  checkGitHub: $('#check-github'),
  forgetGitHub: $('#forget-github'),
  githubCheckResult: $('#github-check-result'),
  checkGitLab: $('#check-gitlab'),
  gitlabCheckResult: $('#gitlab-check-result'),
  bugPicker: $('#bug-picker'),
  bugCount: $('#bug-count'),
  reloadBugs: $('#reload-bugs'),
  toggleBugs: $('#toggle-bugs'),
  planSummary: $('#plan-summary'),
  advancedToggle: $('#advanced-toggle'),
  advancedBody: $('#advanced-body'),
  sweepModelPicker: $('#sweep-model-picker'),
  sweepEffort: $('#sweep-effort'),
  claudeEnv: $('#claude-env'),
  addClaudeEnv: $('#add-claude-env'),
  refreshModels: $('#refresh-models'),
  modelSource: $('#model-source'),
  workflowDefaults: $('#workflow-defaults'),
  prPreset: $('#pr-preset'),
  prCustomField: $('#pr-custom-field'),
  checkJira: $('#check-jira'),
  forgetJira: $('#forget-jira'),
  jiraType: $('#jira-type'),
  jiraUrlLabel: $('#jira-url-label'),
  jiraEmailField: $('#jira-email-field'),
  jiraTokenLabel: $('#jira-token-label'),
  jiraCloudHint: $('#jira-cloud-hint'),
  jiraDatacenterHint: $('#jira-datacenter-hint'),
  jiraDatacenterTls: $('#jira-datacenter-tls'),
  jiraCheckResult: $('#jira-check-result'),
  settingsDialog: $('#settings-dialog'),
  settingsClose: $('#settings-close'),
  settingsDone: $('#settings-done'),
  settingsStatus: $('#settings-status'),
  scopeMeta: $('#scope-meta'),
  progressTrack: $('#progress-track'),
  copyLog: $('#copy-log'),
  announcer: $('#announcer'),
  runTitle: $('#run-title'),
  runMeta: $('#run-meta'),
  runBadge: $('#run-badge'),
  progressBar: $('#progress-bar'),
  progressLabel: $('#progress-label'),
  bugList: $('#bug-list'),
  log: $('#log'),
  runFoot: $('#run-foot'),
  runSummary: $('#run-summary'),
  prLink: $('#pr-link'),
  interview: $('#interview'),
  interviewTitle: $('#interview-title'),
  interviewPrompt: $('#interview-prompt'),
  interviewBody: $('#interview-body'),
  interviewSubmit: $('#interview-submit')
};

const state = {
  config: null,
  models: [],
  modelsError: '',
  jobId: null,
  source: null,
  bugs: new Map(),
  total: 0,
  fixed: 0,
  currentQuestion: null,
  issueBugs: [],
  issueKeys: [],
  selectedIssues: new Set(),
  loadedSource: '',
  loadedTarget: '',
  bugRequestId: 0,
  bugLoadTimer: null,
  bugLoadError: false
};

const mermaidCache = new Map();
let mermaidLoader = null;
let mermaidSequence = 0;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
}

function currentSource() {
  return ['github', 'gitlab'].includes(el.form.source?.value) ? el.form.source.value : 'jira';
}

function currentTarget(source = currentSource()) {
  if (source === 'github') return el.form.githubRepo.value.trim();
  if (source === 'gitlab') return el.form.gitlabProject.value.trim();
  return el.form.project.value.trim();
}

function currentQueryKey() {
  const source = currentSource();

  return `${source}:${currentTarget(source)}`;
}

function targetLabel(source = currentSource()) {
  return source === 'github' ? 'repository' : 'project';
}

function setConnection(mode, text) {
  el.connection.classList.toggle('live', mode === 'live');
  el.connection.classList.toggle('down', mode === 'down');
  el.connectionText.textContent = text;
}

function setBadge(kind, text) {
  el.runBadge.className = `badge ${kind}`;
  el.runBadge.textContent = text;
}

function announceStatus(text) {
  if (!el.announcer) {
    return;
  }

  el.announcer.textContent = '';
  window.setTimeout(() => {
    el.announcer.textContent = text;
  }, 30);
}

async function copyLog() {
  const text = el.log.textContent;

  if (!text.trim()) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    el.copyLog.textContent = 'Copied';
    window.setTimeout(() => {
      el.copyLog.textContent = 'Copy';
    }, 1400);
  } catch {
    el.copyLog.textContent = 'Select to copy';
    window.setTimeout(() => {
      el.copyLog.textContent = 'Copy';
    }, 1800);
  }
}

function appendLog(line) {
  el.log.textContent += `${line}\n`;
  el.log.scrollTop = el.log.scrollHeight;
}

function updateProgress() {
  const total = state.total || state.bugs.size || 0;
  const percent = total === 0 ? 0 : Math.round((state.fixed / total) * 100);

  el.progressBar.style.width = `${percent}%`;
  el.progressLabel.textContent = `${state.fixed} fixed of ${total} matched`;

  if (el.progressTrack) {
    el.progressTrack.setAttribute('aria-valuenow', String(percent));
    el.progressTrack.setAttribute('aria-valuetext', `${state.fixed} of ${total} fixed`);
  }
}

function resetRun() {
  state.bugs.clear();
  state.total = 0;
  state.fixed = 0;
  el.bugList.innerHTML = '';
  el.log.textContent = '';
  el.runFoot.classList.add('hidden');
  el.prLink.classList.add('hidden');
  el.runSummary.textContent = '';
  updateProgress();
}

function addBugRow(bug) {
  const item = document.createElement('li');
  item.className = 'bug';

  const key = document.createElement('span');
  key.className = 'key';
  key.textContent = bug.key;

  const body = document.createElement('div');
  const summary = document.createElement('div');
  summary.className = 'summary';
  summary.textContent = bug.summary || '';
  const detail = document.createElement('div');
  detail.className = 'detail';
  body.append(summary, detail);

  const badge = document.createElement('span');
  badge.className = 'state pending';
  badge.textContent = 'pending';

  item.append(key, body, badge);
  el.bugList.append(item);
  state.bugs.set(bug.key, { item, summary, detail, badge });
}

function updateBug(key, patch) {
  let row = state.bugs.get(key);

  if (!row) {
    addBugRow({ key, summary: patch.summary });
    row = state.bugs.get(key);
  }

  if (patch.summary) {
    row.summary.textContent = patch.summary;
  }

  const status = patch.status ?? 'pending';
  const critical = patch.critical === true;

  row.badge.className = `state ${critical ? 'critical' : status}`;
  row.badge.textContent = critical ? 'review' : status;

  const details = [];

  if (patch.commit) {
    details.push(`commit ${String(patch.commit).slice(0, 7)}`);
  }
  if (status === 'fixed' && patch.how) {
    details.push(patch.how);
  }
  if (patch.reason) {
    details.push(patch.reason);
  }
  if (critical && patch.criticalReason) {
    details.push(`human review: ${patch.criticalReason}`);
  }

  row.detail.textContent = details.join(' · ');
  row.detail.className = `detail${critical ? ' critical' : ''}`;
}

function renderBugs(bugs) {
  state.bugs.clear();
  el.bugList.innerHTML = '';
  state.total = bugs.length;

  for (const bug of bugs) {
    addBugRow(bug);
  }

  updateProgress();
}

function showPr(url) {
  el.runFoot.classList.remove('hidden');
  el.prLink.href = url;
  el.prLink.classList.remove('hidden');
}

function setRunLocked(locked) {
  el.startBtn.disabled = locked;
  el.previewBtn.disabled = locked;
  el.reloadBugs.disabled = locked;
  el.form.project.disabled = locked;
  el.form.githubRepo.disabled = locked;
  el.form.gitlabProject.disabled = locked;
  el.form.source.disabled = locked;
  el.reloadProjects.disabled = locked;

  for (const input of $$('#bug-picker input[type="checkbox"]')) {
    input.disabled = locked;
  }

  if (locked) {
    el.toggleBugs.disabled = true;
  } else {
    updateBugCount();
  }
}

function finish(kind, text, summary) {
  setBadge(kind, text);
  el.cancelBtn.disabled = true;
  setConnection('live', 'connected');
  setRunLocked(false);
  announceStatus(summary || `Run ${text}.`);

  if (state.source) {
    state.source.close();
    state.source = null;
  }

  if (summary) {
    el.runFoot.classList.remove('hidden');
    el.runSummary.textContent = summary;
  }
}

function handleEvent(event) {
  switch (event.type) {
    case 'job-started':
      setBadge('running', 'running');
      break;
    case 'sweep-started':
      el.runTitle.textContent = event.dryRun ? 'Dry run' : `Fixing bugs in ${event.project}`;
      el.runMeta.textContent = [event.branch, event.tag ? `tag ${event.tag}` : null, event.date].filter(Boolean).join(' · ');
      break;
    case 'bugs-found':
      renderBugs(event.bugs ?? []);
      el.runMeta.textContent = `${event.total} bug(s) matched`;
      break;
    case 'bug-started':
      updateBug(event.key, { summary: event.summary, status: 'running' });
      break;
    case 'bug-finished':
      if (event.status === 'fixed') {
        state.fixed += 1;
      }
      updateBug(event.key, event);
      updateProgress();
      break;
    case 'publishing':
      el.runMeta.textContent = 'Publishing branch and pull request…';
      break;
    case 'issue-closed':
      appendLog(`Closed ${event.key}${event.status ? ` as ${event.status}` : ''}.`);
      break;
    case 'issue-close-failed':
      appendLog(`Could not close ${event.key}: ${event.error}`);
      break;
    case 'sweep-finished':
      if (event.prUrl) {
        showPr(event.prUrl);
      }
      break;
    case 'sweep-cancelled':
      setBadge('cancelled', 'cancelled');
      break;
    case 'log':
      appendLog(event.line);
      break;
    case 'job-done':
      finish('done', 'done', event.summary);
      break;
    case 'job-cancelled':
      finish('cancelled', 'cancelled', event.summary);
      break;
    case 'job-failed':
      finish('failed', 'failed', `Failed: ${event.message}`);
      break;
    case 'question':
      showQuestion(event);
      break;
    default:
      break;
  }
}

function attach(jobId) {
  if (state.source) {
    state.source.close();
  }

  state.jobId = jobId;
  el.cancelBtn.disabled = false;
  setConnection('live', 'live');
  setRunLocked(true);

  const source = new EventSource(`/api/sweeps/${jobId}/events`);

  state.source = source;
  source.onmessage = (message) => handleEvent(JSON.parse(message.data));
  source.onopen = () => setConnection('live', 'live');
  source.onerror = () => setConnection('down', 'reconnecting');
}

function efforts() {
  return state.config?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max'];
}

function modelOptions() {
  return state.models ?? [];
}

function workflowSettings(flow) {
  return state.config?.workflows?.[flow] ?? {
    model: '',
    effort: '',
    mr: true
  };
}

function modelLabel(id) {
  return id ? String(id) : 'Default';
}

const CUSTOM_MODEL = '__custom__';

// Claude Code exposes a short list of aliases, while a gateway can expose any
// model id. The picker keeps both: known ids in a select, plus a custom field.
function modelChoices() {
  const seen = new Set();
  const choices = [];

  for (const entry of [...(state.models ?? []), ...envModels()]) {
    const value = String(entry ?? '').trim();

    if (!value || value === CUSTOM_MODEL || value.toLowerCase() === 'default' || seen.has(value)) {
      continue;
    }

    seen.add(value);
    choices.push(value);
  }

  return choices;
}

function fillModelPicker(picker, selected) {
  const select = picker?.querySelector('select');
  const input = picker?.querySelector('input');

  if (!select || !input) {
    return;
  }

  const value = String(selected ?? '').trim();
  const choices = modelChoices();
  const custom = value !== '' && value.toLowerCase() !== 'default' && !choices.includes(value);

  select.replaceChildren(new Option('Default', ''));

  for (const model of choices) {
    select.append(new Option(model, model));
  }

  select.append(new Option('Custom…', CUSTOM_MODEL));
  select.value = custom ? CUSTOM_MODEL : choices.includes(value) ? value : '';
  input.value = custom ? value : '';
  input.classList.toggle('hidden', !custom);
}

function modelPickerValue(picker) {
  const select = picker?.querySelector('select');
  const input = picker?.querySelector('input');

  if (!select) {
    return '';
  }

  if (select.value !== CUSTOM_MODEL) {
    return select.value;
  }

  return (input?.value ?? '').trim();
}

function wireModelPicker(picker, onChange) {
  const select = picker?.querySelector('select');
  const input = picker?.querySelector('input');

  if (!select || !input) {
    return;
  }

  select.addEventListener('change', () => {
    const custom = select.value === CUSTOM_MODEL;

    input.classList.toggle('hidden', !custom);

    if (custom) {
      input.focus();
    }

    onChange?.();
  });
  input.addEventListener('input', () => onChange?.());
}

function fillEffortSelect(select, selected) {
  if (!select) {
    return;
  }

  select.replaceChildren(new Option('Default', ''));

  for (const effort of efforts()) {
    select.append(new Option(effort, effort));
  }

  select.value = efforts().includes(selected) ? selected : '';
}

function selectionFrom(prefix) {
  const selection = {
    model: prefix.modelPicker ? modelPickerValue(prefix.modelPicker) : prefix.model?.value || '',
    effort: prefix.effort?.value || ''
  };

  // Workflows without a merge-request control keep their stored choice. Only
  // enhancement and feature render the checkbox.
  if (prefix.mr) {
    selection.mr = prefix.mr.checked !== false;
  }

  return selection;
}

function currentSelection(flow) {
  return workflowSettings(flow);
}

// The workflow form is the default, not a one-off: every change is remembered
// so the next session opens with the same model, effort, and MR choice.
let workflowSaveTimer = null;

function rememberWorkflow(flow, selection) {
  if (!state.config) {
    return;
  }

  const current = state.config.workflows?.[flow] ?? {};
  const mr = selection.mr === undefined ? current.mr !== false : selection.mr !== false;

  state.config.workflows = {
    ...(state.config.workflows ?? {}),
    [flow]: { ...selection, mr }
  };

  window.clearTimeout(workflowSaveTimer);
  workflowSaveTimer = window.setTimeout(async () => {
    try {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ workflows: state.config.workflows })
      });
    } catch {
      // Remembering the form is a convenience; a session can still start.
    }
  }, 250);
}

function renderSweepSelection() {
  const selection = workflowSettings('bugSweep');

  fillModelPicker(el.sweepModelPicker, selection.model);
  fillEffortSelect(el.sweepEffort, selection.effort);
}

function prPresets() {
  return state.config?.prPresets ?? [];
}

function prPresetCommand(id) {
  return prPresets().find((preset) => preset.id === id)?.command ?? '';
}

function inferPrPreset(prCommand) {
  if (!prCommand) {
    return state.config?.defaults?.prPreset || 'github';
  }

  const match = prPresets().find((preset) => preset.id !== 'custom' && preset.command === prCommand);

  return match ? match.id : 'custom';
}

function togglePrCustom() {
  el.prCustomField.classList.toggle('hidden', el.form.prPreset.value !== 'custom');
}

// Publishing always pushes the branch. The only remaining choice is whether a
// merge request opens too, so an old commit-only setting maps to a plain push.
function publishChoice(settings = {}) {
  if (settings.publish === 'pr') {
    return 'pr';
  }

  if (settings.publish === 'push' || settings.publish === 'commit') {
    return 'push';
  }

  return settings.push === false || settings.pr === false ? 'push' : 'pr';
}

function formRequest({ dryRun = false } = {}) {
  const data = new FormData(el.form);
  const text = (name) => (data.get(name) ?? '').toString().trim();
  const checked = (name) => data.get(name) === 'on';
  const model = modelPickerValue(el.sweepModelPicker);
  const effort = text('effort');
  const mr = publishChoice(state.config?.settings ?? {}) === 'pr';
  const prPreset = text('prPreset') || 'github';
  const prCommand = prPreset === 'custom' ? text('prCommand') : prPresetCommand(prPreset);
  const gitlabPush = prPreset === 'gitlab-push';
  const jiraType = text('jiraType') === 'datacenter' ? 'datacenter' : 'cloud';
  const jiraAuth = jiraType === 'cloud' ? 'basic' : 'bearer';
  const jiraApiVersion = jiraType === 'cloud' ? '3' : '2';
  const source = ['github', 'gitlab'].includes(text('source')) ? text('source') : 'jira';
  const publish = text('publish') === 'push' ? 'push' : 'pr';
  const project = text('project');
  const githubRepo = text('githubRepo');
  const gitlabProject = text('gitlabProject');
  const target = source === 'github' ? githubRepo : source === 'gitlab' ? gitlabProject : project;
  // Only trust the selection when it belongs to the source and target currently
  // in the form. A stale Jira selection must never become GitHub issue numbers.
  const issues = state.loadedSource === source
    && state.loadedTarget === target
    && !allIssuesSelected()
    ? selectedIssueKeys()
    : [];

  return {
    source,
    project,
    githubRepo,
    gitlabProject,
    githubLabel: text('githubLabel'),
    issues,
    base: text('base'),
    model,
    effort,
    mr,
    verifyCmd: state.config?.defaults?.verifyCommand ?? '',
    jiraType,
    jiraUrl: text('jiraUrl'),
    // An email only matters for Basic auth; auto and bearer use the token alone.
    jiraEmail: jiraType === 'cloud' ? text('jiraEmail') : '',
    jiraToken: text('jiraToken'),
    jiraAuth,
    jiraApiVersion: text('jiraApiVersion'),
    jiraCa: jiraType === 'datacenter' ? text('jiraCa') : '',
    jiraInsecure: jiraType === 'datacenter' && checked('jiraInsecure'),
    prPreset,
    prCommand,
    gitlabPush,
    dryRun,
    publish,
    // The sweep is always isolated and always starts from a fresh base. The
    // single per-user branch resumes when possible, and failed bugs are retried.
    resume: true,
    retryFailed: true,
    worktree: true,
    fetchBase: true,
    closeIssues: checked('closeIssues'),
    push: true,
    pr: publish === 'pr'
  };
}

function trackerPayload(request = formRequest()) {
  return {
    source: request.source,
    jiraType: request.jiraType,
    jiraUrl: request.jiraUrl,
    jiraEmail: request.jiraEmail,
    jiraToken: request.jiraToken,
    jiraAuth: request.jiraAuth,
    jiraApiVersion: request.jiraApiVersion,
    jiraCa: request.jiraCa,
    jiraInsecure: request.jiraInsecure,
    githubRepo: request.githubRepo,
    githubLabel: request.githubLabel,
    gitlabProject: request.gitlabProject
  };
}

function allIssuesSelected() {
  return state.issueKeys.length > 0 && state.issueKeys.every((key) => state.selectedIssues.has(key));
}

function selectedIssueKeys() {
  return state.issueKeys.filter((key) => state.selectedIssues.has(key));
}

function bugLoadReady() {
  const source = currentSource();

  return state.loadedSource === source && state.loadedTarget === currentTarget(source);
}

function updateBugCount() {
  const total = state.issueKeys.length;
  const selected = selectedIssueKeys().length;
  const label = targetLabel();

  if (total === 0) {
    el.bugCount.textContent = !bugLoadReady()
      ? `pick a ${label}`
      : state.bugLoadError
        ? 'not loaded'
        : 'no open bugs';
    el.toggleBugs.disabled = true;
    el.toggleBugs.textContent = 'Select none';
    return;
  }

  el.bugCount.textContent = selected === total
    ? `all ${total} selected`
    : `${selected} of ${total} selected`;
  el.toggleBugs.disabled = false;
  el.toggleBugs.textContent = selected === total ? 'Select none' : 'Select all';
}

function renderBugPicker(error = '') {
  state.bugLoadError = Boolean(error);
  el.bugPicker.innerHTML = '';

  if (error || state.issueBugs.length === 0) {
    const message = document.createElement('p');
    message.className = 'bug-picker-empty';
    message.textContent = error || `No open bugs in this ${targetLabel()}.`;
    el.bugPicker.append(message);

    if (error) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'text-action';
      action.textContent = 'Open Settings';
      action.addEventListener('click', openAdvanced);
      el.bugPicker.append(action);
    }

    updateBugCount();
    return;
  }

  for (const bug of state.issueBugs) {
    const label = document.createElement('label');
    label.className = 'bug-choice';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = bug.key;
    input.checked = state.selectedIssues.has(bug.key);

    const key = document.createElement('span');
    key.className = 'bug-key';
    key.textContent = bug.key;

    const summary = document.createElement('span');
    summary.className = 'bug-summary';
    summary.textContent = bug.summary || '';
    summary.title = bug.summary || '';

    const meta = document.createElement('span');
    meta.className = 'bug-meta';
    meta.textContent = bug.priority || '';

    label.title = [bug.key, bug.summary, bug.priority].filter(Boolean).join(' · ');

    label.append(input, key, summary, meta);
    el.bugPicker.append(label);
  }

  updateBugCount();
}

function toggleAllIssues() {
  if (allIssuesSelected()) {
    state.selectedIssues.clear();
  } else {
    for (const key of state.issueKeys) {
      state.selectedIssues.add(key);
    }
  }

  for (const input of $$('input[type="checkbox"]', el.bugPicker)) {
    input.checked = state.selectedIssues.has(input.value);
  }

  updateBugCount();
  updatePlan();
}

async function loadBugs({ force = false } = {}) {
  const source = currentSource();
  const target = currentTarget(source);

  if (!force && state.loadedSource === source && state.loadedTarget === target) {
    return;
  }

  const requestId = ++state.bugRequestId;

  state.loadedSource = source;
  state.loadedTarget = target;
  state.issueBugs = [];
  state.issueKeys = [];
  state.selectedIssues.clear();

  if (!target) {
    const targetHint = source === 'github'
      ? 'Set a GitHub repository in Settings to load its issues.'
      : source === 'gitlab'
        ? 'Set a GitLab project in Settings to load its issues.'
        : 'Pick a project in Settings to load its bugs.';
    renderBugPicker(targetHint);
    updatePlan();

    if (el.startBtn.disabled) {
      setRunLocked(true);
    }
    return;
  }

  el.bugPicker.innerHTML = '';
  const loading = document.createElement('p');
  loading.className = 'bug-picker-empty';
  loading.textContent = 'Loading bugs…';
  el.bugPicker.append(loading);
  el.bugCount.textContent = 'loading…';
  el.toggleBugs.disabled = true;

  try {
    const endpoint = source === 'github' ? '/api/github/bugs' : source === 'gitlab' ? '/api/gitlab/bugs' : '/api/jira/bugs';
    const result = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify(source === 'jira'
        ? { ...trackerPayload(), project: target }
        : { ...trackerPayload(), ignoreLabels: true })
    });

    if (requestId !== state.bugRequestId) {
      return;
    }

    state.issueBugs = Array.isArray(result.bugs) ? result.bugs : [];
    state.issueKeys = state.issueBugs.map((bug) => bug.key);
    // The user asked for "all selected" to be the default on every load.
    state.selectedIssues = new Set(state.issueKeys);

    renderBugPicker(result.configured === false ? (result.error || 'Jira is not configured.') : (result.error || ''));
  } catch (error) {
    if (requestId === state.bugRequestId) {
      renderBugPicker(error.message);
    }
  }

  updatePlan();

  // An initial config load can race a resumed run. Re-apply the lock after
  // the picker has been rendered so fresh checkboxes are not interactive.
  if (el.startBtn.disabled) {
    setRunLocked(true);
  }
}

function scheduleBugLoad() {
  clearTimeout(state.bugLoadTimer);
  state.bugLoadTimer = setTimeout(() => {
    const target = currentTarget();

    const source = currentSource();
    const valid = source === 'github'
      ? /^[^/]+\/[^/]+$/.test(target)
      : source === 'gitlab'
        ? /^(https?:\/\/)?[^\s/]+(?:\/[^\s/]+){1,}$/.test(target)
        : /^[A-Za-z][A-Za-z0-9_]*$/.test(target);
    if (valid) {
      loadBugs();
    }
  }, 400);
}

function updateScope() {
  if (!el.scopeMeta) {
    return;
  }

  const source = currentSource();
  const project = currentTarget(source);
  const base = el.form.base.value.trim();
  const bits = [
    project ? `${source === 'github' ? 'repository' : 'project'} ${project}` : (source === 'github' ? 'no repository' : 'no project'),
    `base ${base || 'detected'}`,
    'isolated worktree'
  ];

  el.scopeMeta.textContent = bits.join('  ·  ');
}

function setPlan(rows) {
  if (!el.planSummary) {
    return;
  }

  const nodes = rows.map(([term, detail]) => {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');

    dt.textContent = term;
    dd.textContent = detail;
    row.append(dt, dd);
    return row;
  });

  el.planSummary.replaceChildren(...nodes);
}

function updatePlan() {
  const source = currentSource();
  const project = currentTarget();

  updateScope();

  if (!project) {
    const hint = source === 'github' ? 'Set a GitHub repository in Settings.' : source === 'gitlab' ? 'Set a GitLab project in Settings.' : 'Pick a Jira project in Settings.';
    setPlan([['scope', hint]]);
    return;
  }

  const defaults = state.config?.defaults ?? {};
  const branch = defaults.branch || 'bug-fix/<git-user>/sdd-studio';
  const tag = defaults.tag || '';
  const verify = defaults.verifyCommand || '';
  const loaded = state.loadedSource === source && state.loadedTarget === project;
  const total = loaded ? state.issueKeys.length : 0;
  const selected = loaded ? selectedIssueKeys().length : 0;
  let scope = source === 'jira' ? `all open ${project} bugs` : `all open ${project} issues`;

  if (total > 0) {
    scope = selected === total
      ? `all ${total} ${project} ${source === 'jira' ? 'bug' : 'issue'}${total === 1 ? '' : 's'}`
      : `${selected} of ${total} ${project} ${source === 'jira' ? 'bugs' : 'issues'}`;
  }

  const base = el.form.base.value.trim() || defaults.base || 'detected';
  const baseBits = [base, 'fetch first', 'isolated worktree'];
  const publish = el.form.publish?.value === 'push' ? 'push' : 'pr';
  const closeIssues = Boolean(el.form.closeIssues?.checked);
  let publishLabel = 'push branch only';

  if (publish === 'pr') {
    const prPreset = el.form.prPreset?.value || 'github';

    if (prPreset === 'gitlab-push') {
      publishLabel = 'push + merge request (git push options)';
    } else if (prPreset === 'custom') {
      publishLabel = 'push + merge request (custom command)';
    } else {
      const forge = prPresets().find((preset) => preset.id === prPreset);

      publishLabel = prPreset === 'github'
        ? 'push + pull request'
        : `push + merge request (${forge?.label || prPreset})`;
    }
  }

  if (closeIssues) {
    publishLabel = `${publishLabel}  ·  close source issue`;
  }

  setPlan([
    ['scope', scope],
    ['branch', tag ? `${branch}  ·  tag ${tag}` : `${branch}  ·  merge tag on merge`],
    ['base', baseBits.join('  ·  ')],
    ['verify', verify || 'not detected'],
    ['publish', publishLabel]
  ]);
}

async function loadProjects({ announce = false } = {}) {
  const request = formRequest();

  try {
    const { projects, error } = await api('/api/jira/projects', {
      method: 'POST',
      body: JSON.stringify(trackerPayload(request))
    });

    el.projectList.innerHTML = '';

    for (const project of projects) {
      const option = document.createElement('option');
      option.value = project.key;
      option.label = project.name;
      el.projectList.append(option);
    }

    if (error && announce) {
      el.formError.textContent = error;
      el.formError.classList.remove('hidden');
    }
  } catch (error) {
    if (announce) {
      el.formError.textContent = error.message;
      el.formError.classList.remove('hidden');
    }
  }
}

function updateJiraTypeSettings() {
  const isCloud = (el.form.jiraType?.value ?? 'cloud') !== 'datacenter';

  if (el.jiraEmailField) el.jiraEmailField.classList.toggle('hidden', !isCloud);
  if (el.jiraDatacenterTls) el.jiraDatacenterTls.classList.toggle('hidden', isCloud);
  if (el.jiraCloudHint) el.jiraCloudHint.classList.toggle('hidden', !isCloud);
  if (el.jiraDatacenterHint) el.jiraDatacenterHint.classList.toggle('hidden', isCloud);

  if (el.jiraUrlLabel) {
    el.jiraUrlLabel.textContent = isCloud ? 'Cloud URL' : 'Data Center URL';
  }
  if (el.form.jiraUrl) {
    el.form.jiraUrl.placeholder = isCloud ? 'https://your-domain.atlassian.net' : 'https://jira.yourcompany.com';
  }
  if (el.jiraTokenLabel) {
    el.jiraTokenLabel.textContent = isCloud ? 'API token' : 'Personal access token (PAT)';
  }

  if (el.form.jiraAuth) {
    el.form.jiraAuth.value = isCloud ? 'basic' : 'bearer';
  }
  if (el.form.jiraApiVersion) {
    el.form.jiraApiVersion.value = isCloud ? '3' : '2';
  }
}

function toggleJiraEmail() {
  updateJiraTypeSettings();
}

async function checkJira() {
  el.jiraCheckResult.textContent = 'checking…';

  try {
    const result = await api('/api/jira/health', {
      method: 'POST',
      body: JSON.stringify(trackerPayload())
    });

    if (!result.configured) {
      el.jiraCheckResult.textContent = 'Jira credentials are not configured.';
      return;
    }

    if (result.ok) {
      const who = result.user?.displayName || result.user?.name || 'authenticated';
      el.jiraCheckResult.textContent = `OK · ${who} · REST v${result.apiVersion}`;
      // The connection may have just been entered; make the bug list usable.
      loadBugs({ force: true });
      loadProjects();
    } else {
      el.jiraCheckResult.textContent = result.error?.hint || result.error?.message || `Jira check failed (${result.error?.code ?? 'unknown'}).`;
    }
  } catch (error) {
    el.jiraCheckResult.textContent = error.message;
  }
}

async function checkGitHub() {
  el.githubCheckResult.textContent = 'checking…';
  try {
    const result = await api('/api/github/health', { method: 'POST', body: JSON.stringify(trackerPayload()) });
    el.githubCheckResult.textContent = result.ok ? `OK · ${result.repo}` : (result.error || 'GitHub check failed.');
    if (result.ok) loadBugs({ force: true });
  } catch (error) {
    el.githubCheckResult.textContent = error.message;
  }
}

async function checkGitLab() {
  el.gitlabCheckResult.textContent = 'checking…';
  try {
    const result = await api('/api/gitlab/health', { method: 'POST', body: JSON.stringify({}) });
    el.gitlabCheckResult.textContent = result.ok
      ? `OK${result.detail ? ` · ${result.detail}` : ''}`
      : (result.error || 'GitLab check failed.');
  } catch (error) {
    el.gitlabCheckResult.textContent = error.message;
  }
}

async function forgetGitHub() {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ githubRepo: '', githubLabel: '' }) });
    for (const name of ['githubRepo', 'githubLabel']) el.form[name].value = '';
    state.loadedSource = '';
    el.githubInfo.textContent = 'GitHub CLI: not configured';
    el.githubCheckResult.textContent = 'Repository setting cleared.';
    updateTrackerStatus();
    loadBugs({ force: true });
  } catch (error) {
    el.githubCheckResult.textContent = error.message;
  }
}

async function forgetJira() {
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        jiraType: 'cloud',
        jiraUrl: '',
        jiraEmail: '',
        jiraToken: '',
        jiraCa: '',
        jiraAuth: 'basic',
        jiraApiVersion: '3',
        jiraInsecure: false
      })
    });

    if (el.form.jiraType) el.form.jiraType.value = 'cloud';
    for (const name of ['jiraUrl', 'jiraEmail', 'jiraToken', 'jiraCa']) {
      el.form[name].value = '';
    }
    el.form.jiraAuth.value = 'basic';
    el.form.jiraApiVersion.value = '3';
    el.form.jiraInsecure.checked = false;
    el.form.jiraToken.placeholder = '••••••••';
    updateJiraTypeSettings();
    state.loadedSource = '';
    state.issueBugs = [];
    state.issueKeys = [];
    state.selectedIssues.clear();
    renderBugPicker('Pick a project in Settings to load its bugs.');
    updatePlan();
    updateTrackerStatus();
    el.jiraCheckResult.textContent = 'Saved Jira settings cleared.';
  } catch (error) {
    el.jiraCheckResult.textContent = error.message;
  }
}

let settingsSaveTimer = null;

function settingsPayload() {
  const request = formRequest({ dryRun: true });
  const payload = {
    source: request.source,
    githubRepo: request.githubRepo,
    gitlabProject: request.gitlabProject,
    project: request.project,
    base: request.base,
    publish: request.publish,
    closeIssues: request.closeIssues,
    jiraType: request.jiraType,
    jiraUrl: request.jiraUrl,
    jiraEmail: request.jiraEmail,
    jiraAuth: request.jiraAuth,
    jiraApiVersion: request.jiraApiVersion,
    jiraCa: request.jiraCa,
    jiraInsecure: request.jiraInsecure,
    prPreset: request.prPreset,
    prCommand: request.prCommand,
    settingsSeen: true
  };
  const token = el.form.jiraToken.value.trim();

  // A blank token means "keep using the saved one"; never send the empty
  // string, because the settings endpoint treats it as a request to clear.
  if (token) {
    payload.jiraToken = token;
  }
  return payload;
}

function updateTrackerStatus() {
  const names = [];

  if (el.form.jiraUrl.value.trim()) names.push('Jira');
  if (el.form.githubRepo.value.trim()) names.push('GitHub');
  if (el.form.gitlabProject.value.trim()) names.push('GitLab');

  el.trackerInfo.textContent = names.length
    ? `Trackers: ${names.join(' · ')}`
    : 'Trackers: not configured';
  el.trackerInfo.title = names.length
    ? `Configured targets: ${names.join(', ')}`
    : 'No tracker target is configured yet.';
}

function queueSettingsSave() {
  // Before the config has loaded, the form still holds placeholders, not choices.
  if (!state.config) {
    return;
  }

  window.clearTimeout(settingsSaveTimer);
  el.settingsStatus.textContent = 'Saving…';
  settingsSaveTimer = window.setTimeout(saveSettings, 300);
}

async function saveSettings() {
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify(settingsPayload())
    });

    el.settingsStatus.textContent = 'Saved';
    window.setTimeout(() => {
      if (el.settingsStatus.textContent === 'Saved') {
        el.settingsStatus.textContent = '';
      }
    }, 1600);

    updateTrackerStatus();
  } catch {
    el.settingsStatus.textContent = 'Not saved';
  }
}

async function startSweep({ dryRun = false } = {}) {
  el.formError.classList.add('hidden');

  const request = formRequest({ dryRun });

  if (!currentTarget(request.source)) {
    el.formError.textContent = request.source === 'github'
      ? 'Set a GitHub repository in Settings first.'
      : request.source === 'gitlab'
        ? 'Set a GitLab project in Settings first.'
        : 'Pick a Jira project in Settings first.';
    el.formError.classList.remove('hidden');
    return;
  }

  if (state.loadedSource === request.source && state.loadedTarget === currentTarget(request.source) && state.issueKeys.length > 0 && state.selectedIssues.size === 0) {
    el.formError.textContent = 'Select at least one bug to fix.';
    el.formError.classList.remove('hidden');
    return;
  }

  resetRun();
  setBadge('running', dryRun ? 'previewing' : 'starting');
  setConnection('live', 'running');
  announceStatus(dryRun ? 'Previewing the plan.' : 'Run started.');

  try {
    const { job } = await api('/api/sweeps', { method: 'POST', body: JSON.stringify(request) });
    attach(job.id);
  } catch (error) {
    el.formError.textContent = error.message;
    el.formError.classList.remove('hidden');
    setBadge('failed', 'failed');
    setConnection('live', 'connected');
    setRunLocked(false);
  }
}

async function cancelSweep() {
  if (!state.jobId) {
    return;
  }

  el.cancelBtn.disabled = true;

  try {
    await api(`/api/sweeps/${state.jobId}/cancel`, { method: 'POST' });
  } catch (error) {
    appendLog(`Cancel failed: ${error.message}`);
  }
}

function showQuestion(question) {
  state.currentQuestion = question;
  el.interview.classList.remove('hidden');
  el.interviewTitle.textContent = question.title || 'A run needs your input';
  el.interviewPrompt.textContent = question.prompt || '';
  el.interviewBody.innerHTML = '';

  if (Array.isArray(question.options) && question.options.length > 0) {
    const wrap = document.createElement('div');
    wrap.className = 'choice';

    for (const option of question.options) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'choice';
      input.value = typeof option === 'string' ? option : option.value;
      const span = document.createElement('span');
      span.textContent = typeof option === 'string' ? option : option.label;
      label.append(input, span);
      wrap.append(label);
    }

    el.interviewBody.append(wrap);
  } else {
    const input = document.createElement('input');
    input.id = 'interview-answer';
    input.placeholder = question.placeholder || 'Type your answer';
    el.interviewBody.append(input);
  }
}

async function submitAnswer() {
  if (!state.currentQuestion || !state.jobId) {
    return;
  }

  const question = state.currentQuestion;
  const selected = el.interviewBody.querySelector('input[name="choice"]:checked');
  const answer = selected ? selected.value : $('#interview-answer')?.value ?? '';

  el.interviewSubmit.disabled = true;

  try {
    await api(`/api/jobs/${state.jobId}/input`, {
      method: 'POST',
      body: JSON.stringify({ questionId: question.id, answer })
    });
    el.interview.classList.add('hidden');
    state.currentQuestion = null;
  } catch (error) {
    appendLog(`Could not send the answer: ${error.message}`);
  } finally {
    el.interviewSubmit.disabled = false;
  }
}

// ---------------------------------------------------------------
// Interview sessions: Enhancement and Feature share one terminal.
// ---------------------------------------------------------------

const SESSION_COPY = {
  enhancement: {
    endpoint: '/api/enhancements',
    title: 'Enhancement sessions',
    finalLabel: 'report',
    placeholder: 'Describe the enhancement…',
    restartPlaceholder: 'Start another enhancement…',
    answerPlaceholder: 'Type your answer, or approve the plan…',
    emptyTitle: 'Interview the agent.',
    emptyBody: 'One live Claude process runs the interview in its own worktree. When the report is ready, the studio commits and pushes the session branch; the merge request is optional.'
  },
  feature: {
    endpoint: '/api/features',
    title: 'Feature sessions',
    finalLabel: 'spec',
    placeholder: 'Describe the feature…',
    restartPlaceholder: 'Start another feature…',
    answerPlaceholder: 'Type your answer…',
    emptyTitle: 'Interview the agent.',
    emptyBody: 'One live Claude process runs the design interview and writes the spec. You choose the build path next; the build stays in this session.'
  },
  specIssue: {
    endpoint: '/api/spec-issues',
    title: 'Spec issue sessions',
    finalLabel: 'spec',
    placeholder: 'Describe the feature to spec…',
    restartPlaceholder: 'Start another spec…',
    answerPlaceholder: 'Type your answer…',
    emptyTitle: 'Interview the agent.',
    emptyBody: 'One live Claude process runs the design interview in a worktree and writes the spec. The studio copies it into the main checkout and files one tracker issue; nothing is committed or pushed.'
  },
  merge: {
    endpoint: '/api/merges',
    title: 'Merge sessions',
    finalLabel: 'merge report',
    placeholder: 'Pick a source and target above…',
    restartPlaceholder: 'Start another merge…',
    answerPlaceholder: 'Type your answer, or approve the resolution table…',
    emptyTitle: 'Merge two branches.',
    emptyBody: 'The live Claude process dry-runs the merge in a worktree opened from the target, then builds an integration branch. The target is untouched until you land it.'
  }
};

function createSession(flow) {
  const root = document.querySelector(`[data-session-flow="${flow}"]`);

  if (!root) {
    return null;
  }

  const copy = SESSION_COPY[flow];
  const isMerge = flow === 'merge';
  const canFinish = flow === 'enhancement';
  const ALIVE = new Set(['starting', 'queued', 'running', 'waiting', 'stopping', 'cancelling']);
  let listExpanded = false;

  root.innerHTML = `
    <section class="session-home hidden" data-role="home" aria-label="${copy.title}">
      <header class="session-list-head">
        <button type="button" class="session-list-toggle" data-role="list-toggle" aria-expanded="false" aria-controls="session-list-${flow}">
          <span class="session-list-title">Sessions</span>
          <span class="session-list-count" data-role="list-count">0</span>
          <svg class="session-list-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <button type="button" class="btn sm hidden" data-role="new">New session</button>
      </header>
      <div class="session-list-body" data-role="list-body" id="session-list-${flow}" hidden>
        <p class="session-list-note">Read-only history of the last 20 sessions.</p>
        <ul class="session-list" data-role="session-list"></ul>
        <p class="session-list-empty" data-role="session-list-empty">No earlier sessions.</p>
      </div>
    </section>

    <section class="session" aria-label="${copy.finalLabel} session">
      <header class="session-bar hidden" data-role="bar">
        <div class="session-id">
          <span class="badge" data-role="badge">ready</span>
          <span class="session-lock" data-role="lock" title="Model and effort are locked for this session"></span>
        </div>
        <div class="session-tools">
          <div class="segmented" role="group" aria-label="Conversation view">
            <button type="button" class="seg-btn" data-role="rich" aria-pressed="true">Rich</button>
            <button type="button" class="seg-btn" data-role="raw" aria-pressed="false">Raw</button>
          </div>
          <button type="button" class="btn quiet sm" data-role="copy">Copy</button>
          ${canFinish ? `<button type="button" class="btn quiet sm" data-role="finish" title="End the session when the reply is the final ${copy.finalLabel}" disabled>Finish</button>` : ''}
          <button type="button" class="btn quiet-danger sm" data-role="stop" disabled title="Stop the process and delete the worktree">Stop</button>
        </div>
      </header>

      <div class="session-setup" data-role="setup"></div>

      <div class="session-stage hidden" data-role="stage" role="log" aria-live="off" aria-label="Conversation" tabindex="0">
        <div class="session-empty" data-role="empty">
          <p class="session-empty-title">${copy.emptyTitle}</p>
          <p>${copy.emptyBody}</p>
        </div>
        <article class="session-rich hidden" data-role="rich-view"></article>
        <pre class="session-raw hidden" data-role="raw-view" aria-label="Raw stream"></pre>
      </div>

      <div class="handoff hidden" data-role="handoff"></div>

      <form class="session-input hidden" data-role="input-form">
        <textarea data-role="input" rows="1" spellcheck="false" aria-label="Your answer" placeholder="${copy.placeholder}"></textarea>
        <button type="submit" class="session-send" data-role="send" aria-label="Send">
          <span class="session-send-label" data-role="send-label" aria-hidden="true"></span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7"/></svg>
        </button>
      </form>
    </section>
  `;

  const q = (role) => root.querySelector(`[data-role="${role}"]`);
  const dom = {
    home: q('home'),
    listToggle: q('list-toggle'),
    listCount: q('list-count'),
    listBody: q('list-body'),
    bar: q('bar'),
    newBtn: q('new'),
    list: q('session-list'),
    listEmpty: q('session-list-empty'),
    badge: q('badge'),
    lock: q('lock'),
    richBtn: q('rich'),
    rawBtn: q('raw'),
    copy: q('copy'),
    finish: q('finish'),
    stop: q('stop'),
    setup: q('setup'),
    stage: q('stage'),
    empty: q('empty'),
    richView: q('rich-view'),
    rawView: q('raw-view'),
    handoff: q('handoff'),
    inputForm: q('input-form'),
    input: q('input'),
    send: q('send'),
    sendLabel: q('send-label')
  };
  const view = {
    jobId: null,
    sessionId: null,
    source: null,
    entries: [],
    raw: [],
    active: null,
    awaiting: false,
    running: false,
    finished: false,
    readOnly: false,
    setup: false,
    sessionOpen: false,
    setupError: '',
    seq: 0,
    mode: 'rich',
    renderTimer: null,
    statusTimer: null,
    turnStartedAt: 0,
    turnLabel: 'writing',
    working: [],
    build: null,
    jobs: [],
    mergeMeta: null,
    setupChoice: null,
    sourceIssue: null,
    specIssue: null,
    branch: ''
  };
  let issueChoices = [];
  let stopArmed = false;
  let stopTimer = null;

  function setStatus(text, live) {
    dom.badge.textContent = text;
    dom.badge.classList.toggle('running', Boolean(live));
  }

  function setBarVisible(visible) {
    dom.bar.classList.toggle('hidden', !visible);
  }

  function setListExpanded(expanded) {
    listExpanded = expanded;
    dom.listToggle.setAttribute('aria-expanded', String(expanded));
    dom.listBody.hidden = !expanded;
  }

  function syncSessionHome() {
    const count = view.jobs.length;

    dom.home.classList.toggle('hidden', count === 0);
    dom.listCount.textContent = String(count);
    dom.listToggle.setAttribute('aria-label', `${copy.title}, ${count} saved ${count === 1 ? 'session' : 'sessions'}`);
    dom.newBtn.classList.toggle('hidden', !view.sessionOpen);
  }


  function setInputEnabled(enabled, placeholder) {
    dom.input.disabled = !enabled;
    dom.send.disabled = !enabled;
    dom.input.placeholder = placeholder ?? (view.jobId ? 'Waiting for the agent…' : copy.placeholder);

    if (enabled) {
      dom.input.focus();
    }
  }

  function setComposerVisible(visible) {
    dom.inputForm.classList.toggle('hidden', !visible);
  }

  function setComposerAction(action) {
    const starting = action === 'start';

    dom.inputForm.classList.toggle('is-start', starting);
    dom.send.setAttribute('aria-label', starting ? 'Start session' : 'Send');
    dom.sendLabel.textContent = starting ? 'Start' : '';
  }

  function setSetupVisible(visible) {
    dom.setup.classList.toggle('hidden', !visible);
    dom.stage.classList.toggle('hidden', visible);
  }

  function paintLock(values = {}) {
    const model = values.model ? modelLabel(values.model) : 'Default model';
    const effort = values.effort ? `${values.effort} effort` : 'Default effort';

    dom.lock.textContent = `${model} · ${effort}`;
  }

  function trackerLabel(source) {
    return { jira: 'Jira', github: 'GitHub', gitlab: 'GitLab' }[source] ?? 'the tracker';
  }

  function issueBrief(issue) {
    return [
      `${issue.key}: ${issue.summary}`.trim(),
      issue.description?.trim() ?? '',
      issue.url ?? ''
    ].filter(Boolean).join('\n\n');
  }

  // ---------------------------------------------------------------
  // Session setup: model/effort, MR, and an optional issue
  // ---------------------------------------------------------------

  function selectionMarkup() {
    const selection = workflowSettings(flow);
    // Only enhancement and feature publish a branch with an optional merge
    // request. Spec issue files an issue; merge lands an integration branch.
    const showMr = !isMerge && flow !== 'specIssue';

    return `
      <div class="selection-row${showMr ? '' : ' selection-row-compact'}">
        <label class="field"><span>Model</span>
          <span class="model-picker" data-model-picker>
            <select data-role="model-select" aria-label="Model"></select>
            <input data-role="model" class="model-custom hidden" placeholder="Model id" autocomplete="off" aria-label="Custom model id">
          </span>
        </label>
        <label class="field"><span>Effort</span><select data-role="effort" aria-label="Effort"></select></label>
        ${showMr ? `<label class="toggle selection-mr">
          <input type="checkbox" data-role="mr"${selection.mr !== false ? ' checked' : ''}>
          <span>Open a merge request</span>
        </label>` : ''}
      </div>
      <p class="hint">The selection is remembered for ${copy.title.toLowerCase()} and locked once the session starts. Choose Default to use the Claude environment.</p>
    `;
  }

  function selectedFromSetup() {
    return selectionFrom({
      modelPicker: dom.setup.querySelector('[data-model-picker]'),
      effort: dom.setup.querySelector('[data-role="effort"]'),
      mr: dom.setup.querySelector('[data-role="mr"]')
    });
  }

  function wireSelection() {
    const modelPicker = dom.setup.querySelector('[data-model-picker]');
    const effortSelect = dom.setup.querySelector('[data-role="effort"]');
    const mrBox = dom.setup.querySelector('[data-role="mr"]');

    if (!modelPicker || !effortSelect) {
      return;
    }

    const saved = workflowSettings(flow);

    fillModelPicker(modelPicker, saved.model);
    fillEffortSelect(effortSelect, saved.effort);

    if (mrBox) {
      mrBox.checked = saved.mr !== false;
    }

    const remember = () => rememberWorkflow(flow, selectedFromSetup());

    wireModelPicker(modelPicker, remember);
    effortSelect.addEventListener('change', remember);
    mrBox?.addEventListener('change', remember);
  }

  function issueImportMarkup() {
    if (isMerge) {
      return '';
    }

    const sourceOptions = `
      <option value="jira">Jira</option>
      <option value="github">GitHub</option>
      <option value="gitlab">GitLab</option>
    `;

    if (flow === 'specIssue') {
      return `
        <div class="session-import">
          <div class="session-import-row">
            <label class="session-import-label" for="source-${flow}">File in</label>
            <select id="source-${flow}" data-role="issue-source" aria-label="Issue tracker">${sourceOptions}</select>
          </div>
          <p class="session-import-status" data-role="issue-status" role="status"></p>
        </div>
      `;
    }

    return `
      <div class="session-import">
        <div class="session-import-row">
          <label class="session-import-label" for="source-${flow}">Start from</label>
          <select id="source-${flow}" data-role="issue-source" aria-label="Issue source">${sourceOptions}</select>
          <select id="issue-${flow}" data-role="issue-select" disabled>
            <option value="">Load open issues…</option>
          </select>
          <button type="button" class="btn quiet sm" data-role="issue-load">Load issues</button>
        </div>
        <p class="session-import-status" data-role="issue-status" role="status"></p>
      </div>
    `;
  }

  function syncIssueSource() {
    const source = dom.setup.querySelector('[data-role="issue-source"]');

    if (!source) {
      return;
    }

    const saved = state.config?.settings?.[`${flow}Source`] ?? 'jira';

    source.value = ['jira', 'github', 'gitlab'].includes(saved) ? saved : 'jira';
  }

  async function saveIssueSource() {
    const source = dom.setup.querySelector('[data-role="issue-source"]');

    if (!source) {
      return;
    }

    try {
      await api('/api/settings', { method: 'POST', body: JSON.stringify({ [`${flow}Source`]: source.value }) });

      if (state.config?.settings) {
        state.config.settings[`${flow}Source`] = source.value;
      }
    } catch (error) {
      const status = dom.setup.querySelector('[data-role="issue-status"]');

      if (status) {
        status.textContent = `Could not save source: ${error.message}`;
      }
    }
  }

  async function loadExternalIssues() {
    const sourceSelect = dom.setup.querySelector('[data-role="issue-source"]');
    const issueSelect = dom.setup.querySelector('[data-role="issue-select"]');
    const loadButton = dom.setup.querySelector('[data-role="issue-load"]');
    const status = dom.setup.querySelector('[data-role="issue-status"]');

    if (!sourceSelect || !issueSelect || !status) {
      return;
    }

    const source = sourceSelect.value;
    const settings = state.config?.settings ?? {};
    const request = source === 'github'
      ? { githubRepo: settings.githubRepo, ignoreLabels: true, limit: 100 }
      : source === 'gitlab'
        ? { gitlabProject: settings.gitlabProject, limit: 100 }
        : { project: settings.project };
    const target = source === 'github' ? request.githubRepo : source === 'gitlab' ? request.gitlabProject : request.project;
    const endpoint = source === 'github' ? '/api/github/bugs' : source === 'gitlab' ? '/api/gitlab/issues' : '/api/jira/issues';

    if (loadButton) {
      loadButton.disabled = true;
    }
    issueSelect.disabled = true;
    status.textContent = 'Loading open issues…';

    try {
      if (!target) {
        const label = source === 'github' ? 'GitHub repository' : source === 'gitlab' ? 'GitLab project' : 'Jira project';
        status.textContent = `Set a ${label} in Settings first.`;
        return;
      }

      const result = await api(endpoint, { method: 'POST', body: JSON.stringify(request) });

      if (!result.configured) {
        status.textContent = result.error || `${source} is not configured. Check Settings.`;
        return;
      }

      if (result.error) {
        status.textContent = result.error;
        return;
      }

      const issues = source === 'github' ? (result.bugs ?? []) : (result.issues ?? []);

      issueChoices = issues;
      issueSelect.replaceChildren(new Option('Choose an issue…', ''));

      for (const issue of issues) {
        issueSelect.append(new Option(`${issue.key} — ${issue.summary}`, issue.key));
      }

      issueSelect.disabled = issues.length === 0;
      status.textContent = issues.length === 0
        ? 'No open issues in the project.'
        : `${issues.length} open issue${issues.length === 1 ? '' : 's'}. Pick one to import.`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      if (loadButton) {
        loadButton.disabled = false;
      }
    }
  }

  async function importSelectedIssue() {
    const sourceSelect = dom.setup.querySelector('[data-role="issue-source"]');
    const issueSelect = dom.setup.querySelector('[data-role="issue-select"]');
    const loadButton = dom.setup.querySelector('[data-role="issue-load"]');
    const status = dom.setup.querySelector('[data-role="issue-status"]');

    if (!sourceSelect || !issueSelect || !status) {
      return;
    }

    const key = issueSelect.value;

    if (!key) {
      return;
    }

    const source = sourceSelect.value;
    const settings = state.config?.settings ?? {};
    issueSelect.disabled = true;

    if (loadButton) {
      loadButton.disabled = true;
    }
    status.textContent = `Loading ${key}…`;

    try {
      let issue = issueChoices.find((candidate) => candidate.key === key);

      if (source === 'jira') {
        const result = await api('/api/jira/issue', { method: 'POST', body: JSON.stringify({ key }) });

        if (!result.configured) {
          status.textContent = 'Jira is not configured. Add the URL and token in Settings.';
          return;
        }

        if (result.error || !result.issue) {
          status.textContent = result.error || `Jira issue ${key} was not found.`;
          return;
        }
        issue = result.issue;
      }

      if (!issue) {
        status.textContent = `Issue ${key} is no longer in the loaded list. Reload issues.`;
        return;
      }

      const target = source === 'github'
        ? settings.githubRepo
        : source === 'gitlab'
          ? settings.gitlabProject
          : settings.project;

      view.sourceIssue = { source, key: issue.key, url: issue.url ?? '', target: target ?? '' };
      dom.input.value = issueBrief(issue);
      autoGrow();
      dom.input.focus();
      status.textContent = `Imported ${issue.key}. Edit it below and press Send.`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      issueSelect.disabled = false;

      if (loadButton) {
        loadButton.disabled = false;
      }
    }
  }

  function wireIssueImport() {
    const source = dom.setup.querySelector('[data-role="issue-source"]');
    const load = dom.setup.querySelector('[data-role="issue-load"]');
    const select = dom.setup.querySelector('[data-role="issue-select"]');

    syncIssueSource();

    source?.addEventListener('change', () => {
      issueChoices = [];
      view.sourceIssue = null;
      if (select) {
        select.replaceChildren(new Option('Load open issues…', ''));
        select.disabled = true;
      }
      const status = dom.setup.querySelector('[data-role="issue-status"]');
      if (status) status.textContent = '';
      saveIssueSource();
    });
    load?.addEventListener('click', loadExternalIssues);
    select?.addEventListener('change', importSelectedIssue);
  }

  function renderSetup(error = '') {
    if (view.running) {
      return;
    }

    view.setup = true;
    view.sessionOpen = false;
    view.readOnly = false;
    view.finished = false;
    view.setupError = error;
    view.branch = '';
    paintLock({});
    hideHandoff();
    dom.empty.classList.add('hidden');
    dom.richView.innerHTML = '';
    dom.rawView.textContent = '';
    dom.richView.classList.add('hidden');
    dom.rawView.classList.add('hidden');
    setStatus('ready', false);
    setBarVisible(false);
    dom.stop.disabled = true;

    if (dom.finish) {
      dom.finish.disabled = true;
    }

    if (!state.config) {
      setSetupVisible(true);
      dom.setup.innerHTML = '<p class="hint">Loading workspace…</p>';
      setComposerVisible(false);
      return;
    }

    if (isMerge) {
      renderMergeSetup(error);
      return;
    }

    setSetupVisible(true);
    dom.setup.innerHTML = `
      <div class="session-start">
        <p class="session-start-lede">${copy.emptyBody}</p>
        ${selectionMarkup()}
        ${issueImportMarkup()}
        ${error ? `<p class="handoff-error" role="alert">${escapeText(error)}</p>` : ''}
      </div>
    `;
    wireSelection();
    wireIssueImport();
    setComposerVisible(true);
    setComposerAction('start');
    setInputEnabled(true, copy.placeholder);
    autoGrow();
  }

  // ---------------------------------------------------------------
  // Session list
  // ---------------------------------------------------------------

  function isAlive(job) {
    return ALIVE.has(job?.status);
  }

  function jobBrief(job) {
    return String(job?.request?.brief ?? job?.brief ?? '').split(/\r?\n/).find(Boolean) ?? 'Untitled session';
  }

  function jobSelectionText(job) {
    const selection = job?.selection ?? {};
    const model = selection.model ? modelLabel(selection.model) : 'Default';
    const effort = selection.effort || 'Default';

    return `${model}/${effort}`;
  }

  function statusKind(status) {
    if (status === 'done') return 'done';
    if (status === 'failed') return 'failed';
    if (status === 'stopped' || status === 'cancelled') return 'cancelled';
    if (status === 'waiting') return 'waiting';
    return 'running';
  }

  function renderSessionList() {
    if (!dom.list) {
      return;
    }

    dom.list.replaceChildren();
    dom.listEmpty.classList.toggle('hidden', view.jobs.length > 0);

    for (const job of view.jobs) {
      const item = document.createElement('li');
      const alive = isAlive(job);
      const active = job.id === view.sessionId;
      const brief = escapeText(jobBrief(job));

      item.className = `session-row${active ? ' current' : ''}`;
      item.dataset.id = job.id;
      item.innerHTML = `
        <button type="button" class="session-row-main" data-action="open" aria-label="Open session: ${brief}">
          <span class="badge ${statusKind(job.status)}">${escapeText(job.status ?? '')}</span>
          <span class="session-row-copy">
            <span class="session-row-brief">${brief}</span>
            <span class="session-row-meta">${escapeText(jobSelectionText(job))} · ${escapeText(job.branch || job.publish?.branch || '—')}</span>
          </span>
        </button>
        <span class="session-row-actions">
          ${alive ? '<button type="button" class="btn quiet-danger sm" data-action="stop">Stop</button>' : ''}
          ${alive ? '' : '<button type="button" class="btn quiet sm" data-action="remove">Remove</button>'}
        </span>
      `;
      dom.list.append(item);
    }

    syncSessionHome();
  }

  async function loadSessionList() {
    try {
      const { jobs } = await api(copy.endpoint);

      view.jobs = Array.isArray(jobs) ? jobs : [];
      renderSessionList();
    } catch {
      view.jobs = [];
      renderSessionList();
    }
  }

  async function openSession(job) {
    if (!job) {
      return;
    }

    resetSession({ setup: false });
    view.sessionId = job.id;
    view.readOnly = job.readOnly === true || job.historical === true || !isAlive(job);
    view.mergeMeta = job.request?.merge ?? null;
    view.branch = job.branch || job.publish?.branch || '';

    if (job.result?.ref) {
      view.mergeMeta = { ...(view.mergeMeta ?? {}), ref: job.result.ref };
    }

    paintLock(job.selection ?? {
      model: job.model,
      effort: job.effort
    });

    if (isAlive(job) && !view.readOnly) {
      setSetupVisible(false);
      dom.stage.classList.remove('hidden');
      attach(job.id);
      return;
    }

    view.seq = 0;

    for (const event of job.events ?? []) {
      onEvent(event);
    }

    view.running = false;
    view.awaiting = false;
    setSetupVisible(false);
    dom.stage.classList.remove('hidden');
    setComposerVisible(false);
    setInputEnabled(false);
    dom.stop.disabled = true;
    if (dom.finish) dom.finish.disabled = true;

    if (view.entries.length === 0) {
      try {
        const detail = await api(`${copy.endpoint}/${job.id}`);

        if (detail?.markdown) {
          addEntry('markdown', detail.markdown);
        }
      } catch {
        // History may be unreadable; the list row still tells the story.
      }
    }

    setStatus(job.status ?? 'done', false);
    render();

    if (isMerge && job.status === 'done' && view.mergeMeta?.ref) {
      showMergeLanding();
    }

    renderSessionList();
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  function rawText() {
    return view.raw.length > 0
      ? view.raw.join('\n')
      : view.entries.filter((entry) => entry.role === 'agent').map((entry) => renderTerminalText(entry.text)).join('');
  }

  function renderTerminalText(value) {
    return String(value ?? '')
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '');
  }

  function renderWorking() {
    if (!view.running || view.awaiting || view.working.length === 0) {
      return '';
    }

    const latest = view.working[view.working.length - 1];

    return `<details class="session-working">
      <summary><span class="session-working-dots" aria-hidden="true"><i></i><i></i><i></i></span> working — ${escapeText(latest)}</summary>
      <ul>${view.working.map((item) => `<li>${escapeText(item)}</li>`).join('')}</ul>
    </details>`;
  }

  function renderEntry(entry, index) {
    if (entry.role === 'agent') {
      if (!entry.text.trim() && index < view.entries.length - 1) {
        return '';
      }

      const text = renderTerminalText(entry.text);
      const body = window.SDDMarkdown ? window.SDDMarkdown.render(text) : `<p>${escapeText(text)}</p>`;

      return '<article class="turn turn-agent" role="group" aria-label="Assistant"><p class="turn-who">Assistant</p><div class="turn-body">' + body + '</div></article>';
    }

    if (entry.role === 'you') {
      return `<article class="turn turn-you" role="group" aria-label="You"><p class="turn-who">You</p><div class="turn-body"><p>${escapeText(entry.text)}</p></div></article>`;
    }

    if (entry.role === 'permission') {
      const decided = Boolean(entry.state) && entry.state !== 'pending';
      const disabled = entry.busy || view.readOnly ? ' disabled' : '';
      const actions = decided
        ? `<p class="permission-state">${escapeText(entry.state)}</p>`
        : `<div class="permission-actions">
             <button type="button" class="btn sm" data-permission="allow" data-id="${escapeText(entry.id)}"${disabled}>Allow once</button>
             <button type="button" class="btn quiet sm" data-permission="deny" data-id="${escapeText(entry.id)}"${disabled}>Deny</button>
           </div>`;

      return `<article class="turn turn-permission" role="group" aria-label="Permission request">
        <p class="turn-who">Approval</p>
        <div class="turn-body">
          <p>The agent wants to use <code>${escapeText(entry.tool)}</code>${entry.detail ? `: <code>${escapeText(entry.detail)}</code>` : ''}</p>
          <p class="permission-note">${escapeText(entry.description || 'Reads are pre-approved. Everything else waits for you.')}</p>
          ${actions}
        </div>
      </article>`;
    }

    if (entry.role === 'publish') {
      const link = entry.url
        ? ` <a href="${escapeText(entry.url)}" target="_blank" rel="noreferrer">Open merge request</a>`
        : '';

      return `<article class="turn turn-publish" role="status">
        <p class="turn-who">Git</p>
        <div class="turn-body"><p>${escapeText(entry.text)}${link}</p></div>
      </article>`;
    }

    if (entry.role === 'issue') {
      const link = entry.url
        ? ` <a href="${escapeText(entry.url)}" target="_blank" rel="noreferrer">Open issue</a>`
        : '';

      return `<article class="turn turn-publish" role="status">
        <p class="turn-who">Tracker</p>
        <div class="turn-body"><p>${escapeText(entry.text)}${link}</p></div>
      </article>`;
    }

    if (entry.role === 'guard') {
      const detail = entry.detail ? `: <code>${escapeText(entry.detail)}</code>` : '';

      return `<article class="turn turn-guard" role="status">
        <p class="turn-who">Merge guard</p>
        <div class="turn-body"><p>Denied <code>${escapeText(entry.tool || 'tool')}</code>${detail}.
          The agent must take a different path.</p></div>
      </article>`;
    }

    if (entry.role === 'marker') {
      return `<p class="session-marker" role="status"><span>${escapeText(entry.text)}</span></p>`;
    }

    if (entry.role === 'step') {
      return `<p class="session-step" data-status="${escapeText(entry.status ?? 'waiting')}" role="status">
        <span class="session-step-index">${escapeText(entry.index)}</span>
        <span>${escapeText(entry.text)}</span>
        <span class="session-step-state">${escapeText(entry.status ?? 'waiting')}${entry.error ? ` · ${escapeText(entry.error)}` : ''}</span>
      </p>`;
    }

    if (entry.role === 'markdown') {
      return `<article class="turn turn-markdown"><div class="turn-body">${window.SDDMarkdown ? window.SDDMarkdown.render(entry.text) : `<pre>${escapeText(entry.text)}</pre>`}</div></article>`;
    }

    return `<article class="turn turn-session" role="status"><p>${escapeText(entry.text)}</p></article>`;
  }

  function decorate() {
    const agentTurns = dom.richView.querySelectorAll('.turn-agent');
    const lastAgent = agentTurns[agentTurns.length - 1];

    if (lastAgent && view.finished) {
      lastAgent.dataset.stamp = copy.finalLabel;
    }
  }

  function render() {
    const stage = dom.stage;
    const nearBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight < 90;

    if (view.entries.length === 0) {
      dom.empty.classList.remove('hidden');
      dom.richView.classList.add('hidden');
      dom.rawView.classList.add('hidden');
      return;
    }

    dom.empty.classList.add('hidden');

    if (view.mode === 'raw') {
      dom.rawView.textContent = rawText();
      dom.rawView.classList.remove('hidden');
      dom.richView.classList.add('hidden');
    } else {
      dom.richView.innerHTML = view.entries.map(renderEntry).join('') + renderWorking();
      dom.richView.classList.remove('hidden');
      dom.rawView.classList.add('hidden');
      decorate();
      hydrateMermaid(dom.richView);
    }

    if (nearBottom) {
      stage.scrollTop = stage.scrollHeight;
    }
  }

  function scheduleRender() {
    window.clearTimeout(view.renderTimer);
    view.renderTimer = window.setTimeout(render, 120);
  }

  function addEntry(role, text, extra = {}) {
    view.entries.push({ role, text: String(text ?? ''), ...extra });
    scheduleRender();
  }

  function setMode(mode) {
    view.mode = mode;
    dom.richBtn.setAttribute('aria-pressed', String(mode === 'rich'));
    dom.rawBtn.setAttribute('aria-pressed', String(mode === 'raw'));
    render();
  }

  function paintClock() {
    if (!view.turnStartedAt) {
      return;
    }

    const seconds = Math.max(0, Math.round((Date.now() - view.turnStartedAt) / 1000));

    setStatus(`${view.turnLabel} · ${seconds}s`, true);
  }

  function startTurnClock(label = 'writing') {
    view.turnLabel = label;
    view.turnStartedAt = Date.now();
    paintClock();

    if (!view.statusTimer) {
      view.statusTimer = window.setInterval(paintClock, 1000);
    }
  }

  function setTurnLabel(label) {
    view.turnLabel = label || 'working';
    paintClock();
  }

  function stopTurnClock() {
    window.clearInterval(view.statusTimer);
    view.statusTimer = null;
    view.turnStartedAt = 0;
  }

  // ---------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------

  function publishEventText(event) {
    switch (event.status) {
      case 'branch':
        return `Working on ${event.branch} (base ${event.base}).`;
      case 'skipped':
        return `Git publishing skipped: ${event.reason}`;
      case 'committed':
        return `Committed ${String(event.commit ?? '').slice(0, 7)} on ${event.branch}.`;
      case 'pushed':
        return `Pushed ${event.branch}.`;
      case 'published':
        return event.prUrl
          ? `Pushed ${event.branch}; merge request ready.`
          : `Pushed ${event.branch}; the forge did not return a merge request URL.`;
      case 'failed':
        return `Git publishing failed: ${event.error}`;
      case 'no-changes':
        return event.reason || 'No changes to commit.';
      default:
        return '';
    }
  }

  function onEvent(event) {
    if (event.seq) {
      if (event.seq <= view.seq) {
        return;
      }
      view.seq = event.seq;
    }

    switch (event.type) {
      case 'job-started':
        setStatus('starting', true);
        break;
      case 'worktree':
        view.branch = event.branch ?? '';
        setTurnLabel('working');
        break;
      case 'session-started':
        view.setup = false;
        view.sessionOpen = true;
        view.running = true;
        setSetupVisible(false);
        dom.stage.classList.remove('hidden');
        setComposerVisible(true);
        setComposerAction('send');
        setBarVisible(true);
        paintLock(event);
        addEntry('you', event.brief ?? '');
        setStatus('interviewing · live', true);
        break;
      case 'turn-started':
        view.active = { role: 'agent', text: '' };
        view.entries.push(view.active);
        view.working = [];
        startTurnClock('writing');
        scheduleRender();
        break;
      case 'output':
        if (!view.active) {
          view.active = { role: 'agent', text: '' };
          view.entries.push(view.active);
        }
        view.active.text += event.chunk ?? '';
        scheduleRender();
        break;
      case 'raw':
        view.raw.push(`${event.direction === 'in' ? '→' : '←'} ${String(event.line ?? '')}`);

        if (view.raw.length > 2000) {
          view.raw = view.raw.slice(-2000);
        }
        break;
      case 'activity':
        view.working.push(event.label || 'tool');
        setTurnLabel('working');
        scheduleRender();
        break;
      case 'question': {
        stopTurnClock();
        const target = view.active
          ?? [...view.entries].reverse().find((entry) => entry.role === 'agent');

        if (target && !target.text && typeof event.text === 'string' && event.text) {
          target.text = event.text;
        }

        view.awaiting = true;
        view.active = null;
        setStatus('needs your answer', false);
        setInputEnabled(true, copy.answerPlaceholder);
        if (dom.finish) {
          dom.finish.disabled = false;
        }
        announceStatus('The agent asked a question.');
        scheduleRender();
        break;
      }
      case 'answer':
        view.awaiting = false;
        if (dom.finish) {
          dom.finish.disabled = true;
        }
        addEntry('you', event.text ?? '');
        setInputEnabled(false);
        break;
      case 'permission':
        stopTurnClock();
        addEntry('permission', '', {
          id: event.id,
          tool: event.tool,
          detail: event.detail,
          description: event.description,
          state: 'pending'
        });
        setStatus('needs approval', false);
        announceStatus('The agent asked for permission.');
        break;
      case 'permission-answer': {
        const pending = [...view.entries]
          .reverse()
          .find((entry) => entry.role === 'permission' && entry.state === 'pending');

        if (pending && event.reason !== 'merge-guard') {
          pending.busy = false;
          pending.state = event.reason === 'expired'
            ? 'Expired'
            : event.behavior === 'allow'
              ? 'Allowed once'
              : 'Denied';
        }

        if (view.running) {
          startTurnClock('writing');
        }

        scheduleRender();
        break;
      }
      case 'guard':
        addEntry(
          'guard',
          `Denied ${event.tool ?? 'tool'}${event.detail ? `: ${event.detail}` : ''}`,
          { tool: event.tool, detail: event.detail, reason: event.reason }
        );
        announceStatus('The merge guard denied a command.');
        break;
      case 'publish': {
        const text = publishEventText(event);

        if (text) {
          addEntry('publish', text, { url: event.status === 'published' ? event.prUrl : '' });
        }

        if (event.status === 'published' && event.prUrl) {
          announceStatus('The merge request is ready.');
        }
        break;
      }
      case 'issue-closed':
        addEntry('publish', `Closed ${event.key}${event.status ? ` as ${event.status}` : ''}.`, { url: event.url ?? '' });
        break;
      case 'issue-close-failed':
        addEntry('publish', `Could not close ${event.key}: ${event.error}`);
        break;
      case 'issue-created':
        view.specIssue = { status: 'created', source: event.source, key: event.key, url: event.url ?? '' };
        addEntry('issue', `Filed ${event.key} in ${trackerLabel(event.source)}.`, { url: event.url ?? '' });
        announceStatus(`The spec was filed as ${event.key}.`);
        break;
      case 'issue-skipped':
        view.specIssue = { status: 'skipped', source: event.source, reason: event.reason };
        addEntry('issue', event.reason ?? 'The spec issue was skipped.');
        break;
      case 'issue-create-failed':
        view.specIssue = { status: 'failed', source: event.source, error: event.error };
        addEntry('issue', `Could not file the spec issue: ${event.error}`);
        break;
      case 'build-ready':
        stopTurnClock();
        view.awaiting = true;
        view.active = null;
        setStatus('spec ready', false);
        addEntry('marker', event.spec ? `${event.spec} written` : 'spec.md written');
        if (!view.readOnly) {
          showBuildChoice(event);
        }
        break;
      case 'build-choice':
        // The job emits both build-ready and build-choice; the card is already open.
        break;
      case 'build-started':
        view.build = {
          pipeline: event.pipeline,
          verify: event.verify !== false,
          steps: (event.steps ?? []).map((step) => ({ skill: step.skill, status: 'waiting' })),
          status: 'running'
        };
        hideHandoff();
        view.awaiting = false;
        setStatus('building', true);
        addEntry('marker', `build · ${event.pipeline ?? 'direct'}`);
        break;
      case 'build-step': {
        const index = Number(event.index ?? 0);
        const total = view.build?.steps?.length ?? 0;
        const label = `step ${index + 1}/${total || '?'}  ${event.skill ?? 'step'}`;
        const existing = view.entries.find((entry) => entry.role === 'step' && entry.stepIndex === index);

        if (view.build?.steps?.[index]) {
          view.build.steps[index].status = event.status;
        }

        if (existing) {
          existing.status = event.status;
          existing.error = event.error ?? '';
        } else {
          view.entries.push({
            role: 'step',
            text: label,
            stepIndex: index,
            status: event.status,
            error: event.error ?? ''
          });
        }

        setStatus(`building · ${event.status === 'done' ? 'next step' : event.skill ?? 'step'}`, true);
        scheduleRender();
        break;
      }
      case 'build-done':
        addEntry('marker', 'build done');
        if (view.build) {
          view.build.status = 'done';
        }
        setStatus('publishing', true);
        break;
      case 'job-done':
        if (isMerge && event.summary?.ref) {
          view.mergeMeta = { ...(view.mergeMeta ?? {}), ref: event.summary.ref };
        }
        if (event.summary?.issue) {
          view.specIssue = event.summary.issue;
        }
        if (event.summary?.publish?.prUrl) {
          addEntry('publish', publishEventText(event.summary.publish) || 'Published.', {
            url: event.summary.publish.prUrl
          });
        }
        finishSession('done', '', event.summary);
        break;
      case 'job-stopped':
        finishSession('stopped', '', event.summary);
        break;
      case 'job-cancelled':
        finishSession('stopped', '', event.summary);
        break;
      case 'job-failed':
        finishSession('failed', event.message);
        break;
      default:
        break;
    }
  }

  function finishSession(kind, message = '', summary = null) {
    stopTurnClock();
    const wasReadOnly = view.readOnly;

    view.running = false;
    view.awaiting = false;
    view.finished = kind === 'done';
    view.sessionOpen = true;
    view.jobId = null;
    view.active = null;
    view.working = [];
    dom.stop.disabled = true;
    disarmStop();
    setBarVisible(true);

    if (dom.finish) {
      dom.finish.disabled = true;
    }

    setSetupVisible(false);
    dom.stage.classList.remove('hidden');
    setComposerVisible(false);
    setInputEnabled(false);

    const readyLabel = kind === 'done'
      ? isMerge
        ? 'integration branch ready'
        : flow === 'feature'
          ? 'build finished'
          : flow === 'specIssue' && view.specIssue?.status === 'created'
            ? 'spec filed'
            : `${copy.finalLabel} ready`
      : kind === 'stopped'
        ? 'stopped'
        : 'failed';

    setStatus(kind === 'done' ? readyLabel : kind === 'stopped' ? 'stopped' : 'failed', false);

    if (message) {
      addEntry('session', message);
    }

    if (summary?.output && flow === 'specIssue' && !view.specIssue) {
      view.specIssue = summary.issue ?? null;
    }

    if (view.source) {
      view.source.close();
      view.source = null;
    }

    render();

    if (kind === 'done') {
      const turns = dom.richView.querySelectorAll('.turn-agent');
      const last = turns[turns.length - 1];

      if (last) {
        dom.stage.scrollTop = last.offsetTop - dom.stage.offsetTop;
      }
    }

    announceStatus(
      kind === 'done'
        ? `The ${copy.finalLabel} is ready.`
        : kind === 'stopped'
          ? 'Session stopped.'
          : 'Session failed.'
    );

    if (kind === 'done' && flow === 'specIssue') {
      showSpecIssueResult();
    }

    if (isMerge) {
      if (kind === 'done' && view.mergeMeta?.ref) {
        showMergeLanding();
      } else {
        showMergeRetry(
          kind === 'failed'
            ? message
            : kind === 'stopped'
              ? 'The merge was stopped before the integration branch was created.'
              : 'The session ended without an integration branch.'
        );
      }
    }

    if (!wasReadOnly) {
      window.setTimeout(() => {
        loadSessionList();
      }, 250);
    }
  }

  function showSpecIssueResult() {
    const issue = view.specIssue;
    const tracker = trackerLabel(issue?.source);
    let body;

    if (issue?.status === 'created') {
      const link = issue.url
        ? ` <a href="${escapeText(issue.url)}" target="_blank" rel="noreferrer">Open issue</a>`
        : '';
      body = `<p>Filed as <strong>${escapeText(issue.key)}</strong> in ${escapeText(tracker)}.${link}</p>`;
    } else if (issue?.status === 'failed') {
      body = `<p>The spec is saved, but ${escapeText(tracker)} refused the issue: ${escapeText(issue.error)}</p>`;
    } else if (issue?.status === 'skipped') {
      body = `<p>The spec is saved, but no issue was created. ${escapeText(issue.reason ?? '')}</p>`;
    } else {
      body = '<p>The spec is saved. No tracker issue was created.</p>';
    }

    dom.handoff.innerHTML = `
      <section class="handoff-card" aria-labelledby="spec-issue-title">
        <p class="handoff-eyebrow">Spec ready</p>
        <h2 id="spec-issue-title">${issue?.status === 'created' ? 'Issue filed' : 'Spec saved'}</h2>
        ${body}
        <p class="handoff-lede">Nothing was committed or pushed. Start another spec from the session list when you are ready.</p>
      </section>
    `;
    dom.handoff.classList.remove('hidden');
  }

  // ---------------------------------------------------------------
  // Feature build: a turn in the same session, not a separate job
  // ---------------------------------------------------------------

  function showBuildChoice(event) {
    dom.handoff.innerHTML = `
      <section class="handoff-card build-choice" aria-labelledby="handoff-title">
        <p class="handoff-eyebrow">Spec ready</p>
        <h2 id="handoff-title">How should the agent build it?</h2>
        <p class="handoff-lede">Choose a path. The build runs in this same session, and the transcript below shows every step.</p>

        <div class="pipeline-list" role="radiogroup" aria-label="Implementation path">
          <label class="pipeline">
            <input type="radio" name="pipeline" value="direct" checked>
            <span class="pipeline-body">
              <span class="pipeline-name">Direct implementation</span>
              <span class="pipeline-skill">sdd-developer</span>
              <span class="pipeline-note">One agent run: implement the spec, review and fix, verify each story.</span>
            </span>
          </label>
          <label class="pipeline">
            <input type="radio" name="pipeline" value="tdd">
            <span class="pipeline-body">
              <span class="pipeline-name">Task-by-task TDD</span>
              <span class="pipeline-skill">spec-to-task → feature-tdd</span>
              <span class="pipeline-note">Split the spec into tasks first, then implement each task with Chicago TDD.</span>
            </span>
          </label>
        </div>

        <label class="toggle handoff-verify">
          <input type="checkbox" data-role="verify" checked>
          <span>Run E2E verification</span>
        </label>
        <p class="hint" data-role="verify-hint">Each User Story and its acceptance criteria get verified after implementation.</p>

        <div class="actions handoff-actions">
          <button type="button" class="btn primary" data-role="build-start">Start build</button>
          <span class="handoff-error" data-role="build-error" role="alert"></span>
        </div>
      </section>
    `;
    dom.handoff.classList.remove('hidden');

    const verifyBox = dom.handoff.querySelector('[data-role="verify"]');
    const hint = dom.handoff.querySelector('[data-role="verify-hint"]');

    verifyBox.addEventListener('change', () => {
      hint.textContent = verifyBox.checked
        ? 'Each User Story and its acceptance criteria get verified after implementation.'
        : 'The pipeline runs with --no-verify: implementation and review still run.';
    });

    dom.handoff.querySelector('[data-role="build-start"]').addEventListener('click', startBuild);
    announceStatus('The spec is ready. Choose how to build it.');
  }

  async function startBuild() {
    const pipeline = dom.handoff.querySelector('input[name="pipeline"]:checked')?.value ?? 'direct';
    const verify = dom.handoff.querySelector('[data-role="verify"]')?.checked !== false;
    const errorEl = dom.handoff.querySelector('[data-role="build-error"]');

    if (errorEl) {
      errorEl.textContent = '';
    }

    if (!view.sessionId) {
      return;
    }

    try {
      await api(`${copy.endpoint}/${view.sessionId}/build`, {
        method: 'POST',
        body: JSON.stringify({ pipeline, verify })
      });
      hideHandoff();
      view.awaiting = false;
      setInputEnabled(false);
      setStatus('building', true);
      announceStatus('Build started.');
    } catch (error) {
      if (errorEl) {
        errorEl.textContent = error.message;
      }
    }
  }

  function hideHandoff() {
    dom.handoff.classList.add('hidden');
    dom.handoff.innerHTML = '';
  }

  // ---------------------------------------------------------------
  // Merge setup and landing
  // ---------------------------------------------------------------

  function renderMergeSetup(error = '') {
    view.setup = true;
    view.sessionOpen = false;
    view.finished = false;
    setSetupVisible(true);
    setComposerVisible(false);
    setInputEnabled(false);
    dom.stop.disabled = true;
    if (dom.finish) dom.finish.disabled = true;
    setStatus('ready', false);
    setBarVisible(false);
    hideHandoff();

    const git = state.config?.git;

    if (!git?.repo) {
      dom.setup.innerHTML = `
        <div class="session-start merge-setup">
          <h2>Open the studio inside a git repository.</h2>
          <p class="session-start-lede">A merge needs local branches. The current workspace is
            <code>${escapeText(state.config?.cwd ?? '')}</code>, and it is not a git checkout.</p>
        </div>
      `;
      return;
    }

    const branches = git.branches ?? [];

    if (branches.length < 2) {
      dom.setup.innerHTML = `
        <div class="session-start merge-setup">
          <h2>This repository has only one local branch.</h2>
          <p class="session-start-lede">Create the source branch first. A merge needs a source and a
            target that are not the same branch.</p>
        </div>
      `;
      return;
    }

    const current = branches.includes(git.branch)
      ? git.branch
      : (branches.includes(git.base) ? git.base : branches[0]);
    const previous = view.setupChoice ?? {};
    const target = branches.includes(previous.target) ? previous.target : current;
    const source = branches.includes(previous.source) && previous.source !== target
      ? previous.source
      : (branches.find((branch) => branch !== target) ?? '');
    const options = (selected) => branches
      .map((branch) => `<option value="${escapeText(branch)}"${branch === selected ? ' selected' : ''}>${escapeText(branch)}</option>`)
      .join('');

    dom.setup.innerHTML = `
      <div class="session-start merge-setup" aria-label="Merge setup">
        <p class="session-start-lede">The live Claude process dry-runs the merge in a worktree opened from the target,
          asks one decision at a time, and builds the integration branch. It never touches the target; landing is a
          separate, explicit step.</p>

        ${selectionMarkup()}

        <div class="merge-fields">
          <label class="merge-field">
            <span>Source</span>
            <select data-role="merge-source" aria-label="Source branch">${options(source)}</select>
          </label>
          <span class="merge-arrow" aria-hidden="true">→</span>
          <label class="merge-field">
            <span>Into</span>
            <select data-role="merge-target" aria-label="Target branch">${options(target)}</select>
          </label>
        </div>

        <p class="merge-ref">Integration branch <code data-role="merge-ref"></code></p>
        ${git.dirty && !error ? '<p class="merge-warning">The working tree has changes. Commit or stash them before landing; the merge itself uses a worktree.</p>' : ''}

        <div class="actions handoff-actions">
          <button type="button" class="btn primary" data-role="merge-start">Review merge</button>
          <span class="handoff-error" data-role="merge-error" role="alert">${escapeText(error)}</span>
        </div>
      </div>
    `;

    wireSelection();

    const sourceEl = dom.setup.querySelector('[data-role="merge-source"]');
    const targetEl = dom.setup.querySelector('[data-role="merge-target"]');
    const refEl = dom.setup.querySelector('[data-role="merge-ref"]');
    const errorEl = dom.setup.querySelector('[data-role="merge-error"]');
    const startBtn = dom.setup.querySelector('[data-role="merge-start"]');

    const update = () => {
      const from = sourceEl.value;
      const into = targetEl.value;
      const same = Boolean(from && into && from === into);

      refEl.textContent = same || !from || !into ? '—' : `merge/${from}-into-${into}`;
      startBtn.disabled = same || !from || !into;
      errorEl.textContent = same ? 'Pick two different branches.' : (view.setupError ?? '');
      view.setupChoice = { source: from, target: into };
    };

    for (const select of [sourceEl, targetEl]) {
      select.addEventListener('change', () => {
        view.setupError = '';
        update();
      });
    }

    startBtn.addEventListener('click', () => startMergeSession(sourceEl.value, targetEl.value));
    update();
  }

  async function startMergeSession(source, target) {
    const selection = selectedFromSetup();

    rememberWorkflow(flow, selection);
    resetSession({ setup: false });
    view.running = true;
    view.setup = false;
    view.mergeMeta = null;
    setSetupVisible(false);
    dom.stage.classList.remove('hidden');
    setComposerVisible(true);
    dom.stop.disabled = false;
    setInputEnabled(false);
    setStatus('starting', true);
    paintLock(selection);
    render();

    try {
      const { job } = await api(copy.endpoint, {
        method: 'POST',
        body: JSON.stringify({ source, target, merge: { source, target }, ...selection })
      });

      view.mergeMeta = job.request?.merge ?? { source, target, ref: `merge/${source}-into-${target}` };
      paintLock(job.selection ?? selection);
      attach(job.id);
      announceStatus('Merge session started.');
    } catch (error) {
      resetSession();
      renderSetup(error.message);
      announceStatus(`The merge could not start: ${error.message}`);
    }
  }

  function showMergeRetry(message) {
    dom.handoff.innerHTML = `
      <section class="handoff-card merge-retry" aria-labelledby="merge-retry-title">
        <p class="handoff-eyebrow">Merge</p>
        <h2 id="merge-retry-title">No integration branch yet.</h2>
        <p class="handoff-lede">${escapeText(message || 'The session ended before the integration branch was created.')}</p>
        <div class="actions handoff-actions">
          <button type="button" class="btn primary" data-role="merge-new">Set up another merge</button>
        </div>
      </section>
    `;
    dom.handoff.classList.remove('hidden');
    dom.handoff.querySelector('[data-role="merge-new"]').addEventListener('click', () => resetSession());
    setStatus('no merge', false);
  }

  function showMergeLanding() {
    const meta = view.mergeMeta ?? {};
    const target = meta.target ?? '';
    const ref = meta.ref ?? (meta.source ? `merge/${meta.source}-into-${target}` : '');

    if (!target || !ref) {
      showMergeRetry('The session ended without an integration branch to land.');
      return;
    }

    dom.handoff.innerHTML = `
      <section class="handoff-card merge-landing" aria-labelledby="merge-landing-title">
        <p class="handoff-eyebrow">Integration branch ready</p>
        <h2 id="merge-landing-title">Land <code>${escapeText(ref)}</code> on <code>${escapeText(target)}</code>?</h2>
        <p class="handoff-lede">Landing is a fast-forward. The studio switches to
          <code>${escapeText(target)}</code>, fast-forwards it, and stays there. Nothing is pushed,
          and no merge commit is created.</p>

        <dl class="merge-facts">
          <div><dt>integration</dt><dd><code>${escapeText(ref)}</code></dd></div>
          <div><dt>target</dt><dd><code>${escapeText(target)}</code></dd></div>
        </dl>

        <div class="actions handoff-actions">
          <button type="button" class="btn primary" data-role="merge-land">Land on ${escapeText(target)}</button>
          <button type="button" class="btn quiet" data-role="merge-new">New merge</button>
          <span class="handoff-error" data-role="merge-error" role="alert"></span>
        </div>

        <p class="hint">If <code>${escapeText(target)}</code> moved since the merge started,
          landing is refused and you start a new merge against the current target.</p>
      </section>
    `;
    dom.handoff.classList.remove('hidden');

    const landBtn = dom.handoff.querySelector('[data-role="merge-land"]');
    const errorEl = dom.handoff.querySelector('[data-role="merge-error"]');
    const label = `Land on ${target}`;

    landBtn.addEventListener('click', async () => {
      landBtn.disabled = true;
      landBtn.textContent = 'Landing…';
      errorEl.textContent = '';

      try {
        const result = await api(`${copy.endpoint}/${view.sessionId}/land`, { method: 'POST' });

        showMergeLanded(result);
        announceStatus(`Landed on ${result.target}.`);
      } catch (error) {
        landBtn.disabled = false;
        landBtn.textContent = label;
        errorEl.textContent = error.message;
        announceStatus('The branch could not be landed.');
      }
    });

    dom.handoff.querySelector('[data-role="merge-new"]').addEventListener('click', () => resetSession());
    setStatus('ready to land', false);
  }

  function showMergeLanded(result) {
    const target = result.target ?? 'the target';
    const shortSha = String(result.sha ?? '').slice(0, 12);

    dom.handoff.innerHTML = `
      <section class="handoff-card merge-landed" aria-labelledby="merge-landed-title">
        <p class="handoff-eyebrow">Landed</p>
        <h2 id="merge-landed-title"><code>${escapeText(target)}</code> is up to date.</h2>
        <p class="handoff-lede">Fast-forwarded to <code>${escapeText(shortSha)}</code>.
          Nothing was pushed. You are on <code>${escapeText(target)}</code>.</p>
        <div class="actions handoff-actions">
          <button type="button" class="btn primary" data-role="merge-new">New merge</button>
        </div>
      </section>
    `;
    dom.handoff.classList.remove('hidden');
    dom.handoff.querySelector('[data-role="merge-new"]').addEventListener('click', () => resetSession());
    setStatus('landed', false);
  }

  // ---------------------------------------------------------------
  // Start, answer, finish, stop, attach
  // ---------------------------------------------------------------

  async function start(brief) {
    const selection = view.setup ? selectedFromSetup() : workflowSettings(flow);
    const sourceIssue = isMerge ? null : view.sourceIssue;

    rememberWorkflow(flow, selection);

    resetSession({ setup: false });
    view.running = true;
    dom.stop.disabled = false;
    setSetupVisible(false);
    setComposerVisible(true);
    setInputEnabled(false);
    setStatus('starting', true);
    paintLock(selection);
    render();

    try {
      const { job } = await api(copy.endpoint, {
        method: 'POST',
        body: JSON.stringify({
          brief,
          ...selection,
          ...(sourceIssue ? { issue: sourceIssue } : {}),
          ...(flow === 'specIssue' ? { specIssueSource: dom.setup.querySelector('[data-role="issue-source"]')?.value ?? '' } : {}),
          closeIssues: Boolean(el.form.closeIssues?.checked)
        })
      });

      paintLock(job.selection ?? selection);
      attach(job.id);
      announceStatus('Session started.');
    } catch (error) {
      view.running = false;
      view.sourceIssue = sourceIssue;
      dom.stop.disabled = true;
      setStatus('failed', false);
      addEntry('session', error.message);
      setSetupVisible(false);
      setComposerVisible(true);
      setComposerAction('start');
      setInputEnabled(true, copy.placeholder);
      render();
    }
  }

  async function answer(text) {
    if (!view.jobId || !view.awaiting) {
      return;
    }

    view.awaiting = false;
    if (dom.finish) dom.finish.disabled = true;
    setInputEnabled(false);
    setStatus('sending', true);
    render();

    try {
      await api(`/api/jobs/${view.jobId}/input`, {
        method: 'POST',
        body: JSON.stringify({ answer: text })
      });
    } catch (error) {
      view.awaiting = true;
      if (dom.finish) dom.finish.disabled = false;
      addEntry('session', `Could not send the answer: ${error.message}`);
      setInputEnabled(true, copy.answerPlaceholder);
      render();
    }
  }

  async function finish() {
    if (!view.jobId || !view.awaiting || !dom.finish) {
      return;
    }

    view.awaiting = false;
    view.running = true;
    dom.finish.disabled = true;
    setInputEnabled(false);
    setStatus('closing', true);

    try {
      await api(`/api/jobs/${view.jobId}/input`, {
        method: 'POST',
        body: JSON.stringify({ done: true })
      });
    } catch (error) {
      view.awaiting = true;
      view.running = false;
      dom.finish.disabled = false;
      addEntry('session', `Could not finish the session: ${error.message}`);
      setInputEnabled(true, copy.answerPlaceholder);
      render();
    }
  }

  function disarmStop() {
    stopArmed = false;
    window.clearTimeout(stopTimer);
    stopTimer = null;

    if (dom.stop) {
      dom.stop.textContent = 'Stop';
      dom.stop.classList.remove('armed');
      dom.stop.title = 'Stop the process and delete the worktree';
    }
  }

  async function stop() {
    if (!view.jobId || view.readOnly) {
      return;
    }

    if (!stopArmed) {
      stopArmed = true;
      dom.stop.textContent = 'Confirm stop';
      dom.stop.classList.add('armed');
      dom.stop.title = 'This kills the process and deletes the worktree. Click again to confirm.';
      announceStatus('Stop again to kill the process and delete the worktree.');
      stopTimer = window.setTimeout(disarmStop, 6000);
      return;
    }

    disarmStop();
    dom.stop.disabled = true;
    setStatus('stopping', false);

    try {
      await api(`${copy.endpoint}/${view.jobId}/cancel`, { method: 'POST' });
    } catch (error) {
      addEntry('session', `Could not stop the session: ${error.message}`);
      dom.stop.disabled = false;
      render();
    }
  }

  function attach(jobId) {
    if (view.source) {
      view.source.close();
    }

    view.jobId = jobId;
    view.sessionId = jobId;
    view.running = true;
    view.seq = 0;
    dom.stop.disabled = false;
    setStatus('connecting', true);
    renderSessionList();

    const source = new EventSource(`${copy.endpoint}/${jobId}/events`);

    view.source = source;
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data));
      } catch {
        // Ignore malformed events; the stream is best-effort.
      }
    };
    source.onopen = () => setStatus(view.awaiting ? 'needs your answer' : 'live', true);
    source.onerror = () => setStatus('reconnecting', false);
  }

  function resetSession({ setup = true } = {}) {
    if (view.source) {
      view.source.close();
    }

    window.clearTimeout(view.renderTimer);
    stopTurnClock();
    disarmStop();
    view.jobId = null;
    view.sessionId = null;
    view.source = null;
    view.entries = [];
    view.raw = [];
    view.active = null;
    view.awaiting = false;
    view.running = false;
    view.finished = false;
    view.readOnly = false;
    view.setup = false;
    view.sessionOpen = !setup;
    view.seq = 0;
    view.working = [];
    view.build = null;
    view.mergeMeta = null;
    view.setupError = '';
    view.sourceIssue = null;
    view.specIssue = null;
    view.branch = '';
    hideHandoff();
    paintLock({});
    dom.empty.classList.remove('hidden');
    dom.richView.innerHTML = '';
    dom.rawView.textContent = '';
    dom.richView.classList.add('hidden');
    dom.rawView.classList.add('hidden');
    dom.stop.disabled = true;
    if (dom.finish) dom.finish.disabled = true;
    dom.input.value = '';
    setStatus('ready', false);
    setBarVisible(false);
    setComposerVisible(false);
    setInputEnabled(false);
    issueChoices = [];
    render();
    setListExpanded(false);

    if (setup) {
      renderSetup();
    } else {
      setSetupVisible(false);
      dom.stage.classList.remove('hidden');
      setComposerVisible(true);
      setComposerAction('send');
      setBarVisible(true);
    }

    renderSessionList();
  }

  async function restore() {
    await loadSessionList();

    const active = view.jobs.find((job) => isAlive(job) && !job.readOnly);

    if (active) {
      paintLock(active.selection ?? {});
      await openSession(active);
    } else {
      resetSession();
    }
  }

  function autoGrow() {
    dom.input.style.height = 'auto';
    dom.input.style.height = `${Math.min(dom.input.scrollHeight, 200)}px`;
  }

  function syncConfig() {
    if (view.setup && !view.running) {
      renderSetup(view.setupError ?? '');
    }

    updateSessionListMetadata();
  }

  function updateSessionListMetadata() {
    if (view.jobs.length > 0) {
      renderSessionList();
    }
  }

  dom.inputForm.addEventListener('submit', (event) => {
    event.preventDefault();

    const text = dom.input.value.trim();

    if (!text) {
      return;
    }

    dom.input.value = '';
    autoGrow();

    if (!view.jobId && !view.readOnly) {
      start(text);
    } else if (view.awaiting) {
      answer(text);
    }
  });
  dom.input.addEventListener('input', autoGrow);
  dom.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      dom.inputForm.requestSubmit();
    }
  });
  dom.richBtn.addEventListener('click', () => setMode('rich'));
  dom.rawBtn.addEventListener('click', () => setMode('raw'));
  dom.stop.addEventListener('click', stop);
  dom.finish?.addEventListener('click', finish);
  dom.listToggle.addEventListener('click', () => {
    setListExpanded(!listExpanded);
  });
  dom.newBtn.addEventListener('click', () => {
    resetSession();
    loadSessionList();
    announceStatus('Ready for a new session.');
  });
  dom.list.addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-action]');
    const row = event.target.closest?.('.session-row');

    if (!button || !row) {
      return;
    }

    const job = view.jobs.find((entry) => entry.id === row.dataset.id);

    if (!job) {
      return;
    }

    const action = button.dataset.action;

    if (action === 'open') {
      await openSession(job);
      return;
    }

    if (action === 'stop') {
      if (!window.confirm('Stop this session? This kills the process and deletes its worktree.')) {
        return;
      }

      try {
        await api(`${copy.endpoint}/${job.id}/cancel`, { method: 'POST' });
        announceStatus('Stopping the session.');
        window.setTimeout(loadSessionList, 300);
      } catch (error) {
        announceStatus(`Could not stop the session: ${error.message}`);
      }
      return;
    }

    if (action === 'remove') {
      if (!window.confirm('Remove this session from history? The files under .sdd/sessions are deleted.')) {
        return;
      }

      try {
        await api(`${copy.endpoint}/${job.id}`, { method: 'DELETE' });

        if (view.sessionId === job.id) {
          resetSession();
        }

        await loadSessionList();
        announceStatus('Session removed from history.');
      } catch (error) {
        announceStatus(`Could not remove the session: ${error.message}`);
      }
    }
  });
  dom.richView.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-permission]');

    if (!button || !view.jobId || view.readOnly) {
      return;
    }

    const entry = view.entries.find((item) => item.role === 'permission' && item.id === button.dataset.id);

    if (!entry || entry.state !== 'pending' || entry.busy) {
      return;
    }

    entry.busy = true;
    render();

    api(`/api/jobs/${view.jobId}/permission`, {
      method: 'POST',
      body: JSON.stringify({ id: entry.id, behavior: button.dataset.permission })
    }).then((result) => {
      if (result?.accepted === false) {
        entry.busy = false;
        entry.state = 'Expired';
        render();
      }
    }).catch((error) => {
      entry.busy = false;
      addEntry('session', `Could not send the approval: ${error.message}`);
      render();
    });
  });
  dom.copy.addEventListener('click', async () => {
    const text = rawText();

    if (!text.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      dom.copy.textContent = 'Copied';
      window.setTimeout(() => {
        dom.copy.textContent = 'Copy';
      }, 1400);
    } catch {
      dom.copy.textContent = 'Select to copy';
      window.setTimeout(() => {
        dom.copy.textContent = 'Copy';
      }, 1800);
    }
  });

  resetSession();

  return {
    reset: resetSession,
    restore,
    syncConfig,
    syncIssueSource,
    refreshSetup: () => {
      if (isMerge && view.setup && !view.running) {
        renderMergeSetup(view.setupError ?? '');
      }
    },
    view
  };
}

const sessionViews = {
  enhancement: createSession('enhancement'),
  feature: createSession('feature'),
  specIssue: createSession('specIssue'),
  merge: createSession('merge')
};

const WORKFLOW_LABELS = {
  enhancement: 'Enhancement',
  feature: 'Feature',
  specIssue: 'Spec issue',
  merge: 'Merge',
  bugSweep: 'Bug fixing'
};

const SECRET_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN'
]);

const MODEL_ENV_KEYS = new Set([
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL'
]);

function envModels() {
  const env = state.config?.settings?.claudeEnv ?? {};

  return [...new Set([...MODEL_ENV_KEYS].map((key) => env[key]).filter(Boolean))];
}

function renderModelOptions() {
  for (const picker of document.querySelectorAll('[data-model-picker]')) {
    const select = picker.querySelector('select');
    const input = picker.querySelector('input');
    const current = select?.value === CUSTOM_MODEL ? input?.value ?? '' : select?.value ?? '';

    fillModelPicker(picker, current);
  }
}

async function loadClaudeModels() {
  try {
    const result = await api('/api/claude/models');
    state.models = Array.isArray(result.models) ? result.models : [];
    state.modelsError = result.error || '';
  } catch (error) {
    state.models = [];
    state.modelsError = error.message;
  }

  renderModelOptions();

  if (el.modelSource) {
    el.modelSource.textContent = state.modelsError
      ? `Using the configured environment model. ${state.modelsError}`
      : `${state.models.length} model${state.models.length === 1 ? '' : 's'} from Claude Code.`;
  }
}

function renderClaudeEnv() {
  if (!el.claudeEnv) {
    return;
  }

  const env = state.config?.settings?.claudeEnv ?? {};
  const secrets = new Set(state.config?.settings?.claudeEnvSecrets ?? []);

  el.claudeEnv.replaceChildren();

  for (const [key, value] of Object.entries(env)) {
    const row = document.createElement('div');
    const secret = secrets.has(key) || SECRET_ENV_KEYS.has(key);

    row.className = 'env-row';
    row.innerHTML = `
      <label class="field"><span>Key</span><input data-field="key" value="${escapeText(key)}" placeholder="ANTHROPIC_BASE_URL" autocomplete="off"></label>
      <label class="field"><span>Value</span><input data-field="value" type="${secret ? 'password' : 'text'}" placeholder="${secret ? 'saved locally' : ''}" autocomplete="off"></label>
      <button type="button" class="icon-btn env-remove" data-role="remove-env" title="Remove variable" aria-label="Remove ${escapeText(key)}">-</button>
    `;

    row.querySelector('[data-field="value"]').value = secret ? '' : value;
    row.querySelector('[data-field="key"]').addEventListener('change', () => {
      const input = row.querySelector('[data-field="value"]');
      input.type = SECRET_ENV_KEYS.has(row.querySelector('[data-field="key"]').value.trim()) ? 'password' : 'text';
    });
    el.claudeEnv.append(row);
  }
}

function readClaudeEnv() {
  const env = {};

  for (const row of el.claudeEnv?.querySelectorAll('.env-row') ?? []) {
    const key = row.querySelector('[data-field="key"]')?.value.trim() ?? '';
    const value = row.querySelector('[data-field="value"]')?.value ?? '';

    if (key) {
      env[key] = value;
    }
  }

  return env;
}

function saveClaudeEnv() {
  if (!state.config) {
    return;
  }

  const env = readClaudeEnv();

  state.config.settings = state.config.settings ?? {};
  state.config.settings.claudeEnv = { ...env };
  state.config.settings.claudeEnvSecrets = Object.entries(env)
    .filter(([key, value]) => SECRET_ENV_KEYS.has(key) && value)
    .map(([key]) => key);

  api('/api/settings', {
    method: 'POST',
    body: JSON.stringify({ claudeEnv: env })
  }).catch(() => {});

  loadClaudeModels();
  renderWorkflowDefaults();
}

function addClaudeEnvRow() {
  if (!el.claudeEnv) {
    return;
  }

  const row = document.createElement('div');

  row.className = 'env-row';
  row.innerHTML = `
    <label class="field"><span>Key</span><input data-field="key" placeholder="ANTHROPIC_BASE_URL" autocomplete="off"></label>
    <label class="field"><span>Value</span><input data-field="value" type="text" autocomplete="off"></label>
    <button type="button" class="icon-btn env-remove" data-role="remove-env" title="Remove variable" aria-label="Remove variable">-</button>
  `;
  el.claudeEnv.append(row);
  row.querySelector('[data-field="key"]').focus();
}
function renderWorkflowDefaults() {
  if (!el.workflowDefaults) {
    return;
  }

  el.workflowDefaults.replaceChildren();

  for (const flow of state.config?.workflowsAvailable ?? Object.keys(WORKFLOW_LABELS)) {
    const selection = workflowSettings(flow);
    const row = document.createElement('div');

    row.className = 'workflow-default';
    row.dataset.flow = flow;
    row.innerHTML = `
      <p class="workflow-name">${escapeText(WORKFLOW_LABELS[flow] ?? flow)}</p>
      <label class="field workflow-model"><span>Model</span>
        <span class="model-picker" data-model-picker>
          <select data-field="model-select" aria-label="Model"></select>
          <input data-field="model" class="model-custom hidden" placeholder="Model id" autocomplete="off" aria-label="Custom model id">
        </span>
      </label>
      <label class="field workflow-effort"><span>Effort</span><select data-field="effort"></select></label>
      <label class="toggle workflow-mr"><input type="checkbox" data-field="mr" ${selection.mr !== false ? 'checked' : ''}><span>MR</span></label>
    `;

    const modelPicker = row.querySelector('[data-model-picker]');
    const effortSelect = row.querySelector('[data-field="effort"]');

    fillModelPicker(modelPicker, selection.model);
    fillEffortSelect(effortSelect, selection.effort);
    wireModelPicker(modelPicker, () => updateWorkflowFromRow(row));
    effortSelect.addEventListener('change', () => updateWorkflowFromRow(row));
    row.querySelector('[data-field="mr"]').addEventListener('change', () => updateWorkflowFromRow(row));
    el.workflowDefaults.append(row);
  }
}

function updateWorkflowFromRow(row) {
  const flow = row.dataset.flow;

  if (!flow) {
    return;
  }

  const selection = {
    model: modelPickerValue(row.querySelector('[data-model-picker]')),
    effort: row.querySelector('[data-field="effort"]').value,
    mr: row.querySelector('[data-field="mr"]').checked
  };

  rememberWorkflow(flow, selection);

  if (flow === 'bugSweep') {
    renderSweepSelection();
  }
}

function loadMermaid() {
  if (window.mermaid) {
    return Promise.resolve(window.mermaid);
  }

  if (mermaidLoader) {
    return mermaidLoader;
  }

  mermaidLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');

    script.src = '/vendor/mermaid/mermaid.min.js';
    script.async = true;
    script.onload = () => {
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          fontFamily: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          flowchart: { htmlLabels: false },
          themeVariables: {
            background: '#f7f8f9',
            primaryColor: '#e8eef5',
            primaryTextColor: '#1b2026',
            primaryBorderColor: '#8ba0b5',
            lineColor: '#5c6a78',
            secondaryColor: '#eef1f4',
            tertiaryColor: '#f2f5f8',
            noteBkgColor: '#f2f5f8',
            noteTextColor: '#1b2026',
            noteBorderColor: '#c2cbd4',
            edgeLabelBackground: '#f7f8f9',
            clusterBkg: '#f1f4f7',
            clusterBorder: '#c2cbd4',
            actorBkg: '#e8eef5',
            actorBorder: '#8ba0b5',
            actorTextColor: '#1b2026',
            signalColor: '#5c6a78',
            signalTextColor: '#1b2026',
            labelBoxBkgColor: '#f2f5f8',
            labelBoxBorderColor: '#8ba0b5',
            labelTextColor: '#1b2026',
            loopTextColor: '#1b2026',
            activationBkgColor: '#dfe7ef',
            activationBorderColor: '#8ba0b5',
            fontSize: '13px'
          }
        });
        resolve(window.mermaid);
      } catch (error) {
        reject(error);
      }
    };
    script.onerror = () => reject(new Error('The diagram renderer could not be loaded.'));
    document.head.append(script);
  });

  return mermaidLoader;
}

async function hydrateMermaid(container) {
  const blocks = [...container.querySelectorAll('pre.mermaid')];

  if (blocks.length === 0) {
    return;
  }

  const pending = [];

  for (const block of blocks) {
    const source = block.textContent;
    const cached = mermaidCache.get(source);

    if (cached) {
      block.closest('.md-mermaid')?.replaceWith(cached.cloneNode(true));
    } else {
      pending.push({ block, source });
    }
  }

  if (pending.length === 0) {
    return;
  }

  let mermaid;

  try {
    mermaid = await loadMermaid();
  } catch (error) {
    for (const { block, source } of pending) {
      const failure = document.createElement('div');

      failure.className = 'mermaid-error';
      failure.innerHTML = '<p></p><pre></pre>';
      failure.querySelector('p').textContent = error.message;
      failure.querySelector('pre').textContent = source;
      block.closest('.md-mermaid')?.replaceWith(failure);
    }
    return;
  }

  for (const { block, source } of pending) {
    if (!block.isConnected) {
      continue;
    }

    try {
      const { svg } = await mermaid.render(`sdd-mermaid-${++mermaidSequence}`, source);
      const figure = document.createElement('div');

      figure.className = 'mermaid-figure';
      figure.innerHTML = svg;
      mermaidCache.set(source, figure.cloneNode(true));
      block.closest('.md-mermaid')?.replaceWith(figure);
    } catch (error) {
      const failure = document.createElement('div');

      failure.className = 'mermaid-error';
      failure.innerHTML = '<p></p><pre></pre>';
      failure.querySelector('p').textContent = `Diagram could not be rendered: ${error.message || error}`;
      failure.querySelector('pre').textContent = source;
      mermaidCache.set(source, failure.cloneNode(true));
      block.closest('.md-mermaid')?.replaceWith(failure);
    }
  }
}

function switchView(view) {
  document.body.classList.toggle('live-mode', view !== 'sweep');

  for (const item of $$('.nav-item')) {
    const active = item.dataset.view === view;

    item.classList.toggle('active', active);

    if (active) {
      item.setAttribute('aria-current', 'page');
    } else {
      item.removeAttribute('aria-current');
    }
  }
  for (const section of $$('.view')) {
    section.classList.toggle('hidden', section.dataset.view !== view);
  }
}

function setFormValue(name, value) {
  if (value !== undefined && value !== null && value !== '') {
    el.form[name].value = value;
  }
}

async function loadConfig() {
  try {
    const config = await api('/api/config');
    const settings = config.settings ?? {};
    const defaults = config.defaults ?? {};

    state.config = config;
    el.versionChip.textContent = `v${config.version}`;

    if (config.git?.repo) {
      el.repoInfo.textContent = `${config.git.root} · ${config.git.branch}${config.git.dirty ? ' (dirty)' : ''}`;
    } else {
      el.repoInfo.textContent = `${config.cwd} · not a git repository`;
    }

    const jira = config.jira ?? {};

    // Remembered choices win; detected defaults fill the gaps.
    setFormValue('project', settings.project);
    setFormValue('source', settings.source);
    setFormValue('githubRepo', settings.githubRepo || config.github?.repo);
    setFormValue('gitlabProject', settings.gitlabProject);
    el.githubInfo.textContent = config.github?.repo ? `GitHub CLI: ${config.github.repo}` : 'GitHub CLI: not configured';
    setFormValue('base', settings.base);
    const detectedJiraType = settings.jiraType || (
      (settings.jiraAuth === 'bearer' || settings.jiraApiVersion === '2' || jira.auth === 'bearer')
        ? 'datacenter'
        : 'cloud'
    );
    setFormValue('jiraType', detectedJiraType);
    setFormValue('jiraAuth', settings.jiraAuth || (detectedJiraType === 'datacenter' ? 'bearer' : 'basic'));
    setFormValue('jiraApiVersion', settings.jiraApiVersion || (detectedJiraType === 'datacenter' ? '2' : '3'));
    setFormValue('jiraCa', settings.jiraCa);
    setFormValue('prCommand', settings.prCommand);
    setFormValue('jiraUrl', settings.jiraUrl || jira.url);
    setFormValue('jiraEmail', settings.jiraEmail || jira.email);
    updateJiraTypeSettings();

    el.form.jiraInsecure.checked = settings.jiraInsecure === true || jira.insecure === true;
    el.form.jiraToken.value = '';
    el.form.jiraToken.placeholder = jira.hasSavedToken
      ? '•••••••• (saved locally)'
      : jira.hasToken
        ? '•••••••• (from environment)'
        : '••••••••';
    updateTrackerStatus();

    renderClaudeEnv();
    renderWorkflowDefaults();
    renderSweepSelection();
    loadClaudeModels();

    el.form.base.placeholder = defaults.base || 'detected';

    el.form.prPreset.innerHTML = '';
    for (const preset of prPresets()) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      el.form.prPreset.append(option);
    }

    const savedPrPreset = settings.prPreset || inferPrPreset(settings.prCommand);

    el.form.prPreset.value = prPresets().some((preset) => preset.id === savedPrPreset)
      ? savedPrPreset
      : (defaults.prPreset || 'github');
    togglePrCustom();

    // Publishing always pushes now, so a legacy commit-only setting becomes a
    // plain push and an independent push/pr pair still resolves to one choice.
    el.form.publish.value = publishChoice(settings);
    if (el.form.closeIssues) {
      el.form.closeIssues.checked = settings.closeIssues === true;
    }

    updatePlan();
    for (const set of Object.values(sessionViews)) {
      set?.syncConfig?.();
      set?.syncIssueSource?.();
    }
    // The merge setup reads local branches from this config, so it refreshes
    // after a landing or a retry without leaving the tab.
    sessionViews.merge?.refreshSetup?.();
    setConnection('live', 'connected');
    // With no remembered project there is nothing to start; open Settings on the
    // first visit so the project is the first thing in reach, then stay out of
    // the way on later reloads.
    if (!currentTarget() && settings.settingsSeen !== true) {
      openAdvanced();
    }
    loadProjects();
    loadBugs();
  } catch (error) {
    setConnection('down', 'offline');
    el.repoInfo.textContent = `Could not load the workspace: ${error.message}`;
  }
}

async function loadLatestJob() {
  try {
    const { jobs } = await api('/api/sweeps');

    if (!jobs.length) {
      return;
    }

    const latest = jobs[jobs.length - 1];

    resetRun();

    for (const event of latest.events) {
      handleEvent(event);
    }

    if (['running', 'queued', 'cancelling'].includes(latest.status)) {
      attach(latest.id);
    }
  } catch {
    // History is a convenience; the dashboard still works without it.
  }
}

function toggleAdvanced() {
  if (el.settingsDialog.open) {
    el.settingsDialog.close();
  } else {
    openAdvanced();
  }
}

function openAdvanced() {
  if (!el.settingsDialog.open) {
    el.settingsDialog.showModal();
  }

  el.advancedToggle.setAttribute('aria-expanded', 'true');

  // On the first visit the project is the one thing the user must choose.
  if (!currentTarget()) {
    (currentSource() === 'github' ? el.form.githubRepo : el.form.project).focus();
  }
}

function init() {
  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    startSweep({ dryRun: false });
  });
  el.previewBtn.addEventListener('click', () => startSweep({ dryRun: true }));
  el.cancelBtn.addEventListener('click', cancelSweep);
  el.interviewSubmit.addEventListener('click', submitAnswer);
  el.reloadProjects.addEventListener('click', () => loadProjects({ announce: true }));
  el.reloadBugs.addEventListener('click', () => loadBugs({ force: true }));
  el.toggleBugs.addEventListener('click', toggleAllIssues);
  el.bugPicker.addEventListener('change', (event) => {
    const input = event.target;

    if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') {
      return;
    }

    if (input.checked) {
      state.selectedIssues.add(input.value);
    } else {
      state.selectedIssues.delete(input.value);
    }

    updateBugCount();
    updatePlan();
  });
  el.form.project.addEventListener('change', () => loadBugs());
  el.form.project.addEventListener('input', scheduleBugLoad);
  el.form.githubRepo.addEventListener('change', () => loadBugs());
  el.form.githubRepo.addEventListener('input', scheduleBugLoad);
  el.form.gitlabProject.addEventListener('change', () => loadBugs());
  el.form.gitlabProject.addEventListener('input', scheduleBugLoad);
  el.form.source.addEventListener('change', () => {
    loadBugs({ force: true });
    updatePlan();
    queueSettingsSave();
  });
  el.checkJira.addEventListener('click', checkJira);
  el.checkGitHub.addEventListener('click', checkGitHub);
  el.checkGitLab.addEventListener('click', checkGitLab);
  el.forgetGitHub.addEventListener('click', forgetGitHub);
  el.forgetJira.addEventListener('click', forgetJira);
  el.advancedToggle.addEventListener('click', toggleAdvanced);
  el.settingsClose.addEventListener('click', () => el.settingsDialog.close());
  el.settingsDone.addEventListener('click', () => el.settingsDialog.close());
  el.settingsDialog.addEventListener('close', () => {
    el.advancedToggle.setAttribute('aria-expanded', 'false');
    queueSettingsSave();

    const target = currentTarget();

    // Closing settings after fixing credentials should make the queue usable
    // without requiring a manual reload. Never re-render the picker mid-run.
    if (target && !el.startBtn.disabled && (state.bugLoadError || state.loadedSource !== currentSource() || state.loadedTarget !== target)) {
      loadBugs({ force: true });
    }
  });
  el.settingsDialog.addEventListener('keydown', (event) => {
    // Enter in a settings field should commit the field, not start a sweep.
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') {
      event.preventDefault();
      event.target.blur();
    }
  });
  el.settingsDialog.addEventListener('change', () => {
    queueSettingsSave();
  });
  el.settingsDialog.addEventListener('click', (event) => {
    if (event.target === el.settingsDialog) {
      el.settingsDialog.close();
    }
  });
  el.copyLog.addEventListener('click', copyLog);
  el.form.prPreset.addEventListener('change', togglePrCustom);
  const rememberSweep = () => {
    rememberWorkflow('bugSweep', selectionFrom({
      modelPicker: el.sweepModelPicker,
      effort: el.sweepEffort,
      mr: null
    }));
    renderWorkflowDefaults();
  };

  wireModelPicker(el.sweepModelPicker, rememberSweep);
  el.sweepEffort.addEventListener('change', rememberSweep);
  el.claudeEnv?.addEventListener('change', saveClaudeEnv);
  el.claudeEnv?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-role="remove-env"]');

    if (!button) {
      return;
    }

    button.closest('.env-row')?.remove();
    saveClaudeEnv();
  });
  el.addClaudeEnv?.addEventListener('click', addClaudeEnvRow);
  el.refreshModels?.addEventListener('click', loadClaudeModels);
  el.form.jiraType?.addEventListener('change', () => {
    updateJiraTypeSettings();
    queueSettingsSave();
  });
  el.form.jiraAuth?.addEventListener('change', toggleJiraEmail);

  for (const item of $$('.nav-item')) {
    item.addEventListener('click', () => switchView(item.dataset.view));
  }

  for (const name of ['project', 'base', 'publish', 'prPreset']) {
    el.form[name].addEventListener('input', updatePlan);
    el.form[name].addEventListener('change', updatePlan);
  }

  loadConfig();
  loadLatestJob();

  for (const session of Object.values(sessionViews)) {
    session?.restore();
  }
}

init();
