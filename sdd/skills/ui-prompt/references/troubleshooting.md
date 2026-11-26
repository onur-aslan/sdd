# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Playwright MCP tools are missing | Not configured in this session | Stop. Offer `claude mcp add playwright npx @playwright/mcp@latest` or the editor's MCP configuration. Never install without approval. |
| `browser_run_code`, `page.addScriptTag`, or download events are unavailable | The MCP build cannot run the auto bridge | Stop and report. Offer the MCP configuration; never install without approval. Use the manual bounded-wait fallback if the page itself works. |
| `node` is not available | The watcher cannot run | Stop and report, or use the manual fallback. Do not add a Playwright polling loop. |
| The browser is not visible or not interactive | The session needs a headed browser | Report the limitation and stop. Do not simulate a selection. |
| The app redirects to login | Session expired | Ask the user to log in once in the Playwright browser; the profile persists. The `load` hook re-injects; run the Step 3 hook once if it does not. |
| The dev server does not start or the port differs | Script, port, or env mismatch | Read `package.json`, the dev-server config, and the env files. Report the blocker instead of guessing a URL. |
| The overlay is not visible | Injection failed or the host was removed | Run the Step 3 hook once and check the returned value. If it is `"missing"`, report it and use the fallback; do not poll. |
| `window.__uiPromptPicker` is `undefined` | Page reloaded or navigated | The `load` hook re-injects and re-arms. If it is still missing, run the Step 3 hook once. |
| `window.__uiPromptPicker.stopped` is `true` | The user pressed Exit | Go to the session's final step. Do not re-inject. |
| `page.addScriptTag` is blocked by CSP | The page's `script-src` forbids inline scripts | Report it; try the manual `browser_evaluate` injection once. Auto-load re-injection will not work; use the manual fallback or ask about a local bridge. |
| The browser cannot read the picker path | Playwright runs in a remote or container browser | Report it; serve the script to the browser or use the `browser_evaluate` fallback. The auto bridge may not be available. |
| Submitting does not wake the agent | The download hook, the session directory, or the watcher is missing | Check the hook, the directory exists, and the watcher is running. Do not add a `drain()` loop; ask the user to submit again or use the manual fallback. |
| The user tries to pick another element while busy | The busy lock is on and pick mode is off | Expected: the overlay shows “Working…”, new selections are blocked, and the app stays navigable. Wait for `notifyIdle()` or press Exit. |
| The busy badge never clears | `notifyIdle()` was not called, or a prompt was abandoned | Call `notifyIdle()`; if the page is alive, `stop()`/new session also clears it. |
| The picker is busy after reload/HMR | The busy lock is persistent and a prompt is still in flight | Expected. Wait for the change to finish; Exit/restart if the agent is gone. |
| A UI question does not open | `ask` is missing on an older picker, the picker is stopped, or the page reloaded | Run the Step 3 hook with `resetBusy = false`; check `stopped`. If the picker is gone, ask in chat. |
| The UI answer does not wake the agent | The download hook or watcher is missing | Check the hook/watcher, call `drainReply()` on the next `continue`, or use the manual fallback. |
| The question disappears on reload | The picker was not re-injected, or an older picker is running | The current picker restores it from `localStorage.__uiPromptQuestion`; re-inject with the hook and do not reset busy. |
| Ctrl+Enter does not wake, but the Submit button does | The browser did not treat the key event as a download gesture | Keep the queue and ask the user to click Submit; no code change is needed. |
| The watcher exits with `timeout` | No wake file within 30 minutes, or downloads are blocked | Check the page. Alive and not stopped: start a new watcher. Gone: finalize. |
| The watcher exits with `64` or a Node error | Missing directory argument, bad path, or Node failure | Read the output, fix the path, and restart. The page and queue are unaffected. |
| A wake file appears but the queue and reply are empty | The payload was already drained or the origin changed | Do not invent a selection. Delete the wake files and start a new watcher, or ask the user to reselect. |
| Wake files appear in `.playwright-mcp` | The MCP browser keeps its own download copy | Delete only `ui-prompt-wake-*.json` at exit; never commit it or delete unrelated artifacts. |
| `sourceHints` is empty | Production build, no source attribute, and no resolver hook | Search by visible text, `data-testid`/`data-test`, route, and component name; if still ambiguous, ask the user. |
| A source hint points into `node_modules` | The hint resolves to library or generated code | Discard it; fall back to name/text search. |
| `window.__uiPromptSourceResolver` throws | The optional project resolver failed | The picker catches it and keeps the selection; ask the project to fix the resolver, then re-inject if needed. |
| The app uses Vue, Angular, or another framework and has no source hints | No generic `data-*` source attribute and no resolver | Use text/route search; no framework-specific code is injected. The project can add a resolver hook for `file:line`. |
| Several components match the search | Ambiguous target | Show at most three candidates with file paths and ask. Never guess. |
| The selector no longer resolves | The DOM changed after an earlier change | Ask the user to reselect; do not force the old element. |
| Clicks do not reach the app | Pick mode is active and intercepts clicks | Call `deactivate()` before Playwright-driven interaction; `activate()` afterwards. While busy, pick mode is off, so app navigation works; `activate()` is a no-op until `notifyIdle()`. |
| The user wants to select inside an iframe | The overlay only listens on the main frame | Explain the limitation; ask the user to change the flow or open the content in the main frame. |
| The overlay reappears after Exit | A reload happened before Step 9, or an older hook is installed | The production hook sets `page.__uiPromptExited` and stops re-injecting; if an older hook is installed, call cleanup and stop. |
| The queue keeps growing | An older picker or another tab bypassed the busy lock | The current picker blocks new prompts while busy. Process the queue FIFO, keep the busy lock, and mention unprocessed items at the end. |
| The agent asks for plan approval for a UI prompt | Old Step 6 behavior | The UI submission is the authorization: plan internally and apply. Ask only for a concrete target/design ambiguity, preferably through `ask(...)`. |
| The browser or page closes | Session gone | Finalize with the session log and any collected evidence; run the delta review in chat. |
| Screenshots appear in `git status` | Artifacts were written inside the repository | Save them in the session temp directory; never commit them. Clean with the project's artifact-cleanup workflow. |
| `reviewDeltas` is undefined | The injected script predates the review API, or the page reloaded | Run the Step 3 hook once; if the page is gone, use the chat fallback. |
| The review UI does not open | The review host was removed, or another dialog traps focus | Check `window.__uiPromptPicker.reviewDeltas`; if the page is alive, run the Step 3 hook and call again; otherwise use chat. |
| The auto bridge is unavailable and the user does not want to configure MCP | No download wake | Use `setWake(false)`, one bounded `waitForPrompt(10000)` per change, and end the turn with “say `continue`.” Drain once on the next message; never poll every 2 seconds. |
| The user closes the review without approving | `cancelled: true`; every item is rejected | Leave the design files unchanged and report the drift. |
| `DESIGN.md` is missing | The project has no locked design baseline | Expected fallback. Continue the session without design-delta governance; do not create `DESIGN.md`, do not stop, and do not ask for `/design-decisions` first. Report the skipped review at exit. |
| `DESIGN.md` exists but is not `status: locked` | No locked design baseline | Read it only as context; continue without design-delta governance. Do not write it or run the review; report the skip at exit. |
| `DESIGN.md` changed during the session | The user ran another design round | Re-read it at exit and drop deltas already covered; never overwrite newer decisions. |
| Layer 2 is inline and `design/pages/` is absent | The project has not split page files | Update the inline Layer 2 decision in `DESIGN.md`; do not create page files unless the project uses them. |
| The delta has no `to_fingerprint` | `check` was not run | Expected. Say so in the report; `apply-design` falls back to version comparison. Never fabricate a hash. |
| An approved delta conflicts with the current `DESIGN.md` | The file changed after the delta was recorded | Stop and ask; do not clobber the newer decision. |
