# Picker contract

`scripts/picker.js` is a self-contained IIFE injected through Playwright. It mounts a shadow-DOM overlay and exposes `window.__uiPromptPicker`. The overlay is never written into the project.

## Injection

- The default injection is path-based: `page.addScriptTag({ path })` through `browser_run_code`. Playwright reads the file from disk, so its contents never enter the model context. Keep the IIFE wrapper.
- Manual fallback only: read the file and put its full text inside a function passed to `browser_evaluate`, for example `() => { <file text> }`. Keep the file's own IIFE call intact.
- A fresh injection returns `"active"`. If a persisted busy lock or question is restored, the overlay mounts in busy mode (pick mode off) until `notifyIdle()`.
- If an active session exists, a direct injection re-activates it and returns `"already-active"`. The auto-bridge hook reports `"active"` after re-arming an existing session.
- If the previous session was stopped, injection starts a new session and replaces the API object.
- Host element: `#__ui-prompt-host`, attached to `document.body` (or `document.documentElement`).
- The exit review uses a second host, `#__ui-prompt-review-host`; re-injection removes a stale one.

## API

| Member | Behavior |
|---|---|
| `setWake(enabled)` | Arms or disarms the download wake. The auto bridge calls `setWake(true)`; the manual fallback calls `setWake(false)`. Returns the new state. |
| `waitForPrompt(ms)` | Optional bounded wait for the manual fallback only. Promise resolving `{ stopped, queue }`. When the session is live and the queue has items, drains the queue and sets the busy lock. On timeout resolves `{ stopped: false, queue: [] }`. When stopped, drains and returns the remaining queue with `stopped: true`. |
| `drain()` | Returns and clears the queue; sets the busy lock when non-empty. Called on a wake, not in an idle polling loop. |
| `drainReply()` | Returns and clears the one pending UI answer `{ id, choice, cancelled, at }`, or `null`. |
| `ask(question)` | Opens a picker question `{ id, title, message, options: [{ id, label, detail }] }`, persists it across reloads, sets the busy lock, and returns `{ id }`. The answer writes a reply and a reply wake; it does not clear the busy lock. |
| `activate()` | Turns pick mode on. App clicks are intercepted while it is on. No-op while busy. |
| `deactivate()` | Turns pick mode off. |
| `notifyIdle()` | Releases the busy lock, clears any pending question/reply, and re-arms pick mode after a verified change or an abandoned prompt. If not busy, resets the status to waiting (pick mode on) or off (pick mode off). |
| `notify(message)` | Shows a short line in the overlay toast; while busy it does not replace the working status. Used for design-delta notices. |
| `stop(wakeExit?)` | Ends the session: releases the busy lock, clears any pending question/reply, removes the host and listeners, keeps the API with `stopped: true`, and resolves pending waits. `stop(true)` also emits an exit wake; `stop()` is silent. |
| `reviewDeltas(deltas)` | Opens the exit review. Works after `stop()`. Resolves `{ approved, rejected, cancelled }` with the delta objects; nothing is preselected; empty input resolves immediately. |
| `active` | `true` while pick mode is on. |
| `busy` | `true` while a submitted prompt is being processed; selection and submit are blocked. |
| `stopped` | `true` after `stop()`. |
| `queue` | Read-only copy of the current queue. |

## Queue

- Stored in `localStorage.__uiPromptQueue` and mirrored on `window.__uiPromptQueue`; survives reloads.
- FIFO, but one prompt is in flight: `submit()` sets the busy lock, and new selections/submissions are blocked until `notifyIdle()` releases it. A queue can still contain items from an older picker or another tab; process it FIFO and keep the lock.
- `drain()` (and the optional `waitForPrompt`) clears the queue and sets the busy lock when non-empty. `stop()` leaves the queue intact; the session's final step collects it with `drain()`.
- The busy lock is stored in `localStorage.__uiPromptBusy`; an open question in `__uiPromptQuestion`; the answer in `__uiPromptReply`. All survive reloads and are cleared by `notifyIdle()`/`stop()` (the queue is cleared by `drain()`).
- The queue/reply store is the source of truth. A wake file is only a signal.

## Wake signal

When `setWake(true)` is active, `submit()`, a UI answer, and `stop(true)` create a tiny download through an anchor inside the overlay's shadow root:

- filename: `ui-prompt-wake-<timestamp>-prompt-<random>.json`, `...-reply-...json`, or `...-exit-...json`;
- body: `{"type":"prompt"|"reply"|"exit","at":"<ISO timestamp>"}` only — no selector, prompt, URL, page data, question, or answer;
- the payload remains in the queue until `drain()`; the answer remains in the reply store until `drainReply()`.

A persistent Playwright `download` hook saves matching files to the session temp directory; `references/auto-bridge.md` starts a background watcher on that directory. The watcher exits when a file appears, which re-invokes the agent. `setWake(false)` disables this for the manual bounded-wait fallback.

The anchor is appended to the shadow root because the picker's document-level click capture would cancel an app-body click while picking.

## Questions and replies

- `ask({ id, title, message, options })` is for a genuine target/source ambiguity, not a plan approval. It normalizes up to six options `{ id, label, detail }` (plain strings are accepted), persists the question in `localStorage.__uiPromptQuestion`, sets the busy lock, and shows a non-modal panel near the toolbar. The app remains navigable while the question is open.
- The answer buttons and the cancel button (or Escape) write `localStorage.__uiPromptReply` as `{ id, choice, cancelled, at }`, hide the question, and emit a `reply` wake. They do not release the busy lock.
- On a reload, the question and busy lock are restored; an answered-but-not-drained reply keeps the lock until the agent drains it.
- `drainReply()` clears the reply. `notifyIdle()` clears both question and reply and releases the lock; `stop()` also clears them.
- The answer is never in the wake file; only the queue/reply store carries it.

## Exit review

Only call this review when a locked `DESIGN.md` exists. Without it, skip the review, the design-file writes, and the delta file.

- `reviewDeltas(deltas)` mounts `#__ui-prompt-review-host` in its own shadow root and returns a promise.
- Each delta is a checkbox. `Approve selected` stays disabled until one is checked; `Select all` only checks the boxes, it does not approve.
- `Reject and close`, the close button, the backdrop, and Escape resolve `cancelled: true` and reject every item.
- The review deactivates pick mode while it is open. A second call cancels the open review and opens a new one.
- If the page is gone, the skill must collect the same approval in chat; never assume approval.

## Payload

```json
{
  "timestamp": "2026-01-01T12:00:00.000Z",
  "url": "http://localhost:5173/settings",
  "selector": "main > section:nth-of-type(2) > button",
  "tag": "button",
  "text": "Save",
  "rect": { "x": 640, "y": 312, "width": 120, "height": 40 },
  "sourceHints": [
    { "name": "SaveButton", "file": "/src/components/SaveButton.vue", "line": 12, "column": 4, "via": "data-v-inspector" },
    { "name": "SettingsPage", "file": "/src/pages/Settings.vue", "line": 88, "column": 2, "via": "data-v-inspector" }
  ],
  "computed": {
    "display": "inline-flex",
    "color": "rgb(255, 255, 255)",
    "backgroundColor": "rgb(21, 128, 61)",
    "fontFamily": "Inter, sans-serif",
    "fontSize": "14px",
    "borderRadius": "8px"
  },
  "prompt": "Make this the primary action and full width on mobile."
}
```

| Field | Meaning |
|---|---|
| `timestamp` | When the user submitted. |
| `url` | Page URL at submission time. |
| `selector` | Best-effort CSS path: id, `data-testid`/`data-test`, otherwise tag + `:nth-of-type` up to six ancestors. Class names are not used; generated or hashed names are unstable. |
| `tag` | Lowercase tag name. |
| `text` | Visible text, whitespace-collapsed, truncated to 200 characters. |
| `rect` | Viewport rectangle at submission time. |
| `sourceHints` | Framework-neutral source hints: resolver hints first, then nearest-first DOM attribute hints. `file`/`line`/`column` may be null on a name-only hint. |
| `computed` | Subset of computed styles for the selected element. |
| `prompt` | The user's typed change request. |

## Source hints

`sourceHints` is framework-neutral. Resolver hints come first; DOM attribute hints follow from the element upward. It is built from:

- an optional synchronous `window.__uiPromptSourceResolver(element)` function, which may return a hint object, an array of hints, or a `file:line:column` string;
- source attributes on the element or up to five ancestors: `data-v-inspector`, `data-source`, `data-source-file`, `data-file`, `data-file-path`, `data-component-file`, `data-loc`, `data-location`, `data-origin`, `data-inspector`;
- name attributes: `data-component`, `data-component-name`, `data-name`.

A value may be `path:line:column`, `path:line`, a URL, `file:///...`, or JSON `{file,line,column}`. `node_modules` paths are discarded. Choose the first hint that points at application source and open it at `line`.

If only names are available, search by name and visible text. If there are no hints, search by visible text, `data-testid`/`data-test`, route, and component name. Show at most three candidates with file paths through `ask(...)`; this is a clarification, not a plan approval.

The resolver is optional. It runs on hover and selection, so it must be synchronous, cheap, and must not throw. Example (installed by the project, not by this skill):

```js
window.__uiPromptSourceResolver = (element) => {
  // return { name, file, line, column }, an array, or "file:line:column"
  return null;
};
```

- If the selector no longer resolves after an earlier change, ask the user to reselect. Never guess.

## Limitations

- The overlay listens on the main frame's document; elements inside iframes are not selectable.
- Source hints exist only when the app or a dev plugin exposes them; production builds usually expose none.
- A hint that points into `node_modules` or a generated file is ignored.
- The selector is a convenience, not a stable identity; always re-verify it before reusing a payload.
