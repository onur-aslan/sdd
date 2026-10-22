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
  featureScope: $('#feature-scope'),
  mergeScope: $('#merge-scope')
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
    finalLabel: 'report',
    scope: 'plan → implement → verify',
    placeholder: 'Describe the enhancement…',
    restartPlaceholder: 'Start another enhancement…',
    answerPlaceholder: 'Type your answer, or approve the plan…',
    emptyTitle: 'Interview the agent.',
    emptyBody: 'Describe the enhancement below or start from a Jira issue. The agent asks one question at a time, drafts a plan, and after you approve it implements and verifies the change. When the report is ready the studio commits the change on its own branch and opens a merge request.'
  },
  feature: {
    endpoint: '/api/features',
    finalLabel: 'spec',
    scope: 'spec → build',
    placeholder: 'Describe the feature…',
    restartPlaceholder: 'Start another feature…',
    answerPlaceholder: 'Type your answer…',
    emptyTitle: 'Interview the agent.',
    emptyBody: 'Describe the feature below or start from a Jira issue. The agent runs the design interview one question at a time, then writes the spec to docs/sdd/features. When the spec is ready you choose how to build it; the build commits to the session branch and opens a merge request.'
  },
  merge: {
    endpoint: '/api/merges',
    finalLabel: 'merge report',
    scope: 'review → integrate',
    placeholder: 'Pick a source and target above…',
    restartPlaceholder: 'Start another merge…',
    answerPlaceholder: 'Type your answer, or approve the resolution table…',
    emptyTitle: 'Merge two branches.',
    emptyBody: 'Choose a source branch and a target. The agent dry-runs the merge, asks one decision at a time, and builds an integration branch. The target is not touched until you land it.'
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
  const scopeEl = {
    enhancement: el.enhancementScope,
    feature: el.featureScope,
    merge: el.mergeScope
  }[flow];
  // A merge ends when its integration branch exists, so it has no hand-finish.
  const canFinish = flow !== 'merge';

  root.innerHTML = `
    <section class="session" aria-label="${copy.finalLabel} session">
      <header class="session-bar">
        <div class="session-id">
          <span class="badge" data-role="badge">ready</span>
          <span class="session-agent" data-role="agent"></span>
        </div>
        <div class="session-tools">
          <div class="segmented" role="group" aria-label="Conversation view">
            <button type="button" class="seg-btn" data-role="rich" aria-pressed="true">Rich</button>
            <button type="button" class="seg-btn" data-role="raw" aria-pressed="false">Raw</button>
          </div>
          <button type="button" class="btn quiet sm" data-role="copy">Copy</button>
          ${canFinish ? `<button type="button" class="btn quiet sm" data-role="finish" title="End the session when the reply is the final ${copy.finalLabel}" disabled>Finish</button>` : ''}
          <button type="button" class="btn quiet-danger sm" data-role="stop" disabled>Stop</button>
        </div>
      </header>

      <div class="session-stage" data-role="stage" role="log" aria-live="off" aria-label="Conversation" tabindex="0">
        <div class="session-empty" data-role="empty">
          <p class="session-empty-title" data-role="empty-title">${copy.emptyTitle}</p>
          <p data-role="empty-body">${copy.emptyBody}</p>
          ${flow === 'merge' ? '' : `
            <div class="session-import">
              <div class="session-import-row">
                <label class="session-import-label" for="jira-${flow}">Start from Jira</label>
                <select id="jira-${flow}" data-role="jira-select" disabled>
                  <option value="">Load open issues…</option>
                </select>
                <button type="button" class="btn quiet sm" data-role="jira-load">Load issues</button>
              </div>
              <p class="session-import-status" data-role="jira-status" role="status"></p>
              <label class="toggle session-publish">
                <input type="checkbox" data-role="publish" checked>
                <span>Create a branch, commit, and open a merge request</span>
              </label>
            </div>
          `}
        </div>
        <article class="session-rich hidden" data-role="rich-view"></article>
        <pre class="session-raw hidden" data-role="raw-view"></pre>
      </div>

      <div class="handoff hidden" data-role="handoff"></div>

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
    jiraSelect: q('jira-select'),
    jiraLoad: q('jira-load'),
    jiraStatus: q('jira-status'),
    publish: q('publish'),
    richView: q('rich-view'),
    rawView: q('raw-view'),
    handoff: q('handoff'),
    inputForm: q('input-form'),
    input: q('input'),
    send: q('send')
  };
  const view = {
    jobId: null,
    sessionId: null,
    source: null,
    entries: [],
    active: null,
    awaiting: false,
    running: false,
    finished: false,
    seq: 0,
    mode: 'rich',
    renderTimer: null,
    statusTimer: null,
    turnStartedAt: 0,
    turnLabel: 'writing',
    build: null,
    buildSource: null,
    buildTimer: null,
    buildPainted: false,
    // Merge only: the source/target/ref from the job request, and whether the
    // setup plate (rather than the transcript) is the current surface.
    mergeMeta: null,
    setup: false
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

  // The merge tab starts from a setup plate, not a free-text brief, so its
  // composer is only visible while the interview is actually running.
  function setComposerVisible(visible) {
    dom.inputForm.classList.toggle('hidden', !visible);
  }

  function selectedAgent() {
    const agentPreset = el.form.agentPreset.value;
    const agentCmd = agentPreset === 'custom'
      ? el.form.agentCmd.value.trim()
      : presetCommand(agentPreset);

    return { agentPreset, agentCmd };
  }

  function updateAgent() {
    const preset = agentPresets().find((agent) => agent.id === el.form.agentPreset.value);

    dom.agent.textContent = preset?.label ?? 'Custom agent';
    // The badge names the agent; the title says what will actually run, so the
    // session is traceable to the configured command.
    dom.agent.title = preset?.command || 'Custom command from Settings';
  }

  function syncPublish() {
    if (!dom.publish) {
      return;
    }

    const settings = state.config?.settings ?? {};
    const label = dom.publish.closest('label')?.querySelector('span');

    if (!label) {
      return;
    }

    label.textContent = settings.push === false
      ? 'Create a branch and commit (push is off in Settings)'
      : settings.pr === false
        ? 'Create a branch and push (merge request is off in Settings)'
        : 'Create a branch, commit, and open a merge request';
  }

  function issueBrief(issue) {
    return [
      `${issue.key}: ${issue.summary}`.trim(),
      issue.description?.trim() ?? '',
      issue.url ?? ''
    ].filter(Boolean).join('\n\n');
  }

  async function loadJiraIssues() {
    if (!dom.jiraLoad || !dom.jiraSelect) {
      return;
    }

    dom.jiraLoad.disabled = true;
    dom.jiraSelect.disabled = true;
    dom.jiraStatus.textContent = 'Loading open issues…';

    try {
      const result = await api('/api/jira/issues', {
        method: 'POST',
        body: JSON.stringify({})
      });

      if (!result.configured) {
        dom.jiraStatus.textContent = 'Jira is not configured. Add the URL and token in Settings.';
        return;
      }

      if (result.error) {
        dom.jiraStatus.textContent = result.error;
        return;
      }

      const issues = result.issues ?? [];

      dom.jiraSelect.replaceChildren(new Option('Choose an issue…', ''));

      for (const issue of issues) {
        dom.jiraSelect.append(new Option(`${issue.key} — ${issue.summary}`, issue.key));
      }

      dom.jiraSelect.disabled = issues.length === 0;
      dom.jiraStatus.textContent = issues.length === 0
        ? 'No open issues in the project.'
        : `${issues.length} open issue${issues.length === 1 ? '' : 's'}. Pick one to import.`;
    } catch (error) {
      dom.jiraStatus.textContent = error.message;
    } finally {
      dom.jiraLoad.disabled = false;
    }
  }

  async function importJiraIssue() {
    const key = dom.jiraSelect?.value;

    if (!key) {
      return;
    }

    dom.jiraSelect.disabled = true;
    dom.jiraLoad.disabled = true;
    dom.jiraStatus.textContent = `Loading ${key}…`;

    try {
      const result = await api('/api/jira/issue', {
        method: 'POST',
        body: JSON.stringify({ key })
      });

      if (!result.configured) {
        dom.jiraStatus.textContent = 'Jira is not configured. Add the URL and token in Settings.';
        return;
      }

      if (result.error || !result.issue) {
        dom.jiraStatus.textContent = result.error || `Jira issue ${key} was not found.`;
        return;
      }

      dom.input.value = issueBrief(result.issue);
      autoGrow();
      dom.input.focus();
      dom.jiraStatus.textContent = `Imported ${result.issue.key}. Edit it below and press Send.`;
    } catch (error) {
      dom.jiraStatus.textContent = error.message;
    } finally {
      dom.jiraSelect.disabled = false;
      dom.jiraLoad.disabled = false;
    }
  }

  // The dots mean "the agent is working"; the seconds next to them say how long
  // this turn has been open, so a stalled provider looks stalled, not frozen.
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

  function rawText() {
    return view.entries
      .filter((entry) => entry.role === 'agent')
      .map((entry) => renderTerminalText(entry.text))
      .join('');
  }

  function renderTerminalText(value) {
    return String(value ?? '')
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '');
  }

  function renderEntry(entry, index) {
    if (entry.role === 'agent') {
      // An empty turn is the agent thinking, not something to read: keep it only
      // while it is the live tail (where the thinking dots sit).
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

    if (entry.role === 'publish') {
      const link = entry.url
        ? ` <a href="${escapeText(entry.url)}" target="_blank" rel="noreferrer">Open merge request</a>`
        : '';

      return `<article class="turn turn-publish" role="status">
        <p class="turn-who">Git</p>
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
      case 'abandoned':
        return event.reason || `Branch ${event.branch} was left in place.`;
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
      case 'session-started':
        view.setup = false;
        view.running = true;
        dom.stage.classList.remove('hidden');
        if (flow === 'merge') {
          setComposerVisible(true);
        }
        addEntry('you', event.brief ?? '');
        setStatus(event.engine === 'live' ? 'interviewing · live' : 'interviewing', true);
        break;
      case 'turn-started':
        view.active = { role: 'agent', text: '' };
        view.entries.push(view.active);
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
      case 'activity':
        // Focused chat view keeps tool names and paths out of the transcript
        // and status line; only show that the agent is still working.
        setTurnLabel('working');
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

        // A merge-guard decision is recorded as its own line; it never owns a
        // permission plate, so it must not close an earlier pending one.
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
          addEntry('publish', text, {
            url: event.status === 'published' ? event.prUrl : ''
          });
        }

        if (event.status === 'published' && event.prUrl) {
          announceStatus('The merge request is ready.');
        }
        break;
      }
      case 'job-done':
        if (flow === 'merge' && event.summary?.ref) {
          view.mergeMeta = { ...(view.mergeMeta ?? {}), ref: event.summary.ref };
        }
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
    stopTurnClock();
    view.running = false;
    view.awaiting = false;
    view.finished = kind === 'done';
    // The finished session keeps its transcript, but the input now starts a new
    // one instead of trying to talk to a process that is already gone.
    view.jobId = null;
    view.setup = false;
    dom.stop.disabled = true;
    dom.stage.classList.remove('hidden');
    if (dom.finish) {
      dom.finish.disabled = true;
    }

    // A feature session ends with the spec file as the preview, not the agent's
    // one-line "spec written" confirmation.
    if (typeof output === 'string' && output.trim()) {
      const lastAgent = [...view.entries].reverse().find((entry) => entry.role === 'agent');

      if (lastAgent) {
        lastAgent.text = output;
        view.active = null;
      }
    }

    const readyLabel = flow === 'merge' ? 'integration branch ready' : `${copy.finalLabel} ready`;

    if (flow === 'merge') {
      // The next step is a landing decision, not another composer prompt.
      setInputEnabled(false);
      setComposerVisible(false);
    } else {
      setInputEnabled(true, copy.restartPlaceholder);
    }

    setStatus(kind === 'done' ? readyLabel : kind === 'cancelled' ? 'stopped' : 'failed', false);
    setScope(kind === 'done' ? readyLabel : kind === 'cancelled' ? 'stopped' : 'session failed');

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

    // A feature session hands over to the build decision instead of ending at
    // the transcript: the workflow continues with an implementation skill.
    if (view.finished && flow === 'feature') {
      showHandoff();
    }

    // A merge hands over to the landing decision, one branch at a time.
    if (flow === 'merge') {
      if (kind === 'done' && view.mergeMeta?.ref) {
        showMergeLanding();
      } else {
        showMergeRetry(
          kind === 'failed'
            ? message
            : kind === 'cancelled'
              ? 'The merge was stopped before the integration branch was created.'
              : 'The session ended without an integration branch.'
        );
      }
    }
  }

  const PIPELINE_COPY = {
    direct: {
      label: 'Direct implementation',
      skill: 'sdd-developer',
      body: 'One agent run: implement the spec, review and fix, verify each story.'
    },
    tdd: {
      label: 'Task-by-task TDD',
      skill: 'spec-to-task → feature-tdd',
      body: 'Split the spec into tasks first, then implement each task with Chicago TDD.'
    }
  };

  function showHandoff() {
    if (flow !== 'feature' || !view.sessionId) {
      return;
    }

    dom.handoff.innerHTML = `
      <section class="handoff-card" aria-labelledby="handoff-title">
        <p class="handoff-eyebrow">Spec ready</p>
        <h2 id="handoff-title">How should the agent build it?</h2>
        <p class="handoff-lede">The workflow continues after the spec. Pick a path and the studio runs
          those skills in order, in this checkout, and stops before commit.</p>

        <div class="pipeline-list" role="radiogroup" aria-label="Implementation path">
          ${Object.entries(PIPELINE_COPY).map(([id, item], index) => `
            <label class="pipeline">
              <input type="radio" name="pipeline" value="${id}" ${index === 0 ? 'checked' : ''}>
              <span class="pipeline-body">
                <span class="pipeline-name">${item.label}</span>
                <span class="pipeline-skill">${item.skill}</span>
                <span class="pipeline-note">${item.body}</span>
              </span>
            </label>
          `).join('')}
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

  function hideHandoff() {
    dom.handoff.classList.add('hidden');
    dom.handoff.innerHTML = '';
  }

  // ---------------------------------------------------------------
  // Merge setup and landing
  // ---------------------------------------------------------------

  function wireNewMerge(button) {
    button?.addEventListener('click', async () => {
      resetSession();
      await loadConfig();
    });
  }

  function renderMergeSetup(error = '') {
    if (flow !== 'merge' || view.running) {
      return;
    }

    view.setup = true;
    view.setupError = error;
    view.finished = false;
    dom.stage.classList.add('hidden');
    setComposerVisible(false);
    setInputEnabled(false);
    dom.stop.disabled = true;
    if (dom.finish) {
      dom.finish.disabled = true;
    }
    setStatus('ready', false);
    setScope(copy.scope);

    const git = state.config?.git;

    if (!state.config) {
      dom.handoff.innerHTML = `
        <section class="handoff-card merge-setup">
          <p class="handoff-eyebrow">Merge</p>
          <h2>Loading workspace…</h2>
        </section>
      `;
      dom.handoff.classList.remove('hidden');
      return;
    }

    if (!git?.repo) {
      dom.handoff.innerHTML = `
        <section class="handoff-card merge-setup">
          <p class="handoff-eyebrow">Merge</p>
          <h2>Open the studio inside a git repository.</h2>
          <p class="handoff-lede">A merge needs local branches. The current workspace is
            <code>${escapeText(state.config.cwd)}</code>, and it is not a git checkout.</p>
        </section>
      `;
      dom.handoff.classList.remove('hidden');
      return;
    }

    const branches = git.branches ?? [];

    if (branches.length < 2) {
      dom.handoff.innerHTML = `
        <section class="handoff-card merge-setup">
          <p class="handoff-eyebrow">Merge</p>
          <h2>This repository has only one local branch.</h2>
          <p class="handoff-lede">Create the source branch first. A merge needs a source and a
            target that are not the same branch.</p>
        </section>
      `;
      dom.handoff.classList.remove('hidden');
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

    dom.handoff.innerHTML = `
      <section class="handoff-card merge-setup" aria-labelledby="merge-setup-title">
        <p class="handoff-eyebrow">Merge</p>
        <h2 id="merge-setup-title">Review a branch merge</h2>
        <p class="handoff-lede">The agent dry-runs the merge, asks one decision at a time, and
          builds the integration branch. It never touches the target; landing is a separate,
          explicit step.</p>
        <p class="hint">With Claude Code, the studio also blocks pushes and any command that
          touches the target. Other agents use their own permission prompts.</p>

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
        ${git.dirty && !error ? '<p class="merge-warning">The working tree has changes. Commit or stash them before starting; the studio will refuse otherwise.</p>' : ''}

        <div class="actions handoff-actions">
          <button type="button" class="btn primary" data-role="merge-start">Review merge</button>
          <span class="handoff-error" data-role="merge-error" role="alert"></span>
        </div>
      </section>
    `;
    dom.handoff.classList.remove('hidden');

    const sourceEl = dom.handoff.querySelector('[data-role="merge-source"]');
    const targetEl = dom.handoff.querySelector('[data-role="merge-target"]');
    const refEl = dom.handoff.querySelector('[data-role="merge-ref"]');
    const errorEl = dom.handoff.querySelector('[data-role="merge-error"]');
    const startBtn = dom.handoff.querySelector('[data-role="merge-start"]');

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

    startBtn.addEventListener('click', () => {
      startMergeSession(sourceEl.value, targetEl.value);
    });

    update();
  }

  async function startMergeSession(source, target) {
    const { agentPreset, agentCmd } = selectedAgent();
    const errorEl = dom.handoff.querySelector('[data-role="merge-error"]');

    if (agentPreset === 'custom' && !agentCmd) {
      if (errorEl) {
        errorEl.textContent = 'Add an agent command in Settings, or pick a preset.';
      }
      return;
    }

    resetSession({ setup: false });
    view.running = true;
    view.setup = false;
    view.mergeMeta = null;
    dom.stage.classList.remove('hidden');
    setComposerVisible(true);
    dom.stop.disabled = false;
    setInputEnabled(false);
    setStatus('starting', true);
    setScope('merge session running');
    render();

    try {
      const { job } = await api(copy.endpoint, {
        method: 'POST',
        body: JSON.stringify({ source, target, agentPreset, agentCmd })
      });

      view.mergeMeta = job.request?.merge ?? {
        source,
        target,
        ref: `merge/${source}-into-${target}`
      };
      attach(job.id);
      announceStatus('Merge session started.');
    } catch (error) {
      resetSession();
      renderMergeSetup(error.message);
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
    wireNewMerge(dom.handoff.querySelector('[data-role="merge-new"]'));
    setScope('merge not created');
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
          <code>${escapeText(target)}</code>, fast-forwards it, and stays there. Nothing is
          pushed, and no merge commit is created.</p>

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

    wireNewMerge(dom.handoff.querySelector('[data-role="merge-new"]'));
    setScope(`ready to land on ${target}`);
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
    wireNewMerge(dom.handoff.querySelector('[data-role="merge-new"]'));
    setScope(`landed on ${target}`);
  }

  function buildRequest() {
    const pipeline = dom.handoff.querySelector('input[name="pipeline"]:checked')?.value ?? 'direct';
    const verify = dom.handoff.querySelector('[data-role="verify"]')?.checked !== false;

    return { pipeline, verify };
  }

  async function startBuild() {
    const request = buildRequest();
    const errorEl = dom.handoff.querySelector('[data-role="build-error"]');

    if (errorEl) {
      errorEl.textContent = '';
    }

    hideHandoff();
    view.build = {
      status: 'starting',
      pipeline: request.pipeline,
      verify: request.verify,
      steps: [],
      log: '',
      error: '',
      publish: null
    };
    view.buildPainted = false;
    paintBuild();
    setInputEnabled(false);
    announceStatus('Build started.');

    try {
      await api(`${copy.endpoint}/${view.sessionId}/build`, {
        method: 'POST',
        body: JSON.stringify(request)
      });
      attachBuild();
    } catch (error) {
      view.build.status = 'failed';
      view.build.error = error.message;
      paintBuild();
      showHandoff();
      const message = dom.handoff.querySelector('[data-role="build-error"]');

      if (message) {
        message.textContent = error.message;
      }
    }
  }

  function paintBuild() {
    if (!view.build) {
      return;
    }

    const build = view.build;
    const meta = PIPELINE_COPY[build.pipeline] ?? PIPELINE_COPY.direct;

    if (!view.buildPainted) {
      dom.handoff.innerHTML = `
        <section class="build-card" aria-label="Feature build">
          <header class="build-head">
            <div>
              <p class="handoff-eyebrow">Build</p>
              <h2 data-role="build-title">${meta.label}</h2>
              <p class="handoff-lede" data-role="build-meta"></p>
              <p class="build-publish hidden" data-role="build-publish"></p>
            </div>
            <span class="badge" data-role="build-badge">starting</span>
          </header>
          <ol class="build-steps" data-role="build-steps"></ol>
          <pre class="build-log" data-role="build-log" aria-label="Build output"></pre>
          <div class="actions handoff-actions">
            <button type="button" class="btn quiet-danger sm" data-role="build-stop">Stop build</button>
          </div>
        </section>
      `;
      dom.handoff.classList.remove('hidden');
      dom.handoff.querySelector('[data-role="build-stop"]').addEventListener('click', stopBuild);
      view.buildPainted = true;
    }

    const badge = dom.handoff.querySelector('[data-role="build-badge"]');
    const metaEl = dom.handoff.querySelector('[data-role="build-meta"]');
    const stepsEl = dom.handoff.querySelector('[data-role="build-steps"]');
    const logEl = dom.handoff.querySelector('[data-role="build-log"]');
    const stopBtn = dom.handoff.querySelector('[data-role="build-stop"]');
    const state = build.status;

    badge.className = `badge ${state === 'done' ? 'done' : state === 'failed' ? 'failed' : state === 'stopped' ? 'cancelled' : 'running'}`;
    badge.textContent = state === 'done' ? 'built' : state === 'failed' ? 'failed' : state === 'stopped' ? 'stopped' : 'running';
    stopBtn.disabled = !['starting', 'running'].includes(state);

    const verifyText = build.verify ? 'E2E verification on' : 'E2E verification skipped';
    const changed = build.summary?.changedFiles?.length;

    metaEl.textContent = state === 'done'
      ? `${verifyText} · ${changed ?? 0} file${changed === 1 ? '' : 's'} changed`
      : state === 'failed'
        ? `${verifyText} · ${build.error || 'the build failed'}`
        : `${verifyText}`;

    const publishEl = dom.handoff.querySelector('[data-role="build-publish"]');

    if (publishEl) {
      const publish = build.publish;
      const text = publish ? publishEventText(publish) : '';

      if (!text) {
        publishEl.classList.add('hidden');
        publishEl.innerHTML = '';
      } else {
        const link = publish?.status === 'published' && publish.prUrl
          ? ` <a href="${escapeText(publish.prUrl)}" target="_blank" rel="noreferrer">Open merge request</a>`
          : '';

        publishEl.innerHTML = `${escapeText(text)}${link}`;
        publishEl.classList.remove('hidden');
      }
    }

    stepsEl.innerHTML = build.steps.map((step, index) => `
      <li data-status="${step.status}">
        <span class="build-step-index">${index + 1}</span>
        <span class="build-step-name">${step.skill}</span>
        <span class="build-step-state">${step.status === 'done' ? 'done' : step.status === 'running' ? 'running' : 'waiting'}</span>
      </li>
    `).join('');

    if (logEl) {
      logEl.textContent = build.log;
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function scheduleBuildPaint() {
    window.clearTimeout(view.buildTimer);
    view.buildTimer = window.setTimeout(() => {
      view.buildTimer = null;
      paintBuild();
    }, 160);
  }

  function onBuildEvent(event) {
    if (!view.build) {
      return;
    }

    const build = view.build;

    switch (event.type) {
      case 'build-started':
        build.pipeline = event.pipeline ?? build.pipeline;
        build.verify = event.verify !== false;
        build.spec = event.spec;
        build.steps = (event.steps ?? []).map((step) => ({
          skill: step.skill,
          status: 'waiting'
        }));
        build.status = 'running';
        paintBuild();
        break;
      case 'build-step': {
        const step = build.steps[event.index];

        if (step) {
          step.status = event.status;
        }

        build.status = 'running';
        paintBuild();
        break;
      }
      case 'output':
        build.log += event.chunk ?? '';
        if (build.log.length > 60000) {
          build.log = build.log.slice(-60000);
        }
        scheduleBuildPaint();
        break;
      case 'publish':
        build.publish = { ...event };
        paintBuild();
        break;
      case 'job-done':
        build.status = 'done';
        build.summary = event.summary;
        build.steps = (event.summary?.steps ?? build.steps).map((step, index) => ({
          skill: step.skill ?? build.steps[index]?.skill ?? 'step',
          status: 'done'
        }));
        build.specPath = event.summary?.specPath || build.specPath;
        endBuild();
        paintBuild();
        break;
      case 'job-failed':
        build.status = 'failed';
        build.error = event.message ?? 'The build failed.';
        endBuild();
        paintBuild();
        break;
      case 'job-cancelled':
        build.status = 'stopped';
        endBuild();
        paintBuild();
        break;
      default:
        break;
    }
  }

  function endBuild() {
    if (view.buildSource) {
      view.buildSource.close();
      view.buildSource = null;
    }

    setInputEnabled(true, copy.restartPlaceholder);
    announceStatus(
      view.build?.status === 'done'
        ? 'The build finished.'
        : view.build?.status === 'failed'
          ? 'The build failed.'
          : 'The build stopped.'
    );
  }

  function attachBuild() {
    if (view.buildSource || !view.sessionId) {
      return;
    }

    const source = new EventSource(`${copy.endpoint}/${view.sessionId}/build/events`);

    view.buildSource = source;
    source.onmessage = (message) => {
      try {
        onBuildEvent(JSON.parse(message.data));
      } catch {
        // Ignore malformed events; the stream is best-effort.
      }
    };
  }

  async function stopBuild() {
    if (!view.sessionId) {
      return;
    }

    try {
      await api(`${copy.endpoint}/${view.sessionId}/build/cancel`, { method: 'POST' });
    } catch (error) {
      if (view.build) {
        view.build.log += `\nCould not stop the build: ${error.message}\n`;
        paintBuild();
      }
    }
  }

  async function restoreBuild() {
    if (flow !== 'feature' || !view.sessionId) {
      return;
    }

    try {
      const { build } = await api(`${copy.endpoint}/${view.sessionId}/build`);

      if (!build) {
        showHandoff();
        return;
      }

      view.build = {
        status: 'starting',
        pipeline: build.request?.pipeline ?? 'direct',
        verify: build.request?.verify !== false,
        steps: [],
        log: '',
        error: '',
        publish: null
      };
      view.buildPainted = false;

      for (const event of build.events ?? []) {
        onBuildEvent(event);
      }

      if (['running', 'waiting', 'cancelling'].includes(build.status)) {
        view.build.status = 'running';
        attachBuild();
        setInputEnabled(false);
      }

      paintBuild();
    } catch {
      showHandoff();
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
    if (view.buildSource) {
      view.buildSource.close();
    }

    window.clearTimeout(view.renderTimer);
    window.clearTimeout(view.buildTimer);
    stopTurnClock();
    view.jobId = null;
    view.sessionId = null;
    view.source = null;
    view.entries = [];
    view.active = null;
    view.awaiting = false;
    view.running = false;
    view.finished = false;
    view.seq = 0;
    view.build = null;
    view.buildSource = null;
    view.buildPainted = false;
    view.mergeMeta = null;
    view.setup = false;
    view.setupError = '';
    hideHandoff();
    dom.richView.innerHTML = '';
    dom.rawView.textContent = '';
    dom.richView.classList.add('hidden');
    dom.rawView.classList.add('hidden');
    dom.empty.classList.remove('hidden');
    dom.stage.classList.remove('hidden');
    dom.stop.disabled = true;
    if (dom.finish) {
      dom.finish.disabled = true;
    }
    dom.input.value = '';
    if (dom.jiraSelect) {
      dom.jiraSelect.replaceChildren(new Option('Load open issues…', ''));
      dom.jiraSelect.disabled = true;
    }
    if (dom.jiraLoad) {
      dom.jiraLoad.disabled = false;
    }
    if (dom.jiraStatus) {
      dom.jiraStatus.textContent = '';
    }
    if (dom.publish) {
      dom.publish.checked = true;
    }
    setStatus('ready', false);
    setScope(copy.scope);

    if (flow === 'merge') {
      setInputEnabled(false);
      setComposerVisible(false);

      if (setup) {
        renderMergeSetup();
      }
    } else {
      setInputEnabled(true, copy.placeholder);
      setComposerVisible(true);
    }

    autoGrow();
  }

  async function start(brief) {
    const { agentPreset, agentCmd } = selectedAgent();
    const publishRequested = flow === 'merge' ? false : Boolean(dom.publish?.checked);
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
        body: JSON.stringify({
          brief,
          agentPreset,
          agentCmd,
          ...(flow === 'merge' ? {} : { publish: publishRequested })
        })
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
      setInputEnabled(true, copy.answerPlaceholder);
      render();
    }
  }

  // The human closes the session: after the final report or spec there is
  // nothing left to answer. No text is inspected to decide this.
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
      view.sessionId = job.id;

      if (flow === 'merge') {
        view.mergeMeta = job.request?.merge ?? null;

        if (job.status === 'done' && job.result?.ref && view.mergeMeta) {
          view.mergeMeta = { ...view.mergeMeta, ref: job.result.ref };
        }
      }

      if (['running', 'waiting', 'cancelling'].includes(job.status)) {
        attach(job.id);
        return;
      }

      for (const event of job.events ?? []) {
        onEvent(event);
      }

      view.running = false;

      if (view.finished && flow === 'feature') {
        await restoreBuild();
      }
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
  dom.finish?.addEventListener('click', finish);
  dom.jiraLoad?.addEventListener('click', loadJiraIssues);
  dom.jiraSelect?.addEventListener('change', importJiraIssue);
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

  return {
    reset: resetSession,
    restore,
    updateAgent,
    syncPublish,
    refreshSetup: () => {
      if (flow === 'merge' && view.setup && !view.running) {
        renderMergeSetup(view.setupError ?? '');
      }
    },
    view
  };
}

const sessionViews = {
  enhancement: createSession('enhancement'),
  feature: createSession('feature'),
  merge: createSession('merge')
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
    sessionViews.enhancement?.syncPublish?.();
    sessionViews.feature?.syncPublish?.();
    // The merge setup reads local branches from this config, so it refreshes
    // after a landing or a retry without leaving the tab.
    sessionViews.merge?.refreshSetup?.();
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
