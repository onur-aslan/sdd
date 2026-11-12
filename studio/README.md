# SDD Studio

`sdd studio` is the local web dashboard for SDD's autonomous workflows. It drives the same `bug-sweep`, `enhancement`, `deep-spec`, `spec-issue`, and `merge` workflows as the CLI, but shows the queue, the conversation, the worktree, and the run in one place so you do not have to remember flags or watch a terminal.

Every session runs on one long-lived Claude Code process (`claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose`). Answers are written to the same stdin as new user messages, so the agent keeps its context between turns. There is no replay engine and no `prompt.md`. Each session works in its own git worktree, so sessions in the same workflow can run in parallel. `bug-sweep` stays a one-shot Claude run in the main checkout.

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

**Offline install.** The package has no runtime dependencies. On a connected machine run `npm pack`, copy the `.tgz` in, and install it globally (`npm install -g ./onuraslan-sdd-<version>.tgz`); or clone the repository and run `node bin/sdd.js ...`. Claude Code must be installed and authenticated on the machine. Studio always runs `claude`; there is no agent preset or custom command field.

## The workbench

The interface follows the **Technical Paper** design documented in [DESIGN.md](../DESIGN.md) and [PRODUCT.md](../PRODUCT.md): a light workbench for reading, and a dark inset for raw machine output. The run is the center of the page; configuration lives in a **Settings** drawer available from every tab.

The screen is meant to be used without thinking about settings: **pick the bugs, press Start.** Everything else is either detected at run time or remembered from the last choice. The rail footer summarizes the configured tracker targets (Jira, GitHub, GitLab); the connections and their checks live in **Settings**.

## Bug sweeps

### The queue

Pick a bug source (**Jira**, **GitHub**, or **GitLab**) and a project or repository, and the dashboard loads the open bugs into a multi-select list. Every bug is checked by default; uncheck the ones to leave for later. The selection is sent to `sdd bug-sweep` as `--issues`, so no JQL has to be written.

The source selector only changes which target the queue loads. **Settings** keeps the Jira project, GitHub repository, and GitLab project available at all times, because the enhancement and feature **Start from** pickers use them independently of the bug sweep.

The sweep form also chooses a **model** and **effort**. The model picker lists the ids the installed Claude Code picker reports, plus any model configured in the Claude environment; **Custom model…** accepts any other id. `Default` model and `Default` effort omit the matching CLI flag. The model and Claude environment are passed only to the sweep's child process and never mutate the Studio process environment.

The plan under the queue spells out the scope, branch, base, verify command, and publish behavior that will be used:

| Behavior | Default |
| --- | --- |
| Branch | `bug-fix/<git-user>/sdd-studio` (one persistent branch per user) |
| Tag | None per run; a merge tag is created when the branch is merged |
| Base | Detected from `origin/HEAD`, then `main` or `master` |
| Agent | Claude Code (`claude -p`, one-shot) |
| Verify command | Detected from `package.json` |
| Close source issue | Off |
| Per-bug timeout | 1800 seconds |

The date, branch owner, work directory, turn limit, and timeout are computed at run time and are not shown as fields. The owner is the git `user.name` plus a short hash of `user.email`, so the same name on two computers does not collide; `--branch-owner` overrides it.

### The run

Each bug gets a fresh agent session, so a previous fix cannot leak into the next one. The agent edits the working tree; the command owns git, the optional tag, and the pull request. A fix that fails verification or the result contract is reset and recorded as not fixed. The issue tracker is read-only unless **Close the source issue** is enabled.

The run view shows each bug moving from pending to running to fixed, not fixed, or flagged for human review, with a progress ruler, the live agent log, **Stop run**, and the merge request link when the run finishes. Changes to authentication, payments, migrations, infrastructure, or CI/CD are force-flagged for review.

Only one sweep runs at a time. A running sweep also holds the same on-disk lock as the CLI, so a scheduled sweep cannot overlap it. Sweeps run in the main checkout and may run alongside any number of live sessions, which have their own worktrees.

### Publishing

Every sweep pushes its branch. The **Publish** choice decides whether it also opens a merge request: **Push branch** pushes without one, and **Push + pull request** pushes and opens one. Push is implied by the merge request, so an invalid combination cannot happen, and the old commit-only option is no longer offered.

**Close the source issue when the work succeeds** is off by default and is shared by every workflow. The rule is the same everywhere: the issue closes only after the branch was pushed, with or without a merge request. A bug-sweep issue closes after its sweep push, an enhancement after its implementation push, and a feature after its build push — never when the spec session ends. Jira uses an available transition into the **Done** status category. GitHub and GitLab receive a normal close request. A tracker rejection is shown in the run log but never turns a successful fix, session, or build into a failure.

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
  --verify-cmd "npm test" \
  --max-turns 5 \
  --limit 20
```

Use `--dry-run` to see the plan, `--retry-failed` to retry bugs a previous run could not fix, and `--no-push` or `--no-pr` to stop before publishing. Pass `--close-issues` to close each fixed issue after the branch is pushed; it is off by default and is skipped when `--no-push` is used. The persistent branch resumes automatically; `--resume` remains a compatibility flag. Pass `--tag <name>` only when you also want a per-run tag, and `--reset-branch` to archive and delete the branch after a squash merge. State, prompts, agent logs, and the generated PR body live in `.sdd/`, which the command keeps out of git.

Use `--worktree` to fix bugs in a separate checkout under `.sdd/worktrees/`. The checkout path is stable per branch and shares the same `.git` store, so commits, tags, and pushes behave normally, but your own working tree — including uncommitted changes — is never touched. A directory left behind by an interrupted run is removed, or replaced with a one-off fallback path if Windows still holds it; the next run reuses the registered checkout for the branch. The checkout starts from the remote-tracking base (`origin/<base>`) when one exists, and `--fetch-base` refreshes it from the remote first. It is kept while the branch is unmerged, so the next run — and the same user on another computer — continues in the same branch. When the branch is merged into the base, the next run leaves a merge tag, removes the checkout, deletes the branch and its state, and starts a fresh one. The default GitHub path also reads the pull request state, so a squash merge is detected even though git no longer sees the branch as an ancestor; on another forge, pass `--reset-branch` after a squash merge. The CLI runs in place unless you pass `--worktree`; the dashboard always uses an isolated worktree.

The `bug-sweep` skill reports each outcome through a small JSON contract (`status`, `summary`, `how`, `critical`, `criticalReason`, `evidence`). The generated per-bug task file carries that contract. The skill runs `bug-fix` in a fresh subagent for the fix, then prepares the result as one JSON object. Both skills must be installed where Claude Code discovers skills; `sdd install` includes them.

#### Schedule it nightly

There are two ways to start a sweep at midnight.

**1. Keep the command running (built-in scheduler).**

```bash
sdd bug-sweep --project ABC --at 00:00 --every 1d
```

`--at 00:00` waits for the next midnight, `--every 1d` repeats after each sweep, and `--run-now` starts immediately and then repeats. The process must stay alive, so run it in a terminal, tmux, systemd, or another service manager. Each iteration computes its own date for the report and merge tag, and continues the single per-user bug-fix branch instead of creating a new one. A failed sweep is logged and the schedule continues; a lock file stops a new run from overlapping a running one.

**2. Let the operating system start a one-shot sweep.**

```bash
# cron (Linux/macOS): every day at 00:00
0 0 * * * cd /path/to/repo && sdd bug-sweep --project ABC >> .sdd/cron.log 2>&1
```

```powershell
# Task Scheduler (Windows): every day at 00:00
schtasks /Create /TN "sdd-bug-sweep" /SC DAILY /ST 00:00 /TR "cmd /c cd /d C:\path\to\repo && sdd bug-sweep --project ABC"
```

Keep `JIRA_BASE_URL` and `JIRA_API_TOKEN` in the scheduler's environment or a private env file rather than in the scheduled command line. Add `JIRA_AUTH`, `JIRA_API_VERSION`, and `JIRA_CA_CERT` when the Jira server needs them (see below). Because `--date` is not passed, each run picks up the current date for its report and merge tag; the branch itself stays the same.

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

The sweep uses the GitHub CLI by default. On GitLab, Gitea, or Bitbucket, pass `--pr-cmd`. A plain command runs through the shell and reads `SDD_PR_TITLE`, `SDD_PR_BODY`, `SDD_PR_BODY_FILE`, `SDD_PR_BASE`, `SDD_PR_HEAD`, `SDD_PR_REMOTE`, `SDD_PR_PROJECT`, `SDD_PR_DATE`, and `SDD_PR_URL` (the previous merge request URL, empty on the first run):

```bash
sdd bug-sweep --project ABC \
  --pr-cmd 'glab mr create --title "$SDD_PR_TITLE" --description "$(cat $SDD_PR_BODY_FILE)" --source-branch "$SDD_PR_HEAD" --target-branch "$SDD_PR_BASE"'
```

A JSON array runs without a shell, so the same value works on Windows and POSIX. It supports `{title}`, `{body}`, `{bodyFile}`, `{base}`, `{head}`, `{remote}`, `{project}`, `{date}`, and `{url}`, and must print the merge request URL. Since the sweep branch is persistent, make the command update the existing merge request when `SDD_PR_URL`/`{url}` is set instead of creating a second one; the built-in GitHub path already updates in place.

GitLab can also create the merge request without any extra CLI: `--gitlab-push` attaches `merge_request.create`, `target`, `title`, and `description` as git push options, and the URL is read from the `remote:` lines that GitLab prints back. The server must advertise push-options support (GitLab does by default; Gitea and Forgejo do not). Pick it when `glab` is not installed on the air-gapped machine:

```bash
sdd bug-sweep --project ABC --pr --gitlab-push --base main
```

For a fully disconnected run, use `--no-push --no-pr`: the sweep still commits each fix locally and writes the report to `.sdd/`.

## Enhancement and Feature

### Starting a session

Every workflow tab opens on the start panel. Earlier sessions live in a one-line **Sessions** strip above it: the count is always visible, and expanding the strip shows the last 20 sessions with status, model/effort, and branch. History is read-only; open a finished session to read its transcript or remove it. **New session** appears in that strip only while a session is open, so the start panel is always the fresh-session surface.

The start panel asks for the things that are not derived:

1. **Model** and **effort**. Pick a model from the Claude Code list, or choose **Custom model…** and type an id. The choice is remembered per workflow. Leave it on Default to use the environment.
2. **Open a merge request** for enhancement and feature sessions. It is checked by default. Both workflows always commit and push their session branch; the checkbox only controls the merge request.
3. A **brief**, or an issue from Jira, GitHub, or GitLab. Type the brief in the composer and press **Send** to start.

The effort is validated before the process starts; an unknown effort returns a clear error and nothing runs. `Default` model and `Default` effort omit the corresponding CLI flag. Models are not validated against a built-in catalog because a gateway can expose any id. The Claude environment is passed only to that session's child process.

Once a session starts, its header is locked to the selected model and effort; the setup controls are no longer editable.

### The conversation

Both tabs run a guided interview as a conversation. Describe the change, and the agent asks one question at a time; type the answer in the composer and press **Send**. Nothing parses the agent's prose, so the only question on screen is the one you answer.

An **enhancement** ends with a plan and report in the conversation. **Finish** ends the session at the report, the studio commits and pushes the worktree branch, and the optional merge request opens.

A **feature** ends its interview when the agent writes `docs/sdd/features/<feature>/spec.md`. The same session then stays open and idle.

Each session has its own worktree at `.sdd/worktrees/<session-id>`, created from the base branch (or from the merge target for merge sessions). The main checkout is not modified while a session runs. Sessions in the same workflow, and sessions in different workflows, run in parallel.

**Stop** is a two-step action. The first click arms it and explains that the process will be killed and the worktree deleted; the second click stops the session. A stopped session stays in history as `stopped`. Worktrees are also removed after success and after failure, and an interrupted worktree is cleaned up on the next Studio start.

### After the feature spec

When the spec is written, the session shows the two decisions the [feature workflow](../cli/workflows/workflow-feature-development.md) leaves to a human:

1. **Direct implementation** (`sdd-developer`) or **Task-by-task TDD** (`spec-to-task`, then `feature-tdd`).
2. **Run E2E verification?** Checked by default; unchecking adds `--no-verify`.

**Start build** writes the build request to the same live process. Every pipeline step is a user turn in the same session, so the agent keeps the spec context. The transcript shows stage markers and one line per step (`step 1/2 spec-to-task ✓`, `step 2/2 feature-tdd running`), with tool calls folded into a one-line **working** detail. A failed step names itself and stops the rest.

The build is part of the same job and the same SSE stream. There is no separate build job, no separate build panel, and no build event/cancel endpoint. When the build finishes, the studio commits and pushes the branch (and opens the optional merge request) before removing the worktree.

## Spec issue

The **Spec issue** tab is a separate planning workflow. It runs the same `deep-spec` interview as **Feature**, but stops at the spec and files it as one tracker issue instead of offering a build.

1. Pick the tracker under **File in**: Jira, GitHub, or GitLab. The choice is remembered as its own setting.
2. Choose model and effort, then describe the feature and answer the interview one question at a time.
3. When the agent writes `docs/sdd/features/<feature>/spec.md`, the studio copies the spec to the main checkout and creates one issue automatically. The title comes from the spec's `# Feature: <name>` heading and the body is the full file.

The result plate links to the created issue. A missing target or a tracker rejection is reported in the conversation but does not turn the finished spec into a failure; the spec stays on disk. The tab never commits or pushes and never opens a merge request.

The same thing is available without the dashboard as `sdd spec-issue [spec.md]`; see [File a spec as an issue](../README.md#file-a-spec-as-an-issue).

## Merge

The **Merge** tab is separate because its safety rules are different. Pick a **Source** and an **Into** branch.

- The merge runs in its own worktree created from the **target** branch, so the main checkout may be dirty and may be on another branch while the merge session runs.
- An integration branch that already exists is refused instead of reused.
- The agent dry-runs the merge, asks only about risky conflicts one at a time in the composer, and commits the result to `merge/<source>-into-<target>`.
- The target is never checked out, modified, or deleted while the session runs.

The merge guard is part of the Claude session: it allows edits to conflicted files and read/commit git commands, and denies pushes, remotes, `--force`, `reset --hard`, and anything that switches to or rewrites the target.

A merge session ends structurally when the integration branch exists, not when the reply says so. A **Land** plate then checks that the target has not moved, requires a clean main checkout, switches to the target, and fast-forwards with `git merge --ff-only`. Landing never pushes and never creates a merge commit. It is refused if the target advanced, and the previous branch is restored if the switch fails.

## Settings

### Where settings live

The choices are saved as they change to a git-ignored `.sdd/studio.settings.json` (mode `0600` on POSIX). The directory gets its own `.gitignore`, so the file never appears in `git status`. A `.bug-fix/studio.settings.json` from an older version is moved to the new location on first read.

The Jira token is stored locally but never returned to the browser. The API only reports whether a token is saved; a blank token field keeps the saved one, and **Forget saved** clears it. Environment variables such as `JIRA_BASE_URL` and `JIRA_API_TOKEN` still work as a fallback.

### What is stored

| Setting | Purpose |
| --- | --- |
| Claude environment | `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`, and `CLOUD_ML_*` variables passed to Claude Code |
| Workflow defaults | Model, effort, and merge-request checkbox for enhancement, feature, spec issue, merge, and bug sweep |
| Bug source, Jira project, GitHub repository, GitLab project | Where the queue loads bugs and issues |
| Base branch | Blank uses the detected branch |
| Publish | Push branch or push + merge request for bug sweeps |
| Merge request preset, custom command | Which forge creates the merge request |
| Jira deployment type, URL, email, token, auth mode, API version, CA, skip TLS | Jira connection |
| Enhancement/Feature/Spec issue source | Per-tab tracker choice, saved separately for each |

The retired `agentPreset` and `agentCmd` values are ignored. Studio always runs Claude Code. Settings opens automatically on the first visit, while the project is still empty.

### Claude environment and models

The **Claude environment** section of Settings edits a flat map of variables. Values are set only on the child Claude process; the Studio server's own environment is never modified. Common setups are:

- **Anthropic-compatible gateway**: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL`
- **Amazon Bedrock**: `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, and the Bedrock model ids
- **Google Vertex AI**: `CLAUDE_CODE_USE_VERTEX=1`, `CLOUD_ML_REGION`, and the Vertex model ids
- **Custom proxy aliases**: `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL`

Model ids are not built into Studio. The picker is populated from the installed Claude Code picker (`claude -p "/model" --output-format json`). Values already present in `ANTHROPIC_MODEL` and the default model aliases are added to the list, so a gateway-specific id such as `nim-model` appears without a catalog. Choose **Custom model…** to type any other id, including when the picker cannot be read.

The API masks `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN`. A blank secret field keeps the saved value; remove the row to clear it.

Effort choices are **low**, **medium**, **high**, **xhigh**, **max**, and **Default**. Model also offers **Default** (an empty value) and **Custom model…**. Choosing Default omits the flag, so Claude Code's own default applies.
### Jira

- **Jira Cloud** uses Basic auth with an email and an API token, and REST v3.
- **Jira Data Center / Server** uses a personal access token (Bearer) and REST v2 by default.
- An internal or self-signed CA can be supplied as a PEM path; **Skip TLS verification** is a last resort.
- **Check Jira** probes reachability, TLS, authentication, and the REST version before a run.

The deployment type sets the auth mode and API version together, so the two always match the server.

## Sessions, permissions, and history

Studio keeps one Claude Code process open per session and streams each answer to its stdin, so the agent keeps its context between turns. Reads are pre-approved; any other tool becomes a `PermissionRequest`, shown as an **Approval** plate inside the conversation with **Allow once** and **Deny**. The agent waits for the answer instead of looking frozen, and a timeout denies safely. The hook is injected as a settings layer on the command line, so your own Claude Code configuration is never edited.

The session reader shows only meaningful events by default: your prompts, the agent's replies, questions, permission requests, artifact milestones, build stage/step markers, and errors. Tool calls and read results collapse into a one-line **working** detail. **Rich** renders Markdown — headings, lists, tables, quotes, links, code — and Mermaid diagrams inline. **Raw** shows the raw `stream-json` output for copying. stderr never enters the transcript. Mermaid 12.2.0 is vendored under `studio/vendor/mermaid/` (MIT), so diagrams work without a CDN or network access.

Session records are written to `.sdd/sessions/<flow>/<id>/`: `session.json` holds the metadata, events, turns, and locked selection, while `session.md` is the human-readable conversation. Reopening a session loads the record read-only. Studio startup also loads history from disk; a session that was live when the server stopped is shown as `failed`, because resume and transcript replay are intentionally not supported.

Removing a session from the list deletes its `.sdd/sessions/<flow>/<id>/` directory. It does not touch the worktree, which is already removed when the session ends.

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
| `GET /api/features` / `POST /api/features` | List or start a feature session |
| `GET /api/spec-issues` / `POST /api/spec-issues` | List or start a spec-to-issue session |
| `GET /api/merges` / `POST /api/merges` | List or start a merge session |
| `GET /api/<flow>/:id` | `{ job, markdown }`; both live jobs and saved history |
| `DELETE /api/<flow>/:id` | Remove a saved session record |
| `GET /api/<flow>/:id/events` | Live SSE event stream for a session |
| `POST /api/<flow>/:id/cancel` | Stop a running session |
| `POST /api/merges/:id/land` | Fast-forward the target onto the finished integration branch |
| `POST /api/features/:id/build` | Start the chosen pipeline in the waiting feature session |
| `POST /api/jobs/:id/input` | Answer the agent's current question |
| `POST /api/jobs/:id/permission` | Allow or deny the agent's permission request |

`<flow>` is `enhancements`, `features`, `spec-issues`, or `merges`.

## Safety notes

- The server listens on localhost only by default. Do not expose it to a network.
- The token lives in `.sdd/studio.settings.json`, which is git-ignored and never sent back to the browser.
- Sweeps never force-push. With **Close the source issue** off (the default), the issue tracker is read-only.
- Every live session runs in its own worktree, so your own checkout — including uncommitted changes — is never touched while it runs.
- Worktrees are removed on success, failure, and stop. A failed or stopped session also drops its branch; nothing is resumed automatically.
- Merge landing never pushes and never creates a merge commit.
- The spec issue tab creates the one issue it was asked for and never commits or pushes.

---

See the [main README](../README.md) for installation, the CLI commands, and the skills.
