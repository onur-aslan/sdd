# Auto wake bridge

The default session is fully automatic: the picker never makes the agent poll. A submission or a UI answer writes a tiny download **wake signal**; a persistent Playwright download hook saves it to a session temp directory; a background watcher exits when the file appears, which re-invokes the agent. The payload itself stays in the picker queue; a UI answer stays in the reply store.

This works on an HTTPS app: it is a user-gesture download, not a cross-origin request, so there is no loopback server, CORS, mixed-content, or CSP-connect-src problem.

## 1. Paths and session directory

Resolve the picker path from this skill's directory (`<skill-dir>`, the folder containing `SKILL.md`), absolute and with forward slashes:

```
<skill-dir>/scripts/picker.js
```

Do not hardcode `~/.claude/skills`: the skill can be installed under a Claude plugin cache, `.agents/skills`, `.cursor/skills`, or OpenCode's skills directory. If the environment exposes the skill directory as a variable, use it; otherwise resolve the folder that contains this `SKILL.md`.

Create a session directory under the OS temp directory, outside the repository, and print it with forward slashes:

```bash
node -e "const fs=require('fs'),os=require('os'),path=require('path');const d=path.join(os.tmpdir(),'ui-prompt',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(d,{recursive:true});console.log(d.split(path.sep).join('/'))"
```

Keep that path for the whole session. Never put it inside the project.

## 2. Inject and arm the wake channel

Run this once per session with `browser_run_code`, substituting `<picker-path>` and `<session-dir>`:

```js
async (page) => {
  const picker = "<picker-path>";
  const dir = "<session-dir>";
  const resetBusy = true; // set false when re-arming after navigation
  const inject = async () => {
    if (page.__uiPromptExited) return;
    try {
      await page.addScriptTag({ path: picker });
      await page.evaluate(() => {
        const p = window.__uiPromptPicker;
        if (p && p.setWake) p.setWake(true);
      });
    } catch (error) {
      // The caller reports a missing picker and uses the fallback.
    }
  };

  if (!page.__uiPromptAutoHook) {
    page.__uiPromptAutoHook = true;
    const onLoad = () => {
      if (page.__uiPromptExited) return;
      inject().catch(() => {});
    };
    const onDownload = async (download) => {
      const name = download.suggestedFilename();
      if (!name.startsWith("ui-prompt-wake-")) return;
      if (!name.endsWith(".json")) return;
      if (name.includes("/") || name.includes("\\") || name.includes("..")) return;
      if (name.indexOf("-exit-") !== -1) page.__uiPromptExited = true;
      try {
        await download.saveAs(dir + "/" + name);
      } catch (error) {
        // The watcher timeout is the fallback.
      }
    };
    page.on("load", onLoad);
    page.on("download", onDownload);
    page.__uiPromptCleanup = () => {
      page.off("load", onLoad);
      page.off("download", onDownload);
      page.__uiPromptAutoHook = false;
      page.__uiPromptCleanup = null;
    };
  }

  page.__uiPromptExited = false;
  await inject();
  if (resetBusy) {
    await page.evaluate(() => {
      const p = window.__uiPromptPicker;
      if (p && p.notifyIdle) p.notifyIdle();
    });
  }
  return await page.evaluate(() => {
    const p = window.__uiPromptPicker;
    if (!p) return "missing";
    return p.stopped ? "stopped" : "active";
  });
}
```

Why this shape:

- `page.addScriptTag({ path })` makes Playwright read `picker.js` from disk. The file never enters the model context; the tool call stays small.
- `picker.js` is an IIFE. `addScriptTag` runs it directly. Do not paste its contents.
- The `load` listener re-injects and re-arms after a reload or HMR full refresh. The queue, busy lock, and an open question survive in `localStorage`; the load hook does not reset them.
- `resetBusy` is `true` only for the session-start hook. It calls `notifyIdle()` to clear a stale busy lock/question from an earlier session. When re-arming after a navigation, use `resetBusy = false` so the current lock survives.
- The `download` listener saves only `ui-prompt-wake-*.json`; everything else is ignored. It persists across tool calls. An exit wake sets `page.__uiPromptExited`, so a reload after Exit does not resurrect the picker.
- `page.__uiPromptCleanup` removes both listeners at exit.

If the returned value is `"missing"`, do not silently poll. Report the blocker and use the manual fallback (below).

## 3. Wait without polling

Start the watcher in the background and keep its task id:

```bash
node "<skill-dir>/scripts/wait-for-wake.mjs" "<session-dir>" 1800
```

Use `run_in_background: true`. The process exits `0` as soon as a wake file exists, `2` after 1800 seconds with no wake, and `64` on a usage error. The CLI re-invokes the agent on exit. The watcher polls only the local directory every 200 ms; it does not touch the browser or the model context.

When it completes, delete the wake files first (they are only signals), then drain:

```js
async (page) => await page.evaluate(() => {
  const p = window.__uiPromptPicker;
  return p
    ? { stopped: p.stopped, queue: p.drain(), reply: p.drainReply() }
    : null;
});
```

- `null` — the page or browser is gone. Finalize with the session state and the chat review.
- `{ stopped: true, ... }` — the user pressed Exit. Go to Step 9; do not process the queue or reply.
- `reply` is present — this is an answer to a UI question, not a new prompt. Resume the pending change with its `{ id, choice, cancelled }`; keep the busy lock. If `cancelled`, release with `notifyIdle()` and ask the user to reselect.
- `{ stopped: false, queue: [], reply: null }` — a stale wake or a wake already drained. Start a new watcher; the pre-drain cleanup already removed old files, so do not delete files after the drain.
- `{ stopped: false, queue: [...], reply: null }` — process in order. The queue is the source of truth; the wake file is only a signal.

The wake file contains only `{type, at}` where `type` is `prompt`, `reply`, or `exit`. Never treat it as the payload, and never invent a selection from it.

## 4. After each change

1. Delete the wake files (session directory and matching `.playwright-mcp` files). Clean before draining so a submission that arrives during the drain cannot lose its wake.
2. Drain once and read any reply. If it reports `stopped: true`, go to Step 9.
3. If a reply is present, handle it before new prompts; the busy lock stays.
4. If the queue is non-empty, process it FIFO without starting a watcher; the busy lock stays.
5. If both are empty, call `notifyIdle()` to release the busy lock, then start a new watcher only when the previous one has exited. If this turn came from a chat message while the watcher is still running, keep that watcher.

A prompt is one in flight. While the picker is busy, new selections are blocked and the overlay shows “Working…”, so the queue should not grow. If a queue appears (an older picker or another tab), process it FIFO and keep the lock until it is empty. The next watcher is only for idle time.

### UI questions and replies

Use the picker for a genuine target/source ambiguity instead of falling back to chat:

```js
async (page) => await page.evaluate(() => {
  const p = window.__uiPromptPicker;
  return p
    ? p.ask({
        id: "q-" + Date.now().toString(36),
        title: "Choose the target",
        message: "Which source should this change use?",
        options: [
          { id: "a", label: "SaveButton", detail: "src/components/SaveButton.vue:12" },
          { id: "b", label: "SettingsPage", detail: "src/pages/Settings.vue:88" },
        ],
      })
    : null;
});
```

- `ask()` keeps the busy lock, persists the question, shows a non-modal panel, and returns `{ id }` immediately.
- The user's choice (or cancel/Escape) writes `localStorage.__uiPromptReply` and emits a `reply` wake. It does not clear the busy lock.
- Start or reuse the watcher and end the turn. On the reply wake, `drainReply()` and resume the pending change with `{ id, choice, cancelled }`.
- A reload restores the question and busy lock. `notifyIdle()` clears both; `stop()` clears them and writes the busy flag off.
- In the manual fallback, call `ask()`, end the turn with “Choose an option, then say `continue`”, and call `drainReply()` once on the next message. Never poll.

Clean only our files:

```bash
rm -f "<session-dir>/ui-prompt-wake-"*.json
rm -f .playwright-mcp/ui-prompt-wake-*.json 2>/dev/null || true
```

The MCP browser keeps its own copy in `.playwright-mcp`; it is temporary, must not be committed, and only files with the `ui-prompt-wake-` prefix are ours.

## 5. Exit

The picker's Exit button wakes the agent with an exit signal, so the session ends without a chat message. The download hook also sets `page.__uiPromptExited` on the exit filename; the `load` hook then stops re-injecting, so a reload after Exit does not bring the overlay back. A new session resets the flag in the Step 3 hook.

At Step 9:

```js
async (page) => {
  if (page.__uiPromptCleanup) page.__uiPromptCleanup();
  return "cleaned";
}
```

Then:

- stop the background watcher with `TaskStop` if it is still running;
- call `stop()` (no wake) if the picker is still mounted; `drain()` once for the final report. `stop()` releases the busy lock and clears any pending question;
- delete the session wake files and the matching `.playwright-mcp` files;
- remove the session directory after the report if no artifact is needed;
- run the design-delta review exactly as in the main skill.

If the user says `stop` in chat, do the same; the browser may still be open.

## 6. Failure and fallback

The auto wake is optional infrastructure, not a reason to poll.

| Failure | Response |
|---|---|
| `browser_run_code` or download events are unavailable | Stop and report. Offer the editor's MCP configuration; never install without approval. Fall back to the manual bounded-wait handoff. |
| `page.addScriptTag` is blocked by CSP | Report it. Try the `browser_evaluate` fallback once (read the IIFE file and call it inside a function); auto-load re-injection will not work, so use the manual handoff or ask about a local injection bridge. |
| The browser cannot read the picker path | Playwright runs in a remote or container browser | Report it; serve the script to the browser or use the `browser_evaluate` fallback. The auto bridge may not be available. |
| Downloads are blocked or the hook does not fire | The watcher exits with a timeout. Check the page; if alive, ask the user to submit again or use the manual handoff. Do not add a `drain()` loop. |
| Watcher timeout | Page alive and not stopped: start a new watcher. Page gone: finalize. |
| Watcher exits with `64` or a Node error | Read the output, fix the directory path, and restart. The page and queue are unaffected. |
| Wake file but empty queue and reply | The payload was already drained or the origin changed. Do not invent it; start a new watcher or ask the user to reselect. |
| The UI question does not open | `ask` is missing (older picker), the picker is stopped, or the page reloaded | Re-inject with `resetBusy = false`; check `stopped`. If the picker is gone, ask in chat. |
| The answer does not wake the agent | The download hook or watcher is missing, or downloads are blocked | Check the hook and watcher; call `drainReply()` on the next `continue`; use the manual fallback. |
| The picker is still busy after work finished | `notifyIdle()` was not called | Call `notifyIdle()`; if the page is gone, `stop()` or a new session clears it. |
| The picker is busy after a reload | Expected: a prompt is still in flight and the lock is persistent | Wait for the agent to finish, or press Exit and start a new session. |
| Browser or page closed | The watcher times out; finalize with the session state and chat review. |
| Original wake file in `.playwright-mcp` | Delete only `ui-prompt-wake-*.json`; never commit it and never delete unrelated artifacts. |

### Manual fallback (no auto wake)

- Call `window.__uiPromptPicker.setWake(false)`.
- After each change, call one bounded `waitForPrompt(10000)`. If it returns a queue, process it; if it returns empty, end the turn with: “Select element(s), submit, then say `continue` in chat.”
- For a UI question, call `ask(...)`, end the turn with “Choose an option, then say `continue`”, and call `drainReply()` once on the next message. The question and reply still live in the picker; only the wake is missing.
- On the next user message, call `drain()` once. Do not loop and do not use the 2-second fallback.
- This keeps the context cost to at most one empty call per change and never polls while idle.

## 7. Security and privacy

- No server, no listening socket, no loopback request, no CORS changes.
- The wake file carries only type (`prompt`, `reply`, or `exit`) and timestamp; the prompt, text, selectors, computed styles, question, and answer stay in origin-scoped `localStorage` until `drain()`/`drainReply()` or `notifyIdle()`.
- The queue and reply store are origin-scoped `localStorage`; they are not written to the project.
- Downloads are triggered by the user's Submit/Exit gesture. Temporary files live under the OS temp directory and `.playwright-mcp`; clean both.
- Never target production.
