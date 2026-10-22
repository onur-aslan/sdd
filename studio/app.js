const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const el = {
  repoInfo: $('#repo-info'),
  versionChip: $('#version-chip'),
  connection: $('#connection'),
  connectionText: $('#connection-text'),
  jiraInfo: $('#jira-info'),
  form: $('#sweep-form'),
  formError: $('#form-error'),
  startBtn: $('#start-btn'),
  cancelBtn: $('#cancel-btn'),
  previewBtn: $('#preview-btn'),
  reloadProjects: $('#reload-projects'),
  projectList: $('#project-list'),
  bugPicker: $('#bug-picker'),
  bugCount: $('#bug-count'),
  reloadBugs: $('#reload-bugs'),
  toggleBugs: $('#toggle-bugs'),
  planSummary: $('#plan-summary'),
  advancedToggle: $('#advanced-toggle'),
  advancedBody: $('#advanced-body'),
  agentPreset: $('#agent-preset'),
  agentCustomField: $('#agent-custom-field'),
  prPreset: $('#pr-preset'),
  prCustomField: $('#pr-custom-field'),
  checkJira: $('#check-jira'),
  forgetJira: $('#forget-jira'),
  jiraEmailField: $('#jira-email-field'),
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
  interviewSubmit: $('#interview-submit'),
  enhancementScope: $('#enhancement-scope'),
  featureScope: $('#feature-scope')
};

const state = {
  config: null,
  jobId: null,
  source: null,
  bugs: new Map(),
  total: 0,
  fixed: 0,
  currentQuestion: null,
  issueBugs: [],
  issueKeys: [],
  selectedIssues: new Set(),
  loadedProject: '',
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
      el.runMeta.textContent = `${event.branch} · tag ${event.tag} · ${event.date}`;
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
      el.runMeta.textContent = 'Publishing branch, tag, and pull request…';
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

function localDate() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function agentPresets() {
  return state.config?.agents ?? [];
}

function presetCommand(id) {
  return agentPresets().find((preset) => preset.id === id)?.command ?? '';
}

function inferAgentPreset(agentCmd) {
  if (!agentCmd) {
    return state.config?.defaults?.agentPreset || 'claude';
  }

  const match = agentPresets().find((preset) => preset.id !== 'custom' && preset.command === agentCmd);

  return match ? match.id : 'custom';
}

function toggleAgentCustom() {
  const custom = el.form.agentPreset.value === 'custom';

  el.agentCustomField.classList.toggle('hidden', !custom);
  updateSessionAgents();
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

function formRequest({ dryRun = false } = {}) {
  const data = new FormData(el.form);
  const text = (name) => (data.get(name) ?? '').toString().trim();
  const checked = (name) => data.get(name) === 'on';
  const agentPreset = text('agentPreset') || 'claude';
  const agentCmd = agentPreset === 'custom' ? text('agentCmd') : presetCommand(agentPreset);
  const prPreset = text('prPreset') || 'github';
  const prCommand = prPreset === 'custom' ? text('prCommand') : prPresetCommand(prPreset);
  const gitlabPush = prPreset === 'gitlab-push';
  const jiraAuth = text('jiraAuth');
  const project = text('project');
  // Only trust the selection when it belongs to the project currently in the form.
  const issues = state.loadedProject === project && !allIssuesSelected() ? selectedIssueKeys() : [];

  return {
    project,
    issues,
    base: text('base'),
    agentPreset,
    agentCmd,
    verifyCmd: state.config?.defaults?.verifyCommand ?? '',
    jiraUrl: text('jiraUrl'),
    // An email only matters for Basic auth; auto and bearer use the token alone.
    jiraEmail: jiraAuth === 'basic' ? text('jiraEmail') : '',
    jiraToken: text('jiraToken'),
    jiraAuth,
    jiraApiVersion: text('jiraApiVersion'),
    jiraCa: text('jiraCa'),
    jiraInsecure: checked('jiraInsecure'),
    prPreset,
    prCommand,
    gitlabPush,
    dryRun,
    resume: checked('resume'),
    retryFailed: checked('retryFailed'),
    worktree: checked('worktree'),
    fetchBase: checked('fetchBase'),
    push: checked('push'),
    pr: checked('pr')
  };
}

function jiraPayload(request = formRequest()) {
  return {
    jiraUrl: request.jiraUrl,
    jiraEmail: request.jiraEmail,
    jiraToken: request.jiraToken,
    jiraAuth: request.jiraAuth,
    jiraApiVersion: request.jiraApiVersion,
    jiraCa: request.jiraCa,
    jiraInsecure: request.jiraInsecure
  };
}

function allIssuesSelected() {
  return state.issueKeys.length > 0 && state.issueKeys.every((key) => state.selectedIssues.has(key));
}

function selectedIssueKeys() {
  return state.issueKeys.filter((key) => state.selectedIssues.has(key));
}

function updateBugCount() {
  const total = state.issueKeys.length;
  const selected = selectedIssueKeys().length;

  if (total === 0) {
    el.bugCount.textContent = !state.loadedProject
      ? 'pick a project'
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
    message.textContent = error || 'No open bugs in this project.';
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
  const project = el.form.project.value.trim();

  if (!force && project === state.loadedProject) {
    return;
  }

  const requestId = ++state.bugRequestId;

  state.loadedProject = project;
  state.issueBugs = [];
  state.issueKeys = [];
  state.selectedIssues.clear();

  if (!project) {
    renderBugPicker('Pick a project in Settings to load its bugs.');
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
    const result = await api('/api/jira/bugs', {
      method: 'POST',
      body: JSON.stringify({ ...jiraPayload(), project })
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
    const project = el.form.project.value.trim();

    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(project)) {
      loadBugs();
    }
  }, 400);
}

function updateScope() {
  if (!el.scopeMeta) {
    return;
  }

  const project = el.form.project.value.trim();
  const base = el.form.base.value.trim();
  const bits = [
    project ? `project ${project}` : 'no project',
    `base ${base || 'detected'}`,
    el.form.worktree.checked ? 'isolated worktree' : 'working tree'
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
  const project = el.form.project.value.trim();

  updateScope();

  if (!project) {
    setPlan([['scope', 'Pick a project in Settings.']]);
    return;
  }

  const defaults = state.config?.defaults ?? {};
  const date = localDate();
  const branch = defaults.branch || `bug-fix/${date}`;
  const tag = defaults.tag || `bug-fix-${date}`;
  const verify = defaults.verifyCommand || '';
  const push = el.form.push.checked;
  const pr = el.form.pr.checked;
  const loaded = state.loadedProject === project;
  const total = loaded ? state.issueKeys.length : 0;
  const selected = loaded ? selectedIssueKeys().length : 0;
  let scope = `all open ${project} bugs`;

  if (total > 0) {
    scope = selected === total
      ? `all ${total} ${project} bug${total === 1 ? '' : 's'}`
      : `${selected} of ${total} ${project} bugs`;
  }

  const base = el.form.base.value.trim() || defaults.base || 'detected';
  const baseBits = [base];

  if (el.form.fetchBase.checked) {
    baseBits.push('fetch first');
  }
  if (el.form.worktree.checked) {
    baseBits.push('isolated worktree');
  }

  let publish = 'no push';

  if (push && pr) {
    const prPreset = el.form.prPreset?.value || 'github';

    if (prPreset === 'gitlab-push') {
      publish = 'push + merge request (git push options)';
    } else if (prPreset === 'custom') {
      publish = 'push + merge request (custom command)';
    } else {
      const forge = prPresets().find((preset) => preset.id === prPreset);

      publish = prPreset === 'github'
        ? 'push + pull request'
        : `push + merge request (${forge?.label || prPreset})`;
    }
  } else if (push) {
    publish = 'push branch only';
  }

  setPlan([
    ['scope', scope],
    ['branch', `${branch}  ·  tag ${tag}`],
    ['base', baseBits.join('  ·  ')],
    ['verify', verify || 'not detected'],
    ['publish', publish]
  ]);
}

async function loadProjects({ announce = false } = {}) {
  const request = formRequest();

  try {
    const { projects, error } = await api('/api/jira/projects', {
      method: 'POST',
      body: JSON.stringify(jiraPayload(request))
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

function toggleJiraEmail() {
  el.jiraEmailField.classList.toggle('hidden', el.form.jiraAuth.value !== 'basic');
}

async function checkJira() {
  el.jiraCheckResult.textContent = 'checking…';

  try {
    const result = await api('/api/jira/health', {
      method: 'POST',
      body: JSON.stringify(jiraPayload())
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

async function forgetJira() {
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        jiraUrl: '',
        jiraEmail: '',
        jiraToken: '',
        jiraCa: '',
        jiraAuth: '',
        jiraApiVersion: '',
        jiraInsecure: false
      })
    });

    for (const name of ['jiraUrl', 'jiraEmail', 'jiraToken', 'jiraCa']) {
      el.form[name].value = '';
    }
    el.form.jiraAuth.value = '';
    el.form.jiraApiVersion.value = '';
    el.form.jiraInsecure.checked = false;
    el.form.jiraToken.placeholder = '••••••••';
    toggleJiraEmail();
    state.loadedProject = '';
    state.issueBugs = [];
    state.issueKeys = [];
    state.selectedIssues.clear();
    renderBugPicker('Pick a project in Settings to load its bugs.');
    updatePlan();
    el.jiraInfo.textContent = 'Jira: not configured';
    el.jiraCheckResult.textContent = 'Saved Jira settings cleared.';
  } catch (error) {
    el.jiraCheckResult.textContent = error.message;
  }
}

let settingsSaveTimer = null;

function settingsPayload() {
  const request = formRequest({ dryRun: true });
  const payload = {
    project: request.project,
    base: request.base,
    agentPreset: request.agentPreset,
    agentCmd: request.agentCmd,
    push: request.push,
    pr: request.pr,
    retryFailed: request.retryFailed,
    worktree: request.worktree,
    fetchBase: request.fetchBase,
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
    const result = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify(settingsPayload())
    });

    el.settingsStatus.textContent = 'Saved';
    window.setTimeout(() => {
      if (el.settingsStatus.textContent === 'Saved') {
        el.settingsStatus.textContent = '';
      }
    }, 1600);

    const saved = result.settings ?? {};

    if (saved.jiraUrl) {
      const bits = [saved.jiraUrl, saved.jiraAuth ? `auth ${saved.jiraAuth}` : 'auth auto'];

      if (result.hasSavedToken) {
        bits.push('token saved');
      }

      el.jiraInfo.textContent = `Jira: ${bits.join(' · ')}`;
    } else {
      el.jiraInfo.textContent = 'Jira: not configured';
    }
  } catch {
    el.settingsStatus.textContent = 'Not saved';
  }
}

async function startSweep({ dryRun = false } = {}) {
  el.formError.classList.add('hidden');

  const request = formRequest({ dryRun });

  if (!request.project) {
    el.formError.textContent = 'Pick a Jira project in Settings first.';
    el.formError.classList.remove('hidden');
    return;
  }

  if (state.loadedProject === request.project && state.issueKeys.length > 0 && state.selectedIssues.size === 0) {
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
    finalLabel: 'plan',
    scope: 'planning only',
    placeholder: 'Describe the enhancement…',
    restartPlaceholder: 'Start another enhancement…',
    emptyTitle: 'Interview the agent.',
    emptyBody: 'Describe the enhancement below. The agent asks one question at a time, then drafts a plan. Nothing is changed in this step.'
  },
  feature: {
    endpoint: '/api/features',
    finalLabel: 'spec',
    scope: 'spec only',
    placeholder: 'Describe the feature…',
    restartPlaceholder: 'Start another feature…',
    emptyTitle: 'Interview the agent.',
    emptyBody: 'Describe the feature below. The agent runs the design interview one question at a time, then writes the spec to docs/sdd/features. Nothing else is written in this step.'
  }
};

function escapeText(value) {
  return window.SDDMarkdown ? window.SDDMarkdown.escapeHtml(value) : String(value ?? '');
}

function createSession(flow) {
  const root = document.querySelector(`[data-session-flow="${flow}"]`);

  if (!root) {
    return null;
  }

  const copy = SESSION_COPY[flow];
  const scopeEl = flow === 'feature' ? el.featureScope : el.enhancementScope;

  root.innerHTML = `
    <section class="session" aria-label="${copy.finalLabel} session">
      <header class="session-bar">
        <div class="session-id">
          <span class="badge" data-role="badge">ready</span>
          <span class="session-agent" data-role="agent"></span>
        </div>
        <div class="session-tools">
          <div class="segmented" role="group" aria-label="Session view">
            <button type="button" class="seg-btn" data-role="rich" aria-pressed="true">Rich</button>
            <button type="button" class="seg-btn" data-role="raw" aria-pressed="false">Raw</button>
          </div>
          <button type="button" class="btn quiet sm" data-role="copy">Copy</button>
          <button type="button" class="btn quiet sm" data-role="finish" title="End the session when the reply is the final ${copy.finalLabel}" disabled>Finish</button>
          <button type="button" class="btn quiet-danger sm" data-role="stop" disabled>Stop</button>
        </div>
      </header>

      <div class="session-stage" data-role="stage" role="log" aria-live="off" aria-label="Session transcript" tabindex="0">
        <div class="session-empty" data-role="empty">
          <p class="session-empty-title" data-role="empty-title">${copy.emptyTitle}</p>
          <p data-role="empty-body">${copy.emptyBody}</p>
        </div>
        <article class="session-rich hidden" data-role="rich-view"></article>
        <pre class="session-raw hidden" data-role="raw-view"></pre>
      </div>

      <form class="session-input" data-role="input-form">
        <textarea data-role="input" rows="1" spellcheck="false" aria-label="Your answer" placeholder="${copy.placeholder}"></textarea>
        <button type="submit" class="session-send" data-role="send" aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7"/></svg>
        </button>
      </form>
    </section>
  `;

  const q = (role) => root.querySelector(`[data-role="${role}"]`);
  const dom = {
    badge: q('badge'),
    agent: q('agent'),
    richBtn: q('rich'),
    rawBtn: q('raw'),
    copy: q('copy'),
    finish: q('finish'),
    stop: q('stop'),
    stage: q('stage'),
    empty: q('empty'),
    richView: q('rich-view'),
    rawView: q('raw-view'),
    inputForm: q('input-form'),
    input: q('input'),
    send: q('send')
  };
  const view = {
    jobId: null,
    source: null,
    entries: [],
    active: null,
    awaiting: false,
    running: false,
    finished: false,
    seq: 0,
    mode: 'rich',
    renderTimer: null
  };

  function setStatus(text, live) {
    dom.badge.textContent = text;
    dom.badge.classList.toggle('running', Boolean(live));
  }

  function setScope(text) {
    if (scopeEl) {
      scopeEl.textContent = text;
    }
  }

  function setInputEnabled(enabled, placeholder) {
    dom.input.disabled = !enabled;
    dom.send.disabled = !enabled;
    dom.input.placeholder = placeholder ?? (view.jobId ? 'Waiting for the agent…' : copy.placeholder);

    if (enabled) {
      dom.input.focus();
    }
  }

  function updateAgent() {
    const preset = agentPresets().find((agent) => agent.id === el.form.agentPreset.value);

    dom.agent.textContent = preset?.label ?? 'Custom agent';
  }

  function rawText() {
    return view.entries
      .map((entry) => `${entry.role === 'agent' ? 'agent' : entry.role} \u203a\n${entry.text}`)
      .join('\n\n');
  }

  function renderEntry(entry, index) {
    if (entry.role === 'agent') {
      // An empty turn is the agent thinking, not something to read: keep it only
      // while it is the live tail (where the thinking dots sit).
      if (!entry.text.trim() && index < view.entries.length - 1) {
        return '';
      }

      const body = window.SDDMarkdown ? window.SDDMarkdown.render(entry.text) : `<p>${escapeText(entry.text)}</p>`;

      return `<article class="turn turn-agent" role="group" aria-label="Agent"><div class="turn-body">${body}</div></article>`;
    }

    if (entry.role === 'you') {
      return `<article class="turn turn-you" role="group" aria-label="You"><p class="turn-who">You</p><div class="turn-body"><p>${escapeText(entry.text)}</p></div></article>`;
    }

    if (entry.role === 'permission') {
      const decided = Boolean(entry.state) && entry.state !== 'pending';
      const disabled = entry.busy ? ' disabled' : '';
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

    return `<article class="turn turn-session" role="status"><p>${escapeText(entry.text)}</p></article>`;
  }

  // The transcript is a record; only the finished session's last turn is
  // stamped as the artifact.
  function decorate() {
    const agentTurns = dom.richView.querySelectorAll('.turn-agent');
    const lastAgent = agentTurns[agentTurns.length - 1];

    if (!lastAgent || view.entries[view.entries.length - 1]?.role !== 'agent') {
      return;
    }

    if (view.finished) {
      lastAgent.dataset.stamp = copy.finalLabel;
    }

    if (view.running) {
      const thinking = document.createElement('span');

      thinking.className = 'session-thinking';
      thinking.setAttribute('aria-hidden', 'true');
      thinking.innerHTML = '<i></i><i></i><i></i>';
      lastAgent.append(thinking);
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
      dom.richView.innerHTML = view.entries.map(renderEntry).join('');
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
    view.renderTimer = window.setTimeout(render, 160);
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
      case 'session-started':
        addEntry('you', event.brief ?? '');
        setStatus(event.engine === 'live' ? 'interviewing · live' : 'interviewing', true);
        break;
      case 'turn-started':
        view.active = { role: 'agent', text: '' };
        view.entries.push(view.active);
        setStatus('writing', true);
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
      case 'activity':
        setStatus(event.label || 'working…', true);
        break;
      case 'question':
        view.awaiting = true;
        view.active = null;
        setStatus('needs your answer', false);
        setInputEnabled(true, 'Type your answer…');
        dom.finish.disabled = false;
        announceStatus('The agent asked a question.');
        scheduleRender();
        break;
      case 'answer':
        view.awaiting = false;
        dom.finish.disabled = true;
        addEntry('you', event.text ?? '');
        setInputEnabled(false);
        break;
      case 'permission':
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

        if (pending) {
          pending.busy = false;
          pending.state = event.reason === 'expired'
            ? 'Expired'
            : event.behavior === 'allow'
              ? 'Allowed once'
              : 'Denied';
        }

        if (view.running) {
          setStatus('writing', true);
        }

        scheduleRender();
        break;
      }
      case 'job-done':
        finishSession('done', '', event.summary?.output);
        break;
      case 'job-failed':
        finishSession('failed', event.message);
        break;
      case 'job-cancelled':
        finishSession('cancelled', 'Stopped.');
        break;
      default:
        break;
    }
  }

  function finishSession(kind, message = '', output = '') {
    view.running = false;
    view.awaiting = false;
    view.finished = kind === 'done';
    // The finished session keeps its transcript, but the input now starts a new
    // one instead of trying to talk to a process that is already gone.
    view.jobId = null;
    dom.stop.disabled = true;
    dom.finish.disabled = true;

    // A feature session ends with the spec file as the preview, not the agent's
    // one-line "spec written" confirmation.
    if (typeof output === 'string' && output.trim()) {
      const lastAgent = [...view.entries].reverse().find((entry) => entry.role === 'agent');

      if (lastAgent) {
        lastAgent.text = output;
        view.active = null;
      }
    }

    setInputEnabled(true, copy.restartPlaceholder);
    setStatus(kind === 'done' ? `${copy.finalLabel} ready` : kind === 'cancelled' ? 'stopped' : 'failed', false);
    setScope(kind === 'done' ? `${copy.finalLabel} ready` : kind === 'cancelled' ? 'stopped' : 'session failed');

    if (message) {
      addEntry('session', message);
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
        : kind === 'cancelled'
          ? 'Session stopped.'
          : 'Session failed.'
    );
  }

  function attach(jobId) {
    if (view.source) {
      view.source.close();
    }

    view.jobId = jobId;
    view.running = true;
    view.seq = 0;
    dom.stop.disabled = false;
    setStatus('connecting', true);

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

  function resetSession() {
    if (view.source) {
      view.source.close();
    }

    window.clearTimeout(view.renderTimer);
    view.jobId = null;
    view.source = null;
    view.entries = [];
    view.active = null;
    view.awaiting = false;
    view.running = false;
    view.finished = false;
    view.seq = 0;
    dom.richView.innerHTML = '';
    dom.rawView.textContent = '';
    dom.richView.classList.add('hidden');
    dom.rawView.classList.add('hidden');
    dom.empty.classList.remove('hidden');
    dom.stop.disabled = true;
    dom.finish.disabled = true;
    dom.input.value = '';
    setInputEnabled(true, copy.placeholder);
    setStatus('ready', false);
    setScope(copy.scope);
    autoGrow();
  }

  async function start(brief) {
    const agentPreset = el.form.agentPreset.value;
    const agentCmd = agentPreset === 'custom'
      ? el.form.agentCmd.value.trim()
      : presetCommand(agentPreset);

    if (agentPreset === 'custom' && !agentCmd) {
      addEntry('session', 'Add an agent command in Settings, or pick a preset.');
      return;
    }

    resetSession();
    view.running = true;
    dom.stop.disabled = false;
    setInputEnabled(false);
    setStatus('starting', true);
    setScope('session running');
    render();

    try {
      const { job } = await api(copy.endpoint, {
        method: 'POST',
        body: JSON.stringify({ brief, agentPreset, agentCmd })
      });

      attach(job.id);
      announceStatus('Session started.');
    } catch (error) {
      view.running = false;
      dom.stop.disabled = true;
      setStatus('failed', false);
      setScope('session failed');
      addEntry('session', error.message);
      setInputEnabled(true, copy.placeholder);
      render();
    }
  }

  async function answer(text) {
    if (!view.jobId || !view.awaiting) {
      return;
    }

    view.awaiting = false;
    dom.finish.disabled = true;
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
      dom.finish.disabled = false;
      addEntry('session', `Could not send the answer: ${error.message}`);
      setInputEnabled(true, 'Type your answer…');
      render();
    }
  }

  // The human closes the interview: the agent's last reply is the plan or spec
  // and there is nothing left to answer. No text is inspected to decide this.
  async function finish() {
    if (!view.jobId || !view.awaiting) {
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
      setInputEnabled(true, 'Type your answer…');
      render();
    }
  }

  async function stop() {
    if (!view.jobId) {
      return;
    }

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

  async function restore() {
    try {
      const { jobs } = await api(copy.endpoint);

      if (!jobs || jobs.length === 0) {
        resetSession();
        return;
      }

      const job = [...jobs].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);

      resetSession();

      if (['running', 'waiting', 'cancelling'].includes(job.status)) {
        attach(job.id);
        return;
      }

      for (const event of job.events ?? []) {
        onEvent(event);
      }

      view.running = false;
    } catch {
      // History is a convenience; the studio still works without it.
    }
  }

  function autoGrow() {
    dom.input.style.height = 'auto';
    dom.input.style.height = `${Math.min(dom.input.scrollHeight, 200)}px`;
  }

  dom.inputForm.addEventListener('submit', (event) => {
    event.preventDefault();

    const text = dom.input.value.trim();

    if (!text) {
      return;
    }

    dom.input.value = '';
    autoGrow();

    if (!view.jobId) {
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
  dom.finish.addEventListener('click', finish);
  // Approval is a security decision, not an interview answer: it keeps its own
  // explicit control instead of flowing through the composer.
  dom.richView.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-permission]');

    if (!button || !view.jobId) {
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
      // The request expired before the click reached the agent.
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

  return { reset: resetSession, restore, updateAgent, view };
}

const sessionViews = {
  enhancement: createSession('enhancement'),
  feature: createSession('feature')
};

function updateSessionAgents() {
  for (const session of Object.values(sessionViews)) {
    session?.updateAgent();
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

    if (jira.url) {
      const bits = [jira.url, jira.auth === 'auto' || !jira.auth ? 'auth auto' : `auth ${jira.auth}`];

      if (jira.apiVersion && jira.apiVersion !== 'auto') {
        bits.push(`REST v${jira.apiVersion}`);
      }
      if (!jira.hasToken) {
        bits.push('no token');
      }
      if (jira.hasCa) {
        bits.push('internal CA');
      }
      if (jira.insecure) {
        bits.push('insecure TLS');
      }

      el.jiraInfo.textContent = `Jira: ${bits.join(' · ')}`;
    } else {
      el.jiraInfo.textContent = 'Jira: not configured';
    }

    // Remembered choices win; detected defaults fill the gaps.
    setFormValue('project', settings.project);
    setFormValue('base', settings.base);
    setFormValue('jiraAuth', settings.jiraAuth);
    setFormValue('jiraApiVersion', settings.jiraApiVersion);
    setFormValue('jiraCa', settings.jiraCa);
    setFormValue('prCommand', settings.prCommand);
    setFormValue('jiraUrl', settings.jiraUrl || jira.url);
    setFormValue('jiraEmail', settings.jiraEmail || jira.email);
    toggleJiraEmail();

    el.form.jiraInsecure.checked = settings.jiraInsecure === true || jira.insecure === true;
    el.form.jiraToken.value = '';
    el.form.jiraToken.placeholder = jira.hasSavedToken
      ? '•••••••• (saved locally)'
      : jira.hasToken
        ? '•••••••• (from environment)'
        : '••••••••';

    el.form.agentPreset.innerHTML = '';
    for (const agent of agentPresets()) {
      const option = document.createElement('option');
      option.value = agent.id;
      option.textContent = agent.label;
      el.form.agentPreset.append(option);
    }

    const savedAgent = settings.agentPreset || inferAgentPreset(settings.agentCmd);

    el.form.agentPreset.value = agentPresets().some((agent) => agent.id === savedAgent)
      ? savedAgent
      : (defaults.agentPreset || 'claude');
    setFormValue('agentCmd', settings.agentCmd);
    toggleAgentCustom();

    el.form.agentCmd.placeholder = defaults.agentCmd || '';
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

    el.form.push.checked = settings.push !== false;
    el.form.pr.checked = settings.pr !== false;
    el.form.retryFailed.checked = settings.retryFailed === true;
    el.form.worktree.checked = settings.worktree !== false;
    el.form.fetchBase.checked = settings.fetchBase !== false;

    updatePlan();
    setConnection('live', 'connected');
    // With no remembered project there is nothing to start; open Settings on the
    // first visit so the project is the first thing in reach, then stay out of
    // the way on later reloads.
    if (!el.form.project.value.trim() && settings.settingsSeen !== true) {
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
  if (!el.form.project.value.trim()) {
    el.form.project.focus();
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
  el.checkJira.addEventListener('click', checkJira);
  el.forgetJira.addEventListener('click', forgetJira);
  el.advancedToggle.addEventListener('click', toggleAdvanced);
  el.settingsClose.addEventListener('click', () => el.settingsDialog.close());
  el.settingsDone.addEventListener('click', () => el.settingsDialog.close());
  el.settingsDialog.addEventListener('close', () => {
    el.advancedToggle.setAttribute('aria-expanded', 'false');
    queueSettingsSave();

    const project = el.form.project.value.trim();

    // Closing settings after fixing credentials should make the queue usable
    // without requiring a manual reload. Never re-render the picker mid-run.
    if (project && !el.startBtn.disabled && (state.bugLoadError || state.loadedProject !== project)) {
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
  el.form.agentPreset.addEventListener('change', toggleAgentCustom);
  el.form.prPreset.addEventListener('change', togglePrCustom);
  el.form.jiraAuth.addEventListener('change', toggleJiraEmail);

  for (const item of $$('.nav-item')) {
    item.addEventListener('click', () => switchView(item.dataset.view));
  }

  for (const name of ['project', 'base', 'worktree', 'fetchBase', 'push', 'pr']) {
    el.form[name].addEventListener('input', updatePlan);
    el.form[name].addEventListener('change', updatePlan);
  }

  // A merge request needs a pushed branch; keep the two decisions consistent.
  el.form.push.addEventListener('change', () => {
    if (!el.form.push.checked) {
      el.form.pr.checked = false;
    }
    updatePlan();
  });
  el.form.pr.addEventListener('change', () => {
    if (el.form.pr.checked) {
      el.form.push.checked = true;
    }
    updatePlan();
  });

  loadConfig();
  loadLatestJob();
  updateSessionAgents();

  for (const session of Object.values(sessionViews)) {
    session?.restore();
  }
}

init();
