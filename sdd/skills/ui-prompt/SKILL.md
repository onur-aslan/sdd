---
name: ui-prompt
description: Runs a persistent, event-driven UI change session against the running frontend. Opens the app through Playwright, injects a picker overlay, and turns each clicked element plus typed prompt into a source-level change that is resolved, planned, applied, and verified. Submissions wake the agent through a tiny download signal and a background watcher, so the session stays idle without Playwright polling; when a locked DESIGN.md exists, design deltas are recorded and reviewed in the overlay at exit. The session continues until the user presses Exit in the overlay or asks to stop. Triggers - ui prompt, select element, change this element, visual change. Never guess which element or source file the user means.
disable-model-invocation: true
---

# ui-prompt

The agent does not guess what "this element" means; the user points at it in the running app. This skill opens the frontend, injects a picker overlay, and runs a continuous loop: element + prompt → source → applied change → verified result → listen again. The wait is event-driven: a submission emits a tiny download wake, a background watcher exits, and the CLI re-invokes the agent. There is no Playwright polling while idle. The session ends only when the user exits.

## The session

One invocation starts one session. The picker stays mounted and every submitted element + prompt is processed. Finishing a change never ends the session; only an explicit exit does:

- the **Exit** button in the overlay,
- the user saying stop in chat,
- the browser or page closing,
- an unrecoverable blocker reported by this skill.

When a locked `DESIGN.md` exists, a request that diverges from a design decision is recorded as a delta and continues; the exit review approves or rejects it. Without one, the session runs without design-delta governance. The session never stops for `design-decisions`.

A submission from the picker is the authorization for the code change: the agent plans internally and applies it without asking for plan approval. While a prompt is being processed, the picker is **busy**: new selections are blocked, the overlay shows a generic “Working…” status, and pick mode is off so the app stays navigable. `notifyIdle()` releases the lock after a verified change, or when the agent abandons the prompt and asks the user to reselect. If the target or source is genuinely ambiguous, ask from the picker (Step 5); that is a clarification, not a plan approval. In the default auto mode the user never has to type `continue`.

## Invocation

`/ui-prompt [url-or-route] [session context]` — free-text arguments:

- **None** — open the app's dev URL and start listening.
- **A URL or route** — navigate there first, then start listening.
- **Other text** — session context (for example `mobile pass`, `only the chat screen`); it does not replace selecting an element.
- **`stop`** — end the session, same as the overlay's Exit.

`<skill-dir>` is the folder containing this `SKILL.md`; all `scripts/` and `references/` paths are relative to it.

## Step 1 — Preflight

- Playwright MCP must support navigation, evaluate, `browser_run_code`, snapshot, screenshot, and download events. The auto bridge needs `page.addScriptTag({ path })` and `page.on("download")`. If the browser tools are missing, stop and report. If the browser works but auto wake support is missing, report it and use the manual bounded-wait fallback in `references/auto-bridge.md`. Offer the editor's MCP configuration; never install or configure anything without approval.
- Node must be available for the watcher (`node --version`). If it is not, stop and report, or use the manual fallback.
- Read the project's `CLAUDE.md` / `AGENTS.md`; read any `DESIGN.md`, `design/pages/*.md`, and design-system master that exist. Project instructions always bind. A `DESIGN.md` with `status: locked` also binds and enables the design-delta workflow. If it is missing or not locked, do not stop and do not ask the user to run `/design-decisions` first: run the session without design-delta governance, never create `DESIGN.md`, and mention the skipped review once in the final report.
- Detect the frontend's dev script, URL/port, and whether a backend is required. Read only the environment values needed for the URL and API base; never print secrets.
- Create one session temp directory outside the repository and keep its absolute path with forward slashes (`references/auto-bridge.md`). Wake files go there; screenshots go there when the screenshot tool allows an absolute path, otherwise they land in the MCP output directory. Never put either in the project. If the context is compacted, recover the path from the background watcher command or the latest wake file; the picker queue and recorded design deltas remain the source of truth.

## Step 2 — Open the app

- Reuse the dev server if its URL already responds; otherwise run the dev script in the background and wait until it is ready. Report the URL.
- If the app needs a backend and it is unreachable, report the blocker and stop. Do not start databases or backends silently.
- Navigate with Playwright and keep the browser visible. If login is required, ask the user to log in once; the profile persists across sessions. Wait for the target screen to render.
- If the arguments name a URL or route, navigate there first.

## Step 3 — Inject the picker

- Run the hook in `references/auto-bridge.md` with `browser_run_code`, using `resetBusy = true` at session start. It calls `page.addScriptTag({ path: "<skill-dir>/scripts/picker.js" })`, calls `setWake(true)`, installs a persistent `load` hook that re-injects and re-arms after a reload or navigation, and a `download` hook that saves `ui-prompt-wake-*.json` to the session temp directory.
- Do not read `picker.js` into context and do not pass its full contents to `browser_evaluate`. The file is an IIFE; Playwright reads it from disk. Read it only for the manual fallback.
- The hook returns `active`, `stopped`, or `missing`. On `stopped`, go straight to Step 9. On `missing`, report it and use the fallback in `references/auto-bridge.md`; do not silently poll.
- Source hints are framework-neutral: source `data-*` attributes on the element or an optional `window.__uiPromptSourceResolver` hook. No framework-specific adapter is injected; without hints the source is found by search.
- Tell the user in one line: hover an element, click it, type the change, then Ctrl+Enter; submissions reach the agent automatically and **Exit** ends the session. While a prompt is being processed, the overlay shows “Working…”, pick mode is off, and the app can still be navigated; wait for the picker to return. To change page, use the address bar or the app navigation. The overlay is injected at runtime and is never written into the project.
- While picking is active, app clicks are intercepted. Call `window.__uiPromptPicker.deactivate()` before any Playwright-driven interaction with the app, and `activate()` again when the user wants to pick more. When the picker is busy, `activate()` is a no-op.

## Step 4 — Wait for the next submission or reply

- Start the watcher in the background and keep its task id:

  `node "<skill-dir>/scripts/wait-for-wake.mjs" "<session-dir>" 1800`

  Then end the turn. Do not call `waitForPrompt` in a loop and do not poll `drain()` while idle. If a chat message re-invokes you while the watcher is still running, handle it and keep that watcher; do not start a second one. If the message is `continue` (habit or a missed wake), drain once and continue. If the user says stop, go to Step 9.
- When the watcher completes, delete the wake files first (the queue is the source of truth), then drain once with `browser_evaluate` (or the `browser_run_code` form in `references/auto-bridge.md`):

  `() => window.__uiPromptPicker ? { stopped: window.__uiPromptPicker.stopped, queue: window.__uiPromptPicker.drain(), reply: window.__uiPromptPicker.drainReply() } : null`

- `null` — the page or browser is gone. Finalize with the session state and the chat review.
- `{ stopped: true, ... }` — the user exited. Keep the queue and reply for the final report and go to Step 9.
- `reply` present — resume the pending prompt: the reply is `{ id, choice, cancelled }`. If `cancelled` is true, release the busy lock with `notifyIdle()` and ask the user to reselect. Otherwise use `choice` to resolve the pending target and continue. Do not treat the reply as a new prompt.
- `{ stopped: false, queue: [...], reply: null }` — process the submissions in order. Keep any remaining items in order; they are cleared from the page queue. The busy lock is already set.
- `{ stopped: false, queue: [], reply: null }` — a stale wake or a wake already drained. Start a new watcher; the pre-drain cleanup already removed old files, so do not delete files after the drain.
- The watcher exits `0` on a wake and `2` on a 30-minute timeout. On timeout, check the page: if it is alive and not stopped, start a new watcher; if it is gone, finalize. This is one check per window, not polling.
- If the API is `undefined` after a navigation, the `load` hook has not fired yet. Run the Step 3 hook once with `resetBusy = false`; do not read and re-inject the file by hand. If it still fails, use the fallback.
- If the auto bridge is unavailable, use the manual fallback: `setWake(false)`, one bounded `waitForPrompt(10000)`, then end the turn with “Select element(s), submit, then say `continue` in chat.” For a UI question, call `ask(...)`, end the turn with “Choose an option, then say `continue`”, and on the next message call `drainReply()` once. Never use a 2-second polling loop.
- The wake file contains only `{ type, at }`; `type` is `prompt`, `reply`, or `exit`. It is a signal, not the payload; the queue and reply store are the source of truth.

## Step 5 — Resolve the target

- For each submission, open the first `sourceHints` entry that points at application source: not `node_modules`, and preferably under the project's source root. If only a name is present, search by that name and the visible text.
- Read the component and the styles or theme it uses.
- If no usable hint exists, or the file is ambiguous, search by visible text, `data-testid`/`data-test`, route, and component name. Show at most three candidates with file paths in the picker instead of chat:
  - `window.__uiPromptPicker.ask({ id, title: "Choose the target", message, options: [{ id, label, detail }] })` where `detail` is the file path or a short hint;
  - start or keep the watcher from Step 4 and end the turn; on the reply wake, call `drainReply()` and resume with the chosen candidate.
  - This is a clarification, not a plan approval. Never guess.
  - If auto wake is unavailable, ask in chat and use the manual reply flow in Step 4.
- If the page changed since a previous change and the selector no longer resolves, call `notifyIdle()` to release the busy lock, then ask the user to reselect in the picker; do not force the old element.

## Step 6 — Plan and act

- If a locked `DESIGN.md` exists, apply its decisions. If the request is not covered, do not stop and do not edit design files: record a delta (decision, from → to, files, evidence), call `window.__uiPromptPicker.notify(...)` with one line, and continue. If a design intent is genuinely ambiguous, use `ask(...)` with the concrete choices; never invent a decision. A choice that can wait may be recorded as a delta with the assumption and left to the exit review.
- Without a locked `DESIGN.md`, apply the project instructions, existing components, and tokens; read any design docs as context, but do not record deltas or treat them as locked.
- A UI submission is the authorization. Plan internally (files, exact change, tokens or existing components reused, verification) and apply it without asking for plan approval. Do not ask “shall I apply?”.
- If the prompt is materially ambiguous, or would change something outside the selected element's scope, ask a concrete clarification (prefer `ask(...)` over chat); that is not a plan approval. If the scope changes materially after a clarification, explain the change and proceed under the same authorization.

## Step 7 — Implement

- Apply the smallest change that satisfies the planned change.
- Reuse existing components and theme tokens; no ad-hoc colors; follow the project's API and config conventions.
- Let HMR update the page. The `load` hook re-injects and re-arms after a full reload or navigation; if the overlay is absent, run the Step 3 hook once.

## Step 8 — Verify, record, listen again

- Take before/after screenshots of the affected area. Save them in the session temp directory or the MCP output directory; never commit them. If they land in `.playwright-mcp`, treat that directory as an artifact.
- Check computed styles when relevant; check both themes when the app supports them and color changes; resize to a mobile viewport when layout changes; take an accessibility snapshot when semantics change.
- Run only existing project checks that are relevant (lint, build, tests); never create checks. If a baseline check already fails, report it instead of silently "fixing" it.
- Retry within a bounded budget (default 5 attempts). On exhaustion, report honestly and leave the app working or revert the change. If you continue listening, call `notifyIdle()` to release the busy lock; if you end the session, go to Step 9.
- Keep a short per-change record in the conversation: element, prompt, files, evidence, result, any question/reply, and any recorded design delta.
- Delete the wake files (`<session-dir>/ui-prompt-wake-*.json` and matching `.playwright-mcp` files), then drain once:

  `() => window.__uiPromptPicker ? { stopped: window.__uiPromptPicker.stopped, queue: window.__uiPromptPicker.drain(), reply: window.__uiPromptPicker.drainReply() } : null`

- If `stopped: true`, go to Step 9.
- If `reply` is present, handle it before new prompts; keep the busy lock.
- If the queue is non-empty, process it FIFO without starting a watcher; keep the busy lock.
- If both are empty, call `window.__uiPromptPicker.notifyIdle()` to release the busy lock, then start a new watcher only when the previous one has exited (a completion consumed it). If this turn was triggered by a chat message while the watcher is still running, keep that watcher and end the turn. Cleaning before the drain avoids deleting a wake for a submission that arrives during the drain.
- A verified change that leaves no queue or reply MUST call `notifyIdle()`. If you abandon a prompt, or ask the user to reselect, call it too; otherwise the picker stays busy.

## Step 9 — End the session

- Call `page.__uiPromptCleanup()` through `browser_run_code` to remove the `load` and `download` hooks. Stop the background watcher with `TaskStop` if it is still running.
- If the picker is still mounted, call `window.__uiPromptPicker.stop()`, then `drain()` once to collect and clear any prompts submitted while you were working. `stop()` releases the busy lock and clears any pending question. Do not kill the dev server unless the user asks.
- Delete the session wake files and the matching `.playwright-mcp` files; remove the session temp directory after the report if no artifact is needed. Never delete unrelated artifacts or commit temporary files.
- If no locked `DESIGN.md` exists, skip the design re-read, delta consolidation, drift scan, review, design-file writes, and delta file; report that the design-delta review was skipped.
- With a locked `DESIGN.md`, re-read it and any `design/pages/*.md`; consolidate the session's design deltas, reconcile them with the latest design, and run the final drift scan on the changed files (`references/design-deltas.md`).
- With a locked `DESIGN.md`, if deltas remain and the page is alive, call `window.__uiPromptPicker.reviewDeltas(deltas)` and wait for the per-item result. If the page is gone, present the same list in chat.
- With a locked `DESIGN.md`, write only approved deltas: update `DESIGN.md` / the page file / the Tokens block, bump the version, add the changelog row, emit `design/deltas/delta-ui-prompt-<timestamp>.json`, and sync the project's theme tokens. Follow `references/design-deltas.md`.
- With a locked `DESIGN.md`, rejected deltas leave the design files unchanged; list them as unresolved design drift and offer a revert; never revert silently.
- Report every change in the session in order: element + prompt, files changed, evidence, checks run, and the result. Include approved/rejected deltas and updated design files/version when the review ran; otherwise state that it was skipped. Include unresolved drift and any queued prompts that were not processed.
- Note that temporary Playwright artifacts must not be committed; clean them with the project's artifact-cleanup workflow if one exists.

## Picker contract

`scripts/picker.js` exposes `window.__uiPromptPicker`:

- `setWake(enabled)` — arms or disarms the download wake; the auto bridge calls `setWake(true)`, the manual fallback `false`.
- `drain()` — returns and clears the queue; sets the busy lock when non-empty. Called on a wake, never in an idle loop.
- `drainReply()` — returns and clears the one pending UI answer `{ id, choice, cancelled, at }`, or `null`.
- `waitForPrompt(ms)` — optional bounded wait for the manual fallback only; drains the queue and sets the busy lock.
- `ask(question)` — opens a picker question (`{ id, title, message, options: [{ id, label, detail }] }`), persists it across reloads, sets the busy lock, and returns `{ id }`. The answer writes a reply and a reply wake; it is not a plan approval.
- `activate()` / `deactivate()` — toggles pick mode. `activate()` is a no-op while busy; busy leaves pick mode off so the app stays navigable.
- `notifyIdle()` — releases the busy lock, clears any pending question/reply, and re-arms pick mode after a verified change or an abandoned prompt.
- `notify(message)` — shows a short line in the overlay toast; while busy it does not replace the working status.
- `stop(wakeExit?)` — ends the session; clears the busy lock and pending question; `stop(true)` also emits an exit wake, `stop()` is silent.
- `reviewDeltas(deltas)` — exit review UI; promise resolving `{ approved, rejected, cancelled }`. Works after `stop()`; nothing is preselected.
- `stopped`, `active`, `busy`, and `queue` getters.

Injection is `page.addScriptTag({ path })`; the wake signal is a tiny download, and the queue/reply store is the source of truth. Payload fields, queue semantics, question/reply semantics, source-resolution rules, and the bridge: `references/picker-contract.md`, `references/auto-bridge.md`.

## When the overlay is lost

- **Reload or navigation** — the `load` hook re-injects and re-arms automatically; the busy lock and an open question are restored from storage. If the API is still gone, run the Step 3 hook once with `resetBusy = false`; do not poll.
- **The user pressed Exit** — the picker stops, emits an exit wake, and the API remains with `stopped: true`. Go to Step 9.
- **The page or browser closed** — the watcher times out; finalize with the session state and run the same delta review in chat when a locked `DESIGN.md` exists; otherwise skip it.
- **Login expired** — ask the user to log in again; the `load` hook injects on the new page, and the Step 3 hook re-arms it if needed.
- **The hook is missing** — reinstall it from `references/auto-bridge.md`; do not fall back to a polling loop.

## Never

- Target production.
- Poll `waitForPrompt` or `drain` in a loop while idle, or use the removed 2-second fallback.
- Read `picker.js` into context on every injection; pass its path to `page.addScriptTag`.
- Edit design files mid-session; only the approved exit review writes them.
- Create or initialize `DESIGN.md`; this skill applies existing design decisions, it does not establish them.
- Add picker code or temporary files to the project.
- Install Playwright or other tools without explicit approval.
- Read or print secrets.
- Guess a design decision, a component, or a source file.
- Ask for plan approval for a UI submission; the submission is the authorization. Ask only for a concrete ambiguity.
- End the session on your own.
