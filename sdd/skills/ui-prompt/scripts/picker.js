(() => {
  const HOST_ID = "__ui-prompt-host";
  const REVIEW_HOST_ID = "__ui-prompt-review-host";
  const QUEUE_KEY = "__uiPromptQueue";
  const BUSY_KEY = "__uiPromptBusy";
  const QUESTION_KEY = "__uiPromptQuestion";
  const REPLY_KEY = "__uiPromptReply";
  const WAKE_PREFIX = "ui-prompt-wake-";
  const existing = window.__uiPromptPicker;

  if (existing && typeof existing.activate === "function" && !existing.stopped) {
    if (typeof existing.setWake === "function") {
      existing.activate();
      return "already-active";
    }
    // An older injected session has no wake API; replace it. The queue persists.
    try {
      existing.stop();
    } catch (error) {
      // A broken old session must not block the new one.
    }
  }

  const staleReviewHost = document.getElementById(REVIEW_HOST_ID);
  if (staleReviewHost && staleReviewHost.parentNode) {
    staleReviewHost.parentNode.removeChild(staleReviewHost);
  }

  const T = {
    pick: "Pick element",
    picking: "Picking — Esc",
    copy: "Copy",
    copyTitle: "Copy the last payload to the clipboard",
    exit: "Exit",
    exitTitle: "End the session",
    panelTitle: "UI change",
    placeholder: "What should change on this element?",
    submit: "Submit",
    cancel: "Cancel",
    hint: "Ctrl+Enter submits · Esc cancels",
    sentAuto: "Submitted — processing.",
    sentManual: "Submitted — say 'continue' in chat.",
    needPrompt: "Write the change first.",
    busyBlocked: "A prompt is being processed — wait until it finishes.",
    copied: "Payload copied to the clipboard.",
    copyEmpty: "No payload to copy yet.",
    copyFailed: "Could not copy to the clipboard.",
    close: "Close",
    waiting: "Waiting for a selection",
    working: "Working…",
    off: "Picking off",
    stopped: "Session stopped",
    questionTitle: "Selection needed",
    questionHint: "Choose one option; the choice is sent to the agent.",
    answerSent: "Choice sent.",
    reviewTitle: "Design review",
    reviewIntro:
      "These changes diverge from DESIGN.md. Choose the ones to write into the design; nothing is preselected.",
    reviewFrom: "From",
    reviewTo: "To",
    reviewFiles: "Files",
    reviewPrompt: "Request",
    reviewScope: "Scope",
    reviewLayer: "Layer",
    reviewKind: "Kind",
    reviewApprove: "Approve selected",
    reviewSelectAll: "Select all",
    reviewReject: "Reject and close",
    reviewClose: "Close",
    reviewHint:
      "Approval writes only the selected deltas to DESIGN.md. Ctrl+Enter approves · Esc cancels.",
  };

  let picking = false;
  let panelOpen = false;
  let pending = null;
  let lastPayload = null;
  let toastTimer = null;
  let stopped = false;
  let busy = false;
  let question = null;
  let reviewSession = null;
  let wakeEnabled = false;
  const waiters = [];

  // ---------------------------------------------------------------- queue

  function readQueue() {
    try {
      const raw = window.localStorage.getItem(QUEUE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) return parsed;
    } catch (error) {
      // fall through to the in-memory queue
    }
    return Array.isArray(window[QUEUE_KEY]) ? window[QUEUE_KEY] : [];
  }

  function writeQueue(queue) {
    window[QUEUE_KEY] = queue;
    try {
      window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    } catch (error) {
      // in-memory queue is still updated
    }
  }

  if (!window[QUEUE_KEY]) window[QUEUE_KEY] = readQueue();

  function readStored(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw);
    } catch (error) {
      // fall through to the in-memory value
    }
    return window[key] === undefined ? fallback : window[key];
  }

  function writeStored(key, value) {
    window[key] = value;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // in-memory value is still updated
    }
  }

  function removeStored(key) {
    delete window[key];
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      // in-memory value is already gone
    }
  }

  function readBusy() {
    return readStored(BUSY_KEY, false) === true;
  }

  function writeBusy(value) {
    writeStored(BUSY_KEY, !!value);
  }

  function readQuestion() {
    const value = readStored(QUESTION_KEY, null);
    return value && typeof value === "object" && value.id ? value : null;
  }

  function writeQuestion(value) {
    if (value) writeStored(QUESTION_KEY, value);
    else removeStored(QUESTION_KEY);
  }

  function readReply() {
    const value = readStored(REPLY_KEY, null);
    return value && typeof value === "object" && value.id ? value : null;
  }

  function writeReply(value) {
    if (value) writeStored(REPLY_KEY, value);
    else removeStored(REPLY_KEY);
  }

  // ------------------------------------------------------- source hints

  const SOURCE_ATTRS = [
    "data-v-inspector",
    "data-source",
    "data-source-file",
    "data-file",
    "data-file-path",
    "data-component-file",
    "data-loc",
    "data-location",
    "data-origin",
    "data-inspector",
  ];
  const NAME_ATTRS = ["data-component", "data-component-name", "data-name"];
  const SOURCE_EXT_RE = /\.(jsx?|tsx?|mjs|cjs|vue|svelte|astro|html?)$/i;

  function normalizeFile(file) {
    if (!file) return file;
    let out = String(file);
    try {
      out = decodeURIComponent(out);
    } catch (error) {
      // keep the raw value
    }
    out = out.replace(/[?#].*$/, "");
    out = out.replace(/^https?:\/\/[^/]+/i, "");
    out = out.replace(/^\/@fs\//, "/");
    out = out.replace(/^file:\/\//i, "");
    out = out.replace(/^\/([A-Za-z]:[\\/])/, "$1");
    out = out.replace(/\\/g, "/");
    return out;
  }

  function looksLikeSource(file) {
    if (!file) return false;
    const normalized = String(file).toLowerCase();
    if (normalized.indexOf("node_modules") !== -1) return false;
    return (
      SOURCE_EXT_RE.test(file) ||
      normalized.indexOf("/src/") !== -1 ||
      normalized.indexOf("src/") === 0
    );
  }

  function splitLocation(value) {
    const text = String(value === null || value === undefined ? "" : value).trim();
    if (!text) return null;

    if (text.charAt(0) === "{") {
      try {
        const data = JSON.parse(text);
        const file = data.file || data.fileName || data.source || data.path;
        if (!file) return null;
        return {
          name: data.name || data.component || data.componentName || null,
          file: normalizeFile(file),
          line: data.line || data.lineNumber || null,
          column: data.column || data.columnNumber || null,
        };
      } catch (error) {
        // not JSON; parse it as a path
      }
    }

    const parts = text.split(":");
    let line = null;
    let column = null;
    if (
      parts.length >= 3 &&
      /^\d+$/.test(parts[parts.length - 1]) &&
      /^\d+$/.test(parts[parts.length - 2])
    ) {
      column = parseInt(parts.pop(), 10);
      line = parseInt(parts.pop(), 10);
    } else if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
      line = parseInt(parts.pop(), 10);
    }
    const file = normalizeFile(parts.join(":"));
    if (!file) return null;
    return { name: null, file: file, line: line, column: column };
  }

  function collectSourceHints(element) {
    const hints = [];
    const seen = {};

    function add(hint, via) {
      if (!hint) return;
      const name = hint.name ? String(hint.name).trim() : null;
      const file = hint.file ? normalizeFile(hint.file) : null;
      if (!name && !file) return;
      if (file && !looksLikeSource(file)) return;
      const key = file
        ? "file:" + file + ":" + (hint.line || "") + ":" + (hint.column || "")
        : "name:" + name;
      if (seen[key]) return;
      seen[key] = true;
      hints.push({
        name: name || null,
        file: file || null,
        line: hint.line || null,
        column: hint.column || null,
        via: via,
      });
    }

    try {
      const resolver = window.__uiPromptSourceResolver;
      if (typeof resolver === "function") {
        const result = resolver(element);
        const list = Array.isArray(result) ? result : result ? [result] : [];
        for (let i = 0; i < list.length; i++) {
          const item = list[i];
          if (typeof item === "string") {
            add(splitLocation(item), "__uiPromptSourceResolver");
          } else if (item && typeof item === "object") {
            add(
              {
                name: item.name || item.component || item.componentName || null,
                file: item.file || item.fileName || item.source || null,
                line: item.line || item.lineNumber || null,
                column: item.column || item.columnNumber || null,
              },
              "__uiPromptSourceResolver"
            );
          }
        }
      }
    } catch (error) {
      // an optional project resolver must not break selection
    }

    let node = element;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let nodeName = null;
      const attrs = node.attributes || [];
      for (let i = 0; i < attrs.length; i++) {
        const attrName = String(attrs[i].name || "").toLowerCase();
        if (NAME_ATTRS.indexOf(attrName) !== -1) {
          const value = String(attrs[i].value || "").trim();
          if (value) {
            nodeName = value;
            break;
          }
        }
      }
      for (let i = 0; i < attrs.length; i++) {
        const attr = attrs[i];
        const attrName = String(attr.name || "").toLowerCase();
        if (SOURCE_ATTRS.indexOf(attrName) === -1) continue;
        const hint = splitLocation(attr.value);
        if (!hint) continue;
        if (nodeName && !hint.name) hint.name = nodeName;
        add(hint, attrName);
      }
      if (nodeName) {
        add({ name: nodeName, file: null, line: null, column: null }, "name-attribute");
      }
      node = node.parentElement;
      depth++;
    }

    let fallbackName = null;
    for (let i = 0; i < hints.length; i++) {
      if (!hints[i].file && hints[i].name) {
        fallbackName = hints[i].name;
        break;
      }
    }
    if (fallbackName) {
      for (let i = 0; i < hints.length; i++) {
        if (hints[i].file && !hints[i].name) {
          hints[i].name = fallbackName;
          break;
        }
      }
    }

    const namedFiles = {};
    for (let i = 0; i < hints.length; i++) {
      if (hints[i].file && hints[i].name) namedFiles[hints[i].name] = true;
    }
    const out = [];
    for (let i = 0; i < hints.length; i++) {
      const hint = hints[i];
      if (!hint.file && hint.name && namedFiles[hint.name]) continue;
      out.push(hint);
    }
    return out;
  }

  function shortFile(file) {
    if (!file) return "";
    const parts = String(file).replace(/\\/g, "/").split("/");
    return parts.slice(Math.max(0, parts.length - 3)).join("/");
  }

  function targetLabel(element) {
    const hints = collectSourceHints(element);
    for (let i = 0; i < hints.length; i++) {
      const hint = hints[i];
      if (hint.file) {
        const name = hint.name || element.tagName.toLowerCase();
        return name + " · " + shortFile(hint.file) + ":" + (hint.line || "?");
      }
    }
    for (let i = 0; i < hints.length; i++) {
      if (hints[i].name) return hints[i].name;
    }
    const tag = element.tagName.toLowerCase();
    if (element.id) return tag + "#" + element.id;
    const testId =
      element.getAttribute &&
      (element.getAttribute("data-testid") || element.getAttribute("data-test"));
    if (testId) {
      const attr = element.getAttribute("data-testid") ? "data-testid" : "data-test";
      return tag + "[" + attr + '="' + testId + '"]';
    }
    return tag;
  }

  // ------------------------------------------------------------- payload

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function buildSelector(element) {
    const parts = [];
    let node = element;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + cssEscape(node.id);
        parts.unshift(part);
        break;
      }
      const testId = node.getAttribute
        ? node.getAttribute("data-testid") || node.getAttribute("data-test")
        : null;
      if (testId) {
        const attr = node.getAttribute("data-testid") ? "data-testid" : "data-test";
        part += "[" + attr + '="' + testId.replace(/"/g, '\\"') + '"]';
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        let index = 0;
        let count = 0;
        for (let i = 0; i < parent.children.length; i++) {
          const child = parent.children[i];
          if (child.tagName === node.tagName) {
            count++;
            if (child === node) index = count;
          }
        }
        if (count > 1) part += ":nth-of-type(" + index + ")";
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  const STYLE_PROPS = [
    "display",
    "position",
    "width",
    "height",
    "margin",
    "padding",
    "color",
    "backgroundColor",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "textAlign",
    "border",
    "borderRadius",
    "boxShadow",
    "gap",
    "flexDirection",
    "alignItems",
    "justifyContent",
  ];

  function computedSubset(element) {
    const computed = window.getComputedStyle(element);
    const out = {};
    for (let i = 0; i < STYLE_PROPS.length; i++) {
      out[STYLE_PROPS[i]] = computed[STYLE_PROPS[i]];
    }
    return out;
  }

  function buildPayload(element, prompt) {
    const rect = element.getBoundingClientRect();
    const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    return {
      timestamp: new Date().toISOString(),
      url: window.location.href,
      selector: buildSelector(element),
      tag: element.tagName.toLowerCase(),
      text: text.slice(0, 200),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      sourceHints: collectSourceHints(element),
      computed: computedSubset(element),
      prompt: prompt,
    };
  }

  // ------------------------------------------------------------------ UI

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });

  const STYLE = [
    ":host { all: initial; display: block; }",
    "* { box-sizing: border-box; }",
    "[hidden] { display: none !important; }",
    ".toolbar { position: fixed; right: 16px; bottom: 16px; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; max-width: calc(100vw - 32px); pointer-events: auto; z-index: 2; }",
    ".status { color: #94A3B8; font: 500 11px/1.2 Inter, system-ui, sans-serif; margin-right: 4px; white-space: nowrap; }",
    ".status.busy { display: inline-flex; align-items: center; gap: 6px; color: #F8FAFC; background: #1E293B; border: 1px solid #334155; border-radius: 999px; padding: 6px 10px; }",
    ".status.busy::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: #22C55E; animation: ui-prompt-pulse 1.1s ease-in-out infinite; }",
    "@keyframes ui-prompt-pulse { 0%, 100% { opacity: .3; transform: scale(.75); } 50% { opacity: 1; transform: scale(1); } }",
    "@media (prefers-reduced-motion: reduce) { .status.busy::before { animation: none; opacity: 1; } }",
    ".btn { font: 500 13px/1 Inter, system-ui, sans-serif; color: #E2E8F0; background: #1E293B; border: 1px solid #334155; border-radius: 8px; padding: 9px 12px; cursor: pointer; }",
    ".btn:hover { background: #273449; }",
    ".btn:disabled { opacity: .5; cursor: not-allowed; }",
    ".btn-primary { background: #15803D; border-color: #15803D; color: #FFFFFF; }",
    ".btn-primary:hover { background: #166534; }",
    ".btn-danger { background: #7F1D1D; border-color: #7F1D1D; color: #FEE2E2; }",
    ".btn-danger:hover { background: #991B1B; }",
    ".btn.active { background: #B91C1C; border-color: #B91C1C; color: #FFFFFF; }",
    ".highlight { position: fixed; pointer-events: none; border: 2px solid #22C55E; background: rgba(34, 197, 94, 0.10); border-radius: 4px; z-index: 1; }",
    '.label { position: absolute; left: 0; padding: 3px 6px; border-radius: 4px; background: #0F172A; color: #F8FAFC; font: 500 11px/1.3 "JetBrains Mono", ui-monospace, monospace; white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }',
    ".panel { position: fixed; width: 340px; max-width: calc(100vw - 24px); background: #0F172A; color: #F8FAFC; border: 1px solid #334155; border-radius: 10px; padding: 12px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5); pointer-events: auto; z-index: 3; font: 400 13px/1.4 Inter, system-ui, sans-serif; }",
    ".panel-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }",
    ".panel-head strong { font-size: 13px; }",
    ".panel-close { background: none; border: 0; color: #94A3B8; font-size: 18px; line-height: 1; cursor: pointer; }",
    '.panel-target { color: #94A3B8; font: 400 11px/1.4 "JetBrains Mono", ui-monospace, monospace; word-break: break-all; margin-bottom: 8px; }',
    ".panel textarea { width: 100%; min-height: 84px; resize: vertical; background: #1E293B; color: #F8FAFC; border: 1px solid #334155; border-radius: 8px; padding: 8px; font: 400 13px/1.45 Inter, system-ui, sans-serif; outline: none; }",
    ".panel textarea:focus { border-color: #22C55E; }",
    ".panel-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }",
    ".panel-hint { color: #64748B; font-size: 11px; margin-top: 6px; }",
    ".question { position: fixed; right: 16px; bottom: 64px; width: 380px; max-width: calc(100vw - 32px); max-height: calc(100vh - 96px); overflow: auto; background: #0F172A; color: #F8FAFC; border: 1px solid #334155; border-radius: 10px; padding: 12px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5); pointer-events: auto; z-index: 3; font: 400 13px/1.4 Inter, system-ui, sans-serif; }",
    ".question-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }",
    ".question-head strong { font-size: 13px; }",
    ".question-message { color: #CBD5E1; margin-bottom: 10px; white-space: pre-wrap; }",
    ".question-options { display: flex; flex-direction: column; gap: 6px; }",
    ".question-option { text-align: left; display: flex; flex-direction: column; gap: 2px; }",
    '.question-option .detail { color: #94A3B8; font: 400 11px/1.4 "JetBrains Mono", ui-monospace, monospace; word-break: break-all; }',
    ".question-actions { display: flex; justify-content: flex-end; margin-top: 8px; }",
    ".question-hint { color: #64748B; font-size: 11px; margin-top: 6px; }",
    ".toast { position: fixed; left: 16px; bottom: 16px; max-width: 360px; background: #0F172A; color: #F8FAFC; border: 1px solid #334155; border-left: 3px solid #22C55E; border-radius: 8px; padding: 10px 12px; font: 500 12px/1.4 Inter, system-ui, sans-serif; pointer-events: none; z-index: 4; }",
  ].join("\n");

  shadow.innerHTML =
    "<style>" +
    STYLE +
    "</style>" +
    '<div class="toolbar" id="toolbar">' +
    '<span class="status" id="status" role="status" aria-live="polite"></span>' +
    '<button type="button" class="btn btn-primary" id="pick">' +
    T.pick +
    "</button>" +
    '<button type="button" class="btn" id="copy" title="' +
    T.copyTitle +
    '">' +
    T.copy +
    "</button>" +
    '<button type="button" class="btn btn-danger" id="exit" title="' +
    T.exitTitle +
    '">' +
    T.exit +
    "</button>" +
    "</div>" +
    '<div class="highlight" id="highlight" hidden><span class="label" id="label"></span></div>' +
    '<div class="panel" id="panel" hidden>' +
    '<div class="panel-head"><strong>' +
    T.panelTitle +
    '</strong><button type="button" class="panel-close" id="close" aria-label="' +
    T.close +
    '">×</button></div>' +
    '<div class="panel-target" id="target"></div>' +
    '<textarea id="text" rows="4" placeholder="' +
    T.placeholder +
    '"></textarea>' +
    '<div class="panel-actions">' +
    '<button type="button" class="btn" id="cancel">' +
    T.cancel +
    "</button>" +
    '<button type="button" class="btn btn-primary" id="submit">' +
    T.submit +
    "</button>" +
    "</div>" +
    '<div class="panel-hint">' +
    T.hint +
    "</div>" +
    "</div>" +
    '<div class="question" id="question" role="dialog" aria-modal="false" aria-labelledby="question-title" hidden>' +
    '<div class="question-head"><strong id="question-title"></strong></div>' +
    '<div class="question-message" id="question-message"></div>' +
    '<div class="question-options" id="question-options"></div>' +
    '<div class="question-actions"><button type="button" class="btn" id="question-cancel">' +
    T.cancel +
    "</button></div>" +
    '<div class="question-hint">' +
    T.questionHint +
    "</div>" +
    "</div>" +
    '<div class="toast" id="toast" hidden></div>';

  const toolbar = shadow.getElementById("toolbar");
  const statusEl = shadow.getElementById("status");
  const pickBtn = shadow.getElementById("pick");
  const copyBtn = shadow.getElementById("copy");
  const exitBtn = shadow.getElementById("exit");
  const highlight = shadow.getElementById("highlight");
  const label = shadow.getElementById("label");
  const panel = shadow.getElementById("panel");
  const panelTarget = shadow.getElementById("target");
  const textarea = shadow.getElementById("text");
  const toastEl = shadow.getElementById("toast");
  const questionPanel = shadow.getElementById("question");
  const questionTitle = shadow.getElementById("question-title");
  const questionMessage = shadow.getElementById("question-message");
  const questionOptions = shadow.getElementById("question-options");
  const questionCancel = shadow.getElementById("question-cancel");
  let labelElement = null;

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toastEl.hidden = true;
    }, 2600);
  }

  function hideHighlight() {
    highlight.hidden = true;
    labelElement = null;
  }

  function showHighlight(element) {
    const rect = element.getBoundingClientRect();
    highlight.hidden = false;
    highlight.style.left = rect.left + "px";
    highlight.style.top = rect.top + "px";
    highlight.style.width = rect.width + "px";
    highlight.style.height = rect.height + "px";

    if (element !== labelElement) {
      labelElement = element;
      label.textContent = targetLabel(element);
    }

    const above = rect.top > 28;
    label.style.top = above ? "-24px" : rect.height + 4 + "px";
  }

  function positionPanel(rect) {
    const margin = 12;
    const panelWidth = panel.offsetWidth || 340;
    const panelHeight = panel.offsetHeight || 220;

    let left;
    if (rect.right + margin + panelWidth <= window.innerWidth - margin) {
      left = rect.right + margin;
    } else {
      left = rect.left - panelWidth - margin;
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - panelWidth - margin));

    let top = rect.top;
    top = Math.max(margin, Math.min(top, window.innerHeight - panelHeight - margin));

    panel.style.left = left + "px";
    panel.style.top = top + "px";
  }

  function openPanel(element) {
    pending = { element: element };
    panelOpen = true;
    hideHighlight();

    panelTarget.textContent = targetLabel(element);
    textarea.value = "";
    panel.hidden = false;
    window.requestAnimationFrame(function () {
      positionPanel(element.getBoundingClientRect());
      textarea.focus();
    });
  }

  function closePanel() {
    pending = null;
    panelOpen = false;
    panel.hidden = true;
  }

  function setBusy(value) {
    busy = !!value;
    writeBusy(busy);
    pickBtn.hidden = busy;
    pickBtn.disabled = busy;
    statusEl.classList.toggle("busy", busy);
    if (busy) {
      picking = false;
      closePanel();
      hideHighlight();
      toolbar.setAttribute("aria-busy", "true");
      setStatus(T.working);
    } else {
      toolbar.removeAttribute("aria-busy");
      if (!stopped) activate();
    }
    return busy;
  }

  function normalizeQuestion(input) {
    const source = input && typeof input === "object" ? input : {};
    const id = source.id ? String(source.id) : "q-" + Date.now().toString(36);
    const options = [];
    const list = Array.isArray(source.options) ? source.options : [];
    for (let i = 0; i < list.length && options.length < 6; i++) {
      const option = list[i];
      if (option && typeof option === "object") {
        const optionId =
          option.id !== undefined && option.id !== null ? String(option.id) : String(i);
        options.push({
          id: optionId,
          label: option.label ? String(option.label) : optionId,
          detail: option.detail ? String(option.detail) : "",
        });
      } else if (option !== null && option !== undefined) {
        options.push({ id: String(option), label: String(option), detail: "" });
      }
    }
    return {
      id: id,
      title: source.title ? String(source.title) : T.questionTitle,
      message: source.message ? String(source.message) : "",
      options: options,
      at: new Date().toISOString(),
    };
  }

  function renderQuestion() {
    if (!question) {
      questionPanel.hidden = true;
      questionOptions.textContent = "";
      return;
    }
    questionTitle.textContent = question.title || T.questionTitle;
    questionMessage.textContent = question.message || "";
    questionMessage.hidden = !question.message;
    questionOptions.textContent = "";
    const options = Array.isArray(question.options) ? question.options : [];
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn question-option";
      const labelEl = document.createElement("span");
      labelEl.textContent = option.label || option.id;
      button.appendChild(labelEl);
      if (option.detail) {
        const detailEl = document.createElement("span");
        detailEl.className = "detail";
        detailEl.textContent = option.detail;
        button.appendChild(detailEl);
      }
      const choice = option.id;
      button.addEventListener("click", function () {
        answerQuestion(choice, false);
      });
      questionOptions.appendChild(button);
    }
    questionPanel.hidden = false;
    window.requestAnimationFrame(function () {
      const first = questionOptions.querySelector("button");
      if (first && typeof first.focus === "function") first.focus();
    });
  }

  function ask(input) {
    if (stopped) return null;
    const next = normalizeQuestion(input);
    question = next;
    writeQuestion(next);
    writeReply(null);
    if (!busy) setBusy(true);
    closePanel();
    renderQuestion();
    return { id: next.id };
  }

  function answerQuestion(choice, cancelled) {
    if (!question) return null;
    const reply = {
      id: question.id,
      choice: cancelled ? null : choice,
      cancelled: !!cancelled,
      at: new Date().toISOString(),
    };
    writeReply(reply);
    question = null;
    writeQuestion(null);
    renderQuestion();
    if (busy) setStatus(T.working);
    toast(T.answerSent);
    wake("reply");
    return reply;
  }

  function drainReply() {
    const reply = readReply();
    writeReply(null);
    return reply;
  }

  function clearQuestion() {
    question = null;
    writeQuestion(null);
    writeReply(null);
    renderQuestion();
  }

  function setWake(enabled) {
    wakeEnabled = !!enabled;
    return wakeEnabled;
  }

  // A tiny download is the wake signal. A Playwright download hook saves it to
  // the session's temp directory; a background watcher exits and wakes the agent.
  // The payload itself stays in the queue; this file carries no page data.
  function wake(kind) {
    if (!wakeEnabled) return;
    try {
      const type =
        kind === "exit" ? "exit" : kind === "reply" ? "reply" : "prompt";
      const signal = JSON.stringify({
        type: type,
        at: new Date().toISOString(),
      });
      const blob = new Blob([signal], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        WAKE_PREFIX +
        Date.now() +
        "-" +
        type +
        "-" +
        Math.random().toString(36).slice(2, 8) +
        ".json";
      anchor.style.display = "none";
      // Keep the anchor inside the overlay's shadow root: the document-level
      // click capture intercepts app clicks while picking and would cancel a
      // wake download fired from the body.
      shadow.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 2000);
    } catch (error) {
      // A wake failure must not block the queue or the overlay.
    }
  }

  function submit() {
    if (busy) {
      toast(T.busyBlocked);
      return;
    }
    if (!pending) return;
    const value = textarea.value.trim();
    if (!value) {
      toast(T.needPrompt);
      textarea.focus();
      return;
    }
    const payload = buildPayload(pending.element, value);
    const queue = readQueue();
    queue.push(payload);
    writeQueue(queue);
    lastPayload = payload;
    closePanel();
    setBusy(true);
    const message = wakeEnabled ? T.sentAuto : T.sentManual;
    toast(message);
    wake("prompt");
    notifyWaiters();
  }

  function copyLast() {
    const queue = readQueue();
    const payload = lastPayload || queue[queue.length - 1];
    if (!payload) {
      toast(T.copyEmpty);
      return;
    }
    const text = JSON.stringify(payload, null, 2);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(
        function () {
          toast(T.copied);
        },
        function () {
          toast(T.copyFailed);
        }
      );
    } else {
      toast(T.copyFailed);
    }
  }

  function activate() {
    if (stopped || busy) return;
    picking = true;
    if (!host.isConnected) {
      (document.body || document.documentElement).appendChild(host);
    }
    pickBtn.textContent = T.picking;
    pickBtn.classList.add("active");
    toolbar.hidden = false;
    setStatus(T.waiting);
  }

  function deactivate() {
    picking = false;
    hideHighlight();
    pickBtn.textContent = T.pick;
    pickBtn.classList.remove("active");
    if (!stopped && !busy) setStatus(T.off);
  }

  function drain() {
    const queue = readQueue();
    writeQueue([]);
    if (queue.length && !stopped) setBusy(true);
    return queue;
  }

  function notifyWaiters() {
    const copy = waiters.slice();
    for (let i = 0; i < copy.length; i++) copy[i]();
  }

  function waitForPrompt(timeoutMs) {
    return new Promise(function (resolve) {
      let settled = false;
      let timer = null;

      function finish(value) {
        if (settled) return;
        settled = true;
        if (timer) window.clearTimeout(timer);
        const index = waiters.indexOf(check);
        if (index !== -1) waiters.splice(index, 1);
        resolve(value);
      }

      function check() {
        if (stopped) {
          const queue = readQueue();
          writeQueue([]);
          finish({ stopped: true, queue: queue });
          return;
        }
        const queue = readQueue();
        if (queue.length) {
          writeQueue([]);
          setBusy(true);
          finish({ stopped: false, queue: queue });
        }
      }

      waiters.push(check);
      const wait = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 15000;
      timer = window.setTimeout(function () {
        finish({ stopped: false, queue: [] });
      }, wait);
      check();
    });
  }

  function notifyIdle() {
    clearQuestion();
    if (busy) {
      setBusy(false);
      return;
    }
    if (!stopped) setStatus(picking ? T.waiting : T.off);
  }

  function notify(message) {
    const text = message === null || message === undefined ? "" : String(message).trim();
    if (!text) return;
    toast(text);
    if (!busy) setStatus(text);
    else setStatus(T.working);
  }

  // ------------------------------------------------------- design review

  function formatDeltaValue(value) {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value === "object") {
      if (value.desc) return String(value.desc);
      const parts = [];
      if (value.choice) parts.push(String(value.choice));
      if (value.name) parts.push(String(value.name));
      if (value.values) parts.push(String(value.values));
      if (parts.length) return parts.join(" · ");
      try {
        return JSON.stringify(value);
      } catch (error) {
        return String(value);
      }
    }
    return String(value);
  }

  function formatDeltaList(value) {
    if (value === null || value === undefined || value === "") return "";
    if (Array.isArray(value)) {
      return value
        .map(function (entry) {
          return typeof entry === "string" ? entry : formatDeltaValue(entry);
        })
        .join(", ");
    }
    return String(value);
  }

  function addReviewRow(parent, key, value, mono) {
    if (!value) return;
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("span");
    label.className = "k";
    label.textContent = key;
    const text = document.createElement("span");
    text.className = mono ? "v mono" : "v";
    text.textContent = value;
    row.appendChild(label);
    row.appendChild(text);
    parent.appendChild(row);
  }

  function reviewDeltas(deltas) {
    const items = Array.isArray(deltas) ? deltas.slice() : [];
    if (!items.length) {
      return Promise.resolve({ approved: [], rejected: [], cancelled: false });
    }
    if (reviewSession) reviewSession.cancel();
    deactivate();

    return new Promise(function (resolve) {
      const previousFocus =
        document.activeElement && document.activeElement !== document.body
          ? document.activeElement
          : null;

      const reviewHost = document.createElement("div");
      reviewHost.id = REVIEW_HOST_ID;
      reviewHost.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:auto;";
      const reviewShadow = reviewHost.attachShadow({ mode: "open" });

      const REVIEW_STYLE = [
        ":host { all: initial; display: block; }",
        "* { box-sizing: border-box; }",
        ".backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.62); display: flex; align-items: center; justify-content: center; padding: 24px; pointer-events: auto; }",
        ".review { width: 640px; max-width: 100%; max-height: calc(100vh - 48px); display: flex; flex-direction: column; background: #0F172A; color: #F8FAFC; border: 1px solid #334155; border-radius: 12px; box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55); font: 400 13px/1.45 Inter, system-ui, sans-serif; }",
        ".review:focus { outline: none; }",
        ".review-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 16px 8px; }",
        ".review-head strong { font-size: 15px; }",
        ".review-intro { margin: 4px 0 0; color: #94A3B8; font-size: 12px; max-width: 520px; }",
        ".review-close { background: none; border: 0; color: #94A3B8; font-size: 20px; line-height: 1; cursor: pointer; padding: 0 2px; }",
        ".review-list { overflow: auto; padding: 4px 16px 8px; display: flex; flex-direction: column; gap: 8px; }",
        ".review-item { display: flex; gap: 10px; padding: 10px 12px; background: #111C2E; border: 1px solid #273449; border-radius: 10px; cursor: pointer; }",
        ".review-item:hover { border-color: #3B4B63; }",
        ".review-item input { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; margin: 3px 0 0; flex: none; border: 1px solid #64748B; border-radius: 4px; background: #0F172A; cursor: pointer; }",
        ".review-item input:checked { background-color: #22C55E; border-color: #22C55E; background-image: url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22%3E%3Cpath fill=%22none%22 stroke=%22%23052E16%22 stroke-width=%222.5%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22 d=%22M3 8.5l3.2 3.2L13 5%22/%3E%3C/svg%3E'); background-repeat: no-repeat; background-position: center; background-size: 11px 11px; }",
        ".review-item input:focus-visible { outline: 2px solid #22C55E; outline-offset: 2px; }",
        ".review-body { min-width: 0; flex: 1; }",
        ".review-item-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 4px; }",
        '.badge { display: inline-block; padding: 2px 6px; border-radius: 5px; background: #1E293B; border: 1px solid #334155; color: #A7F3D0; font: 600 11px/1.2 "JetBrains Mono", ui-monospace, monospace; }',
        ".meta { color: #64748B; font-size: 11px; }",
        ".row { display: flex; gap: 6px; margin-top: 3px; font-size: 12px; }",
        ".row .k { color: #64748B; flex: none; min-width: 52px; }",
        ".row .v { color: #CBD5E1; min-width: 0; word-break: break-word; }",
        '.mono { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 11px; }',
        ".review-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 10px 16px 4px; border-top: 1px solid #1E293B; }",
        '.btn { font: 500 13px/1 Inter, system-ui, sans-serif; color: #E2E8F0; background: #1E293B; border: 1px solid #334155; border-radius: 8px; padding: 9px 12px; cursor: pointer; }',
        ".btn:hover { background: #273449; }",
        ".btn-primary { background: #15803D; border-color: #15803D; color: #FFFFFF; }",
        ".btn-primary:hover { background: #166534; }",
        ".btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }",
        ".btn-danger { background: #7F1D1D; border-color: #7F1D1D; color: #FEE2E2; }",
        ".btn-danger:hover { background: #991B1B; }",
        ".review-hint { color: #64748B; font-size: 11px; padding: 6px 16px 14px; }",
      ].join("\n");

      reviewShadow.innerHTML =
        "<style>" +
        REVIEW_STYLE +
        "</style>" +
        '<div class="backdrop" id="backdrop">' +
        '<div class="review" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="review-title">' +
        '<div class="review-head"><div>' +
        '<strong id="review-title">' +
        T.reviewTitle +
        "</strong>" +
        '<p class="review-intro">' +
        T.reviewIntro +
        "</p></div>" +
        '<button type="button" class="review-close" id="review-close" aria-label="' +
        T.reviewClose +
        '">×</button></div>' +
        '<div class="review-list" id="review-list"></div>' +
        '<div class="review-actions">' +
        '<button type="button" class="btn btn-danger" id="review-reject">' +
        T.reviewReject +
        "</button>" +
        '<button type="button" class="btn" id="review-select-all">' +
        T.reviewSelectAll +
        "</button>" +
        '<button type="button" class="btn btn-primary" id="review-approve" disabled>' +
        T.reviewApprove +
        "</button>" +
        "</div>" +
        '<div class="review-hint">' +
        T.reviewHint +
        "</div>" +
        "</div></div>";

      const backdrop = reviewShadow.getElementById("backdrop");
      const list = reviewShadow.getElementById("review-list");
      const approveBtn = reviewShadow.getElementById("review-approve");
      const checkboxes = [];

      function selectedIndices() {
        const out = [];
        for (let i = 0; i < checkboxes.length; i++) {
          if (checkboxes[i].checked) out.push(i);
        }
        return out;
      }

      function updateApproveState() {
        approveBtn.disabled = selectedIndices().length === 0;
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i] && typeof items[i] === "object" ? items[i] : {};
        const row = document.createElement("label");
        row.className = "review-item";

        const box = document.createElement("input");
        box.type = "checkbox";
        box.setAttribute(
          "aria-label",
          (item.id ? String(item.id) : "#" + (i + 1)) +
            " — " +
            (item.title ? String(item.title) : T.reviewTitle)
        );
        box.addEventListener("change", updateApproveState);
        checkboxes.push(box);

        const body = document.createElement("div");
        body.className = "review-body";

        const head = document.createElement("div");
        head.className = "review-item-head";

        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = item.id ? String(item.id) : "#" + (i + 1);
        head.appendChild(badge);

        const title = document.createElement("strong");
        title.textContent = item.title ? String(item.title) : T.reviewTitle;
        head.appendChild(title);

        const metaText = [
          item.scope ? T.reviewScope + ": " + item.scope : "",
          item.layer !== null && item.layer !== undefined ? T.reviewLayer + " " + item.layer : "",
          item.kind ? T.reviewKind + ": " + item.kind : "",
        ]
          .filter(Boolean)
          .join(" · ");
        if (metaText) {
          const meta = document.createElement("span");
          meta.className = "meta";
          meta.textContent = metaText;
          head.appendChild(meta);
        }

        body.appendChild(head);
        addReviewRow(body, T.reviewFrom, formatDeltaValue(item.from), false);
        addReviewRow(body, T.reviewTo, formatDeltaValue(item.to), false);
        addReviewRow(body, T.reviewFiles, formatDeltaList(item.files), true);
        addReviewRow(body, T.reviewPrompt, item.prompt ? String(item.prompt) : "", false);

        row.appendChild(box);
        row.appendChild(body);
        list.appendChild(row);
      }

      let settled = false;

      function finish(result) {
        if (settled) return;
        settled = true;
        reviewSession = null;
        window.removeEventListener("keydown", onReviewKeyDown, true);
        if (reviewHost.parentNode) reviewHost.parentNode.removeChild(reviewHost);
        if (previousFocus && typeof previousFocus.focus === "function") {
          try {
            previousFocus.focus();
          } catch (error) {
            // focus is best effort
          }
        }
        resolve(result);
      }

      function cancel() {
        finish({ approved: [], rejected: items.slice(), cancelled: true });
      }

      function approve() {
        const chosen = selectedIndices();
        if (!chosen.length) {
          approveBtn.disabled = true;
          return;
        }
        const approved = [];
        const rejected = [];
        for (let i = 0; i < items.length; i++) {
          if (chosen.indexOf(i) !== -1) approved.push(items[i]);
          else rejected.push(items[i]);
        }
        finish({ approved: approved, rejected: rejected, cancelled: false });
      }

      function onReviewKeyDown(event) {
        if (event.key === "Escape") {
          block(event);
          cancel();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          block(event);
          approve();
        }
      }

      reviewShadow.getElementById("review-close").addEventListener("click", cancel);
      reviewShadow.getElementById("review-reject").addEventListener("click", cancel);
      reviewShadow.getElementById("review-select-all").addEventListener("click", function () {
        for (let i = 0; i < checkboxes.length; i++) checkboxes[i].checked = true;
        updateApproveState();
      });
      approveBtn.addEventListener("click", approve);
      backdrop.addEventListener("click", function (event) {
        if (event.target === backdrop) cancel();
      });
      window.addEventListener("keydown", onReviewKeyDown, true);

      reviewSession = { host: reviewHost, cancel: cancel };
      (document.body || document.documentElement).appendChild(reviewHost);
      window.requestAnimationFrame(function () {
        const panel = reviewShadow.querySelector(".review");
        if (panel && typeof panel.focus === "function") panel.focus();
      });
    });
  }

  function stop(wakeExit) {
    if (stopped) return;
    stopped = true;
    picking = false;
    panelOpen = false;
    pending = null;
    hideHighlight();
    panel.hidden = true;
    busy = false;
    writeBusy(false);
    clearQuestion();
    statusEl.classList.remove("busy");
    toolbar.removeAttribute("aria-busy");
    if (wakeExit) wake("exit");
    if (host.parentNode) host.parentNode.removeChild(host);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", hideHighlight, true);
    window.removeEventListener("resize", onViewportChange, true);
    notifyWaiters();
    if (reviewSession) reviewSession.cancel();
  }

  // ------------------------------------------------------------ handlers

  function isOverlayEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.indexOf(host) !== -1 || event.target === host) return true;
    if (reviewSession && reviewSession.host) {
      return path.indexOf(reviewSession.host) !== -1 || event.target === reviewSession.host;
    }
    return false;
  }

  function block(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  }

  function onPointerDown(event) {
    if (stopped || busy || !picking || isOverlayEvent(event)) return;
    block(event);
    if (panelOpen) return;
    const element = event.target;
    if (!(element instanceof Element)) return;
    openPanel(element);
  }

  function onClick(event) {
    if (stopped || busy || !picking || isOverlayEvent(event)) return;
    block(event);
  }

  function onMouseMove(event) {
    if (stopped || busy || !picking || panelOpen || isOverlayEvent(event)) return;
    const element = event.target;
    if (!(element instanceof Element)) {
      hideHighlight();
      return;
    }
    const tag = element.tagName;
    if (tag === "HTML" || tag === "BODY") {
      hideHighlight();
      return;
    }
    showHighlight(element);
  }

  function onKeyDown(event) {
    if (stopped) return;
    if (event.key === "Escape") {
      if (question) {
        block(event);
        answerQuestion(null, true);
      } else if (panelOpen) {
        closePanel();
      } else if (picking) {
        deactivate();
      }
      return;
    }
    if (
      !busy &&
      panelOpen &&
      (event.ctrlKey || event.metaKey) &&
      event.key === "Enter"
    ) {
      event.preventDefault();
      submit();
    }
  }

  function onViewportChange() {
    hideHighlight();
    if (panelOpen && pending) {
      positionPanel(pending.element.getBoundingClientRect());
    }
  }

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", hideHighlight, true);
  window.addEventListener("resize", onViewportChange, true);

  pickBtn.addEventListener("click", function () {
    if (busy) return;
    if (picking) deactivate();
    else activate();
  });
  copyBtn.addEventListener("click", copyLast);
  exitBtn.addEventListener("click", function () {
    stop(true);
  });
  shadow.getElementById("close").addEventListener("click", closePanel);
  shadow.getElementById("cancel").addEventListener("click", closePanel);
  shadow.getElementById("submit").addEventListener("click", submit);
  questionCancel.addEventListener("click", function () {
    answerQuestion(null, true);
  });

  // ---------------------------------------------------------------- boot

  busy = readBusy() || !!readReply();
  question = readQuestion();
  if (question) busy = true;

  (document.body || document.documentElement).appendChild(host);

  window.__uiPromptPicker = {
    activate: activate,
    deactivate: deactivate,
    drain: drain,
    drainReply: drainReply,
    waitForPrompt: waitForPrompt,
    notifyIdle: notifyIdle,
    notify: notify,
    ask: ask,
    setWake: setWake,
    reviewDeltas: reviewDeltas,
    stop: stop,
    get active() {
      return picking;
    },
    get stopped() {
      return stopped;
    },
    get busy() {
      return busy;
    },
    get queue() {
      return readQueue();
    },
  };

  if (busy || question) {
    setBusy(true);
    renderQuestion();
  } else {
    activate();
  }
  return "active";
})();
