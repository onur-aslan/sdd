# SDD Studio

`sdd studio` is the local web dashboard for SDD's autonomous workflows. It drives the same `bug-sweep`, `enhancement`, `deep-spec`, and `merge` workflows as the CLI, but shows the queue, the conversation, and the run in one place so you do not have to remember flags or watch a terminal.

The server is dependency-free and binds to `127.0.0.1` by default. The dashboard is a static page served from this package; there is no build step.

## Quick start

```bash
sdd studio
```

The browser opens automatically when the terminal is interactive.

| Option | Meaning |
| --- | --- |
| `--port <n>` | Port to listen on (default `4321`) |
| `--host <addr>` | Interface to bind (default `127.0.0.1`, local only) |
| `--no-open` | Print the URL without opening a browser |

Without a global install, run it through npx:

```bash
npx @onuraslan/sdd@latest studio
```

On Windows, double-click **`start-studio.cmd`** in the repository. From a checkout, `npm run studio` starts the same thing. The dashboard always manages the project in the directory where the command runs.

**Offline install.** The package has no runtime dependencies. On a connected machine run `npm pack`, copy the `.tgz` in, and install it globally (`npm install -g ./onuraslan-sdd-<version>.tgz`); or clone the repository and run `node bin/sdd.js ...`. The agent is whatever local model runner you have, for example `--agent-cmd '["ollama","run","qwen2.5-coder"]'`.

## The workbench

The interface follows the **Technical Paper** design documented in [DESIGN.md](../DESIGN.md) and [PRODUCT.md](../PRODUCT.md): a light workbench for reading, and a dark inset for raw machine output. The run is the center of the page; configuration lives in a **Settings** drawer available from every tab.

The screen is meant to be used without thinking about settings: **pick the bugs, press Start.** Everything else is either detected at run time or remembered from the last choice. The rail footer summarizes the configured tracker targets (Jira, GitHub, GitLab); the connections and their checks live in **Settings**.

## Bug sweeps

### The queue

Pick a bug source (**Jira**, **GitHub**, or **GitLab**) and a project or repository, and the dashboard loads the open bugs into a multi-select list. Every bug is checked by default; uncheck the ones to leave for later. The selection is sent to `sdd bug-sweep` as `--issues`, so no JQL has to be written.

The source selector only changes which target the queue loads. **Settings** keeps the Jira project, GitHub repository, and GitLab project available at all times, because the enhancement and feature **Start from** pickers use them independently of the bug sweep.

The plan under the queue spells out the scope, branch, tag, base, verify command, and publish behavior that will be used:

| Behavior | Default |
| --- | --- |
| Branch | `bug-fix/<date>` |
| Tag | `bug-fix-<date>` |
| Base | Detected from `origin/HEAD`, then `main` or `master` |
| Agent | Claude Code (`claude -p`) |
| Verify command | Detected from `package.json` |
| Per-bug timeout | 1800 seconds |

Dates, branch, tag, work directory, turn limit, and timeout are computed at run time and are not shown as fields.

### The run

Each bug gets a fresh agent session, so a previous fix cannot leak into the next one. The agent edits the working tree; the command owns git, the tag, and the pull request. A fix that fails verification or the result contract is reset and recorded as not fixed, and the issue tracker is never modified.

The run view shows each bug moving from pending to running to fixed, not fixed, or flagged for human review, with a progress ruler, the live agent log, **Stop run**, and the merge request link when the run finishes. Changes to authentication, payments, migrations, infrastructure, or CI/CD are force-flagged for review.

Only one run of any kind can execute at a time. A running sweep also holds the same on-disk lock as the CLI, so a scheduled sweep cannot overlap it.

### Publishing

The **Push branch** and **Open merge request** toggles decide where the run stops. With push off, the fixes stay on the local branch; with the merge request off, the branch is pushed without one.

The **Merge request** setting chooses the forge:

- **GitHub (gh)**
- **GitLab (glab)**
- **GitLab (git push, no CLI)** — creates the merge request through git push options
- **Gitea (tea)**
- **Custom command** — a plain shell command or a JSON argv command with `SDD_PR_*` variables

### From the CLI

`sdd bug-sweep` runs the same sweep without the dashboard. The defaults table above applies to both.

```bash
JIRA_BASE_URL=https://your-domain.atlassian.net \
JIRA_EMAIL=you@example.com \
JIRA_API_TOKEN=... \
npx @onuraslan/sdd@latest bug-sweep --project ABC
```

Jira is the default source. Pass `--source github --github-repo owner/repo` or `--source gitlab --gitlab-project group/project` to sweep GitHub or GitLab issues instead; the source is inferred when the repository flag is present.

To fix a hand-picked set instead of every open bug, pass `--issues ABC-1,ABC-2`.

Common options:

```bash
sdd bug-sweep --project ABC \
  --agent-cmd '["claude","-p"]' \
  --verify-cmd "npm test" \
  --max-turns 5 \
  --limit 20
```

`--agent-cmd` accepts a JSON array or a command line, so Claude Code, Cursor, OpenCode, and Codex all work. Use `--dry-run` to see the plan, `--resume` to continue an interrupted sweep, `--retry-failed` to retry bugs a previous run could not fix, and `--no-push` or `--no-pr` to stop before publishing. State, prompts, agent logs, and the generated PR body live in `.bug-fix/`, which the command keeps out of git.

Use `--worktree` to fix bugs in a separate checkout under `.bug-fix/worktrees/`. The branch is created there and shares the same `.git` store, so commits, tags, and pushes behave normally, but your own working tree — including uncommitted changes — is never touched. The checkout starts from the remote-tracking base (`origin/<base>`) when one exists, and `--fetch-base` refreshes it from the remote first. The temporary checkout is kept while bugs are pending so `--resume` can continue, and removed once the sweep publishes. The CLI runs in place unless you pass `--worktree`; the dashboard turns it on by default.

The `bug-sweep` skill reports each outcome through a small JSON contract (`status`, `summary`, `how`, `critical`, `criticalReason`, `evidence`). The generated per-bug task file carries that contract. The skill runs `bug-fix` in a fresh subagent for the fix, then prepares the result as one JSON object. Both skills must be installed where the selected agent discovers skills; `sdd install` includes them.

#### Schedule it nightly

There are two ways to start a sweep at midnight.

**1. Keep the command running (built-in scheduler).**

```bash
sdd bug-sweep --project ABC --at 00:00 --every 1d
```

`--at 00:00` waits for the next midnight, `--every 1d` repeats after each sweep, and `--run-now` starts immediately and then repeats. The process must stay alive, so run it in a terminal, tmux, systemd, or another service manager. Each iteration computes its own date, so the branch, tag, and PR are dated to that night. A failed sweep is logged and the schedule continues; a lock file stops a new run from overlapping a running one.

**2. Let the operating system start a one-shot sweep.**

```bash
# cron (Linux/macOS): every day at 00:00
0 0 * * * cd /path/to/repo && sdd bug-sweep --project ABC >> .bug-fix/cron.log 2>&1
```

```powershell
# Task Scheduler (Windows): every day at 00:00
schtasks /Create /TN "sdd-bug-sweep" /SC DAILY /ST 00:00 /TR "cmd /c cd /d C:\path\to\repo && sdd bug-sweep --project ABC"
```

Keep `JIRA_BASE_URL` and `JIRA_API_TOKEN` in the scheduler's environment or a private env file rather than in the scheduled command line. Add `JIRA_AUTH`, `JIRA_API_VERSION`, and `JIRA_CA_CERT` when the Jira server needs them (see below). Because `--date` is not passed, each run picks up the current date on its own.

#### Air-gapped Jira

Self-hosted Jira Data Center (and most Server installs) differ from Cloud in three ways, and each one has a flag:

| Situation | What to use |
| --- | --- |
| Personal access token, no email | `--jira-auth bearer` (the default when `--jira-email` is absent) |
| REST API v2 | `--jira-api-version 2` (or leave `auto`; the v3 search falls back to v2) |
| Internal or self-signed CA | `--jira-ca /path/to/ca.pem` |
| Last resort | `--jira-insecure` (disables TLS verification; avoid in production) |

```bash
JIRA_BASE_URL=https://jira.internal \
JIRA_API_TOKEN=... \
sdd bug-sweep --project ABC \
  --jira-auth bearer \
  --jira-api-version 2 \
  --jira-ca /etc/ssl/jira-ca.pem
```

Run the connectivity check first. It separates DNS, TCP, TLS, and HTTP failures and prints the fix for each:

```bash
sdd jira-check --project ABC
sdd jira-check --project ABC --json
```

`jira-check` exits non-zero when the connection or credentials fail, so it can gate a scheduled run.

`--jira-ca` applies to every Jira request. This avoids relying on `NODE_EXTRA_CA_CERTS`, which must be set before Node starts and is easy to miss in a scheduler.

#### Internal Git instead of GitHub

`--pr` uses the GitHub CLI by default. On GitLab, Gitea, or Bitbucket, pass `--pr-cmd`. A plain command runs through the shell and reads `SDD_PR_TITLE`, `SDD_PR_BODY`, `SDD_PR_BODY_FILE`, `SDD_PR_BASE`, `SDD_PR_HEAD`, and `SDD_PR_REMOTE`:

```bash
sdd bug-sweep --project ABC \
  --pr-cmd 'glab mr create --title "$SDD_PR_TITLE" --description "$(cat $SDD_PR_BODY_FILE)" --source-branch "$SDD_PR_HEAD" --target-branch "$SDD_PR_BASE"'
```

A JSON array runs without a shell, so the same value works on Windows and POSIX. It supports `{title}`, `{body}`, `{bodyFile}`, `{base}`, `{head}`, `{remote}`, `{project}`, and `{date}`, and must print the merge request URL.

GitLab can also create the merge request without any extra CLI: `--gitlab-push` attaches `merge_request.create`, `target`, `title`, and `description` as git push options, and the URL is read from the `remote:` lines that GitLab prints back. The server must advertise push-options support (GitLab does by default; Gitea and Forgejo do not). Pick it when `glab` is not installed on the air-gapped machine:

```bash
sdd bug-sweep --project ABC --pr --gitlab-push --base main
```

For a fully disconnected run, use `--no-push --no-pr`: the sweep still commits each fix locally and writes the report to `.bug-fix/`.

## Enhancement and Feature

Both tabs run a guided interview as a conversation. Describe the change, and the agent asks one question at a time; type the answer in the composer and press **Send**. Nothing parses the agent's prose, so the only question on screen is the one you answer.

- An **enhancement** ends with a plan in the conversation. Approving it starts a bounded implementation-and-verification loop in the same session (five attempts), and **Finish** closes it at the report.
- A **feature** ends when the agent writes `docs/sdd/features/<feature>/spec.md`. The transcript stays on screen and a **Spec ready** plate replaces the composer.

A session may read the repository to ground its questions. A feature session may write exactly one file, its spec. An enhancement may not create, modify, or delete anything before the plan is approved; after approval it changes only what the plan names and never commits, pushes, or opens a merge request.

The **Create a branch, commit, and open a merge request** toggle lets the studio publish the session result when it finishes. It is on by default and follows the **Push branch** and **Open merge request** settings; the agent itself still never commits.

**Stop** ends a session early. The conversation stays readable, and the composer then starts a new one. Reloading the page reconnects to a running session.

### After the feature spec

The **Spec ready** plate asks the two decisions the [feature workflow](../cli/workflows/workflow-feature-development.md) leaves to a human:

1. **Direct implementation** (`sdd-developer`) or **Task-by-task TDD** (`spec-to-task`, then `feature-tdd`).
2. **Run E2E verification?** Checked by default; unchecking adds `--no-verify`.

**Start build** runs the chosen skills one step at a time in the current checkout. Each step is listed with its state, a dark log inset shows the output, and **Stop build** aborts the running step and the chain. A failed step names itself and stops the rest. The build never commits, pushes, or opens a merge request; it stops so you can review the diff. Build state survives a refresh.

## Merge

The **Merge** tab is separate because its safety rules are different. Pick a **Source** and an **Into** branch; the target defaults to the current branch.

- A dirty working tree blocks the start, and the server lists the changed files.
- An integration branch that already exists is refused instead of reused.
- The agent dry-runs the merge, asks only about risky conflicts one at a time in the composer, and commits the result to `merge/<source>-into-<target>`.
- The target is never checked out, modified, or deleted.

With **Claude Code**, a studio-side guard allows edits to conflicted files and read/commit git commands while denying pushes, remotes, `--force`, `reset --hard`, and anything that switches to or rewrites the target. Other agents keep their own permission prompts.

A merge session ends structurally when the integration branch exists, not when the reply says so. A **Land** plate then checks that the target has not moved, switches to it on a clean tree, and fast-forwards with `git merge --ff-only`. Landing never pushes and never creates a merge commit. It is refused if the target advanced, and the previous branch is restored if the switch fails.

## Settings

### Where settings live

The choices are saved as they change to a git-ignored `.sdd/studio.settings.json` (mode `0600` on POSIX). The directory gets its own `.gitignore`, so the file never appears in `git status`. A `.bug-fix/studio.settings.json` from an older version is moved to the new location on first read.

The Jira token is stored locally but never returned to the browser. The API only reports whether a token is saved; a blank token field keeps the saved one, and **Forget saved** clears it. Environment variables such as `JIRA_BASE_URL` and `JIRA_API_TOKEN` still work as a fallback.

### What is stored

| Setting | Purpose |
| --- | --- |
| Bug source, Jira project, GitHub repository, GitLab project | Where the queue loads bugs and issues |
| Base branch | Blank uses the detected branch |
| Agent, custom agent command | Which coding agent runs the workflow |
| Isolated worktree, Fetch base | Sweep isolation and remote refresh |
| Push branch, Open merge request | Where publishing stops |
| Retry failed bugs | Retries bugs a previous sweep could not fix |
| Merge request preset, custom command | Which forge creates the merge request |
| Jira deployment type, URL, email, token, auth mode, API version, CA, skip TLS | Jira connection |
| Enhancement/Feature issue source | Per-tab tracker choice, saved separately for each |

**Resume last run** is a per-run choice and is not saved. Everything else a human decides is remembered.

Settings opens automatically on the first visit, while the project is still empty.

### Jira

- **Jira Cloud** uses Basic auth with an email and an API token, and REST v3.
- **Jira Data Center / Server** uses a personal access token (Bearer) and REST v2 by default.
- An internal or self-signed CA can be supplied as a PEM path; **Skip TLS verification** is a last resort.
- **Check Jira** probes reachability, TLS, authentication, and the REST version before a run.

The deployment type sets the auth mode and API version together, so the two always match the server.

### Agents

The agent picker offers **Claude Code** (default), **Cursor**, **OpenCode**, **Codex**, **Antigravity**, and **Custom command**. The choice is passed to the workflow through the same `--agent-cmd` mechanism the CLI uses, so a sweep stays agent-agnostic.

The selected skill must already be installed where that agent discovers skills. Studio invokes skills natively — `/skill-name` for Claude Code and Cursor, `$skill-name` for Codex, and OpenCode's `skill` tool — and never embeds a copy of `SKILL.md`. A missing skill fails before the agent starts and names the matching `sdd install --target <agent> --user` command. Custom agents without a native adapter are rejected.

## Sessions and permissions

With **Claude Code**, the studio keeps one process open and streams each answer to its stdin, so the agent keeps its context between turns. Reads are pre-approved; any other tool becomes a `PermissionRequest`, shown as an **Approval** plate inside the conversation with **Allow once** and **Deny**. The agent waits for the answer instead of looking frozen, and a timeout denies safely. The hook is injected as a settings layer on the command line, so your own Claude Code configuration is never edited.

Every other agent uses a replay-per-turn fallback: each turn re-invokes the agent with the brief and the transcript so far. That works with any one-shot CLI. If the agent process dies mid-session, the session fails with that message instead of hanging.

The session reader shows your prompts and the agent's replies; tool calls, read results, and stderr stay out of the conversation. **Rich** renders Markdown — headings, lists, tables, quotes, links, code — and Mermaid diagrams inline. **Raw** shows the reply text for copying. Mermaid 12.2.0 is vendored under `studio/vendor/mermaid/` (MIT), so diagrams work without a CDN or network access.

Transcripts are written to `.bug-fix/enhancements/<session>/`, `.bug-fix/features/<session>/`, and `.bug-fix/merges/<session>/`. A finished session is read back on load.

## Local API

The dashboard is also usable as a small local API. All routes are JSON unless noted.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness and version |
| `GET /api/config` | Workspace, git branch/base, Jira presence, detected defaults, remembered settings |
| `GET /api/settings` / `POST /api/settings` | Read or save the remembered choices (the token is never returned) |
| `POST /api/jira/projects` | List Jira projects for the picker |
| `POST /api/jira/bugs` | List open Jira bugs for a project |
| `POST /api/jira/issues` / `POST /api/jira/issue` | List issues, or read one brief, for the interview tabs |
| `POST /api/jira/health` | Probe Jira reachability, TLS, auth, and REST version |
| `POST /api/github/bugs` | List GitHub issues for a repository |
| `POST /api/github/health` | Probe GitHub CLI authentication |
| `POST /api/gitlab/bugs` | List GitLab issues for a project, in bug form |
| `POST /api/gitlab/issues` / `POST /api/gitlab/issue` | List issues, or read one brief, for the interview tabs |
| `POST /api/gitlab/health` | Probe GitLab CLI authentication |
| `GET /api/sweeps` | List sweep jobs |
| `POST /api/sweeps` | Start a sweep from a JSON request |
| `GET /api/sweeps/:id` | Job snapshot, including events so far |
| `GET /api/sweeps/:id/events` | Live SSE event stream |
| `POST /api/sweeps/:id/cancel` | Abort a running sweep |
| `GET /api/enhancements` / `POST /api/enhancements` | List or start an enhancement session |
| `GET /api/features` / `POST /api/features` | List or start a feature interview |
| `GET /api/merges` / `POST /api/merges` | List or start a merge session |
| `GET /api/<flow>/:id` | Session snapshot, including events so far |
| `GET /api/<flow>/:id/events` | Live SSE event stream for a session |
| `POST /api/<flow>/:id/cancel` | Stop a running session |
| `POST /api/merges/:id/land` | Fast-forward the target onto the finished integration branch |
| `GET /api/features/:id/build` / `POST /api/features/:id/build` | Read the last build, or start the chosen pipeline |
| `GET /api/features/:id/build/events` | Live SSE event stream for the build |
| `POST /api/features/:id/build/cancel` | Stop the running build step |
| `POST /api/jobs/:id/input` | Answer the agent's current question |
| `POST /api/jobs/:id/permission` | Allow or deny the agent's permission request |

`<flow>` is `enhancements`, `features`, or `merges`.

## Safety notes

- The server listens on localhost only by default. Do not expose it to a network.
- The token lives in `.sdd/studio.settings.json`, which is git-ignored and never sent back to the browser.
- Sweeps never force-push and never modify the issue tracker.
- The isolated worktree is on by default, so your own checkout — including uncommitted changes — is never touched.
- Merge landing never pushes and never creates a merge commit.

---

See the [main README](../README.md) for installation, the CLI commands, and the skills.
