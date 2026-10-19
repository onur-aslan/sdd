# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.0.0] - 2026-10-19

> ⚠️ **Breaking release.** The plugin suite is reduced from four plugins to two: `sdd` (core) and `vibecoding`. The `sdd-frontend` and `sdd-backend` plugins are removed, several core skills are deleted, and `sdd workflow` no longer uses scopes. Review the Changed and Removed sections before upgrading.

### Added
- `bug-fix` skill in `sdd`: domain-agnostic bug fixing with a bounded reproduce → fix → verify loop. Replaces `bug-fix-frontend` and `bug-fix-backend`.
- `enhancement` skill in `sdd`: domain-agnostic enhancement workflow with an approved plan and a bounded execution loop. Replaces `frontend-enhancement` and `backend-enhancement`.
- `feature-e2e-verifier` and `sdd-developer` skills in `sdd`: `sdd-developer` is a one-shot domain-agnostic pipeline (baseline checks → implement → review and fix → per-story E2E verification, skippable via `--no-verify`).
- Codex support: each plugin now ships a portable [Agent Plugins](https://agent-plugins.org) manifest (root `plugin.json` with `$schema`, plus `mcp.json`), and `.agents/plugins/marketplace.json` exposes both plugins as a local Codex marketplace.
- `sdd uninstall`: removes the skills an installation recorded, its `sdd.json`, and the Playwright MCP server it registered — every target and scope by default, narrowed by `--target` and `--user`, previewable with `--dry-run`, and skippable for MCP with `--keep-mcp`. Skills and MCP servers SDD does not own are never touched, and a pre-4.0.0 Codex `.codex/skills` directory is removed with it.

### Changed
- Renamed the `sdd-utility` plugin to `vibecoding`.
- Moved the `init-feature` skill from `vibecoding` into `sdd` and renamed it to `load-project-features` (`/load-project-features`).
- Moved the `git-cleanup-playwright-artifacts` skill into the `vibecoding` plugin.
- Moved the `feature-e2e-verifier` skill from the removed `sdd-frontend` plugin into `sdd`.
- `sdd workflow` is now domain-agnostic: only `--type <feature|bug-fix|enhancement>` remains; the `backend`/`frontend`/`both`/`web`/`core` scopes and their templates were removed. The feature workflow is built around `sdd-developer`.
- `sdd-developer` and `feature-tdd` accept an optional spec/feature path, in addition to `max_turns` and `--no-verify`.
- `feature-tdd` now runs the same pipeline as `sdd-developer` — baseline checks → per-task Chicago TDD → review and fix → per-story E2E verification.
- Playwright MCP is now configured when the `sdd` plugin is installed (previously triggered by `sdd-frontend`). For Codex it is written to `.codex/config.toml`.
- The Playwright MCP server is registered as `npx -y @playwright/mcp` on every path — Claude, Codex, Cursor, OpenCode, and the plugin `mcp.json` files — so `npx` never blocks on an install confirmation prompt.
- Reinstalling the Codex target no longer removes other MCP servers from `.codex/config.toml`; only the `[mcp_servers.playwright]` block is replaced.
- The OpenCode target keeps the V1-compatible `mcp.playwright` entry. OpenCode 1 rejects the V2 `mcp.servers` key outright, while OpenCode 2 still accepts V1 MCP entries that carry a `type`, so this is the only shape that works on both.
- The Codex install target now writes skills to `.agents/skills` — the location Codex scans — instead of `.codex/skills`.
- Upgrading no longer leaves orphaned skills behind: the installer records the installed skill names in the target `sdd.json` and prunes the skills that left the package or the selection — including the 13 skills dropped in `4.0.0` — while unrelated skills in the same directory are left untouched. A stale pre-4.0.0 Codex `.codex/skills` directory is reported instead of deleted, because the installer cannot prove it owns every directory inside it.
- `sdd/.mcp.json` now wraps the Playwright server in `mcpServers`, the shape Claude Code expects for a plugin's MCP config.
- `sdd --help` now documents the install options (`--target`, `--user`, `--all`, `--non-interactive`), and `sdd list` reports the project- and user-scope installation state of every supported target with present/expected skill counts.
- The Claude target no longer fails when the `claude` CLI is missing: it warns and writes the Playwright MCP server to the target's MCP config file directly. This also covers Windows, where a missing CLI surfaces as a shell "not recognized" error instead of an ENOENT spawn error.
- The installer never overwrites an existing MCP config file it cannot parse; it warns and leaves the file untouched. The Codex `.codex/config.toml` writer also keeps the file's existing line endings.
- Bumped the package, `plugin.json`, and marketplace metadata to `4.0.0`.

### Removed
- `sdd-frontend` and `sdd-backend` plugins and their skills: `bug-fix-frontend`, `bug-fix-backend`, `frontend-enhancement`, `backend-enhancement`, `feature-web-developer`, `verify-with-playwright-mcp`, and `verify-with-curl`.
- `feature-developer`, `implementer`, and `feature-implementer` skills from the `sdd` plugin.
- `spec-test-writer` and `sdd-review` skills from the `sdd` plugin; the `sdd-developer` and `feature-tdd` pipelines review and fix their changes inline.
- The `.github/workflows/npm-release.yml` GitHub Actions workflow; npm releases are published manually.
- The `Windsurf` install target. Windsurf now stores MCP servers in a single global `mcp_config.json`, so the target could not configure MCP reliably; installs are supported for Claude Code, Cursor, Codex, and OpenCode.

## [3.1.1] - 2026-10-13

### Added
- `core` scope in `sdd workflow` (feature type only): generates a one-shot workflow built around `feature-developer` (`sdd workflow --type feature --scope core`).

## [3.1.0] - 2026-10-13

> ℹ️ The npm `3.0.0` package was published before the skills below were deleted from the repository, so they still shipped inside the `3.0.0` tarball. This release is where they are actually removed for end users.

### Added
- `feature-developer` skill in the `sdd` plugin: a one-shot pipeline that takes a `spec.md` or `feature.md` path, implements it (`implementer` for a spec, `feature-implementer`/`feature-tdd` for a feature), then runs a report-only `sdd-review` — fully autonomously, no prompts. Unlike `feature-web-developer`, it performs no E2E verification.

### Removed
- `gap-analysis` skill — replaced by the Spec pass of `sdd-review`.
- `code-slop-review` skill and its reference docs — replaced by the Slop pass of `sdd-review`.
- `handoff` and `handoff-resume` skills.

## [3.0.0] - 2026-10-12

> ⚠️ **Breaking release.** The `gap-analysis`, `code-slop-review`, `handoff`, and `handoff-resume` skills were removed; post-implementation review is now a single `/sdd-review` step. Review the Removed section before upgrading.

### Added
- `feature-web-developer` skill in the `sdd-frontend` plugin: a one-shot pipeline that takes a `spec.md` or `feature.md` path, implements it (`implementer` for a spec, `feature-implementer`/`feature-tdd` for a feature), then verifies it with `feature-e2e-verifier` — fully autonomously, no prompts.
- `sdd-review` skill in the `sdd` plugin: a single post-implementation review with two passes — Spec (Missing/Extra/Incorrect against the requirements) and Slop (design-level code quality in the diff) — plus a Fix Mode.
- `web` scope in `sdd workflow` (feature type only): generates a one-shot workflow built around `feature-web-developer` (`sdd workflow --type feature --scope web`); the interactive scope prompt is now filtered by the selected workflow type.

### Changed
- Removed `disable-model-invocation` from `implementer`, `feature-implementer`, `feature-tdd`, and `feature-e2e-verifier` so the `feature-web-developer` pipeline can invoke them.
- Feature development workflows (`workflow-feature-development-backend`, `workflow-feature-frontend-development`) now end with a single `/sdd-review` step instead of `/gap-analysis` + `/code-slop-review`.
- Description-first explicit-name rule for the skills that stay model-invokable (`implementer`, `feature-implementer`, `feature-tdd`, `sdd-review`, `feature-e2e-verifier`, `verify-with-curl`, `verify-with-playwright-mcp`): their descriptions now state they must be invoked only when named explicitly (by the user or by another skill), so they are no longer auto-selected by task inference.
- Workflow templates now use bare slash commands without the plugin prefix (`/sdd:deep-spec` → `/deep-spec`), matching how the skills are installed.
- `deep-spec` and the `init-feature` spec format: constraints and assumptions discovered during the interview or codebase scan are captured as `SP-n` entries under Specs, and the spec is written in the language the user writes in.
- `ask-first`: when an approved plan must change, the skill now stops, restates the updated plan, and waits for explicit re-approval before continuing.

### Removed
- `gap-analysis` skill — replaced by the Spec pass of `sdd-review`.
- `code-slop-review` skill and its reference docs — replaced by the Slop pass of `sdd-review`.
- `handoff` and `handoff-resume` skills and the README Handoff Workflow section.

> ⚠️ Correction: the `3.0.0` npm package was published before these deletions were committed, so the four skills above were still present in the published `3.0.0` package. They are removed in `3.1.0` — see that release.

## [2.0.0] - 2026-10-06

> ⚠️ **Breaking release.** The PRD layer was removed (`spec.md` is now the single source of truth), several skills and slash commands were renamed or removed, and the `docs/workflow.md` entry point moved from the `/workflow-generator` skill to the `sdd workflow` CLI command. Review the Changed and Removed sections before upgrading.

### Added
- `sdd workflow` CLI command that generates `docs/workflow.md` from built-in templates (interactive prompts, or non-interactive via `--type` and `--scope`).

### Changed
- Removed the `spec-to-prd` skill; PRD is no longer part of the workflow. `spec.md` is now the single source of truth.
- Renamed `prd-to-task` → `spec-to-task` (input is now `spec.md`).
- Renamed `prd-test-writer` → `spec-test-writer` (reads User Stories from `spec.md`).
- `deep-spec` spec format: design decisions now carry sequential `SP-n` IDs (no Reasoning line), and a `## User Stories` section (PRD-style table with `US-0n` / `AC-0n.m` IDs) was added.
- `init-feature` now generates `spec.md` instead of `prd.md` (`prd-format.md` → `spec-format.md`, `prd-writer-prompt.md` → `spec-writer-prompt.md`).
- Added `feature-tdd` skill: orchestrates Chicago TDD for each task in `feature.md` sequentially (one task per subagent). The Chicago TDD workflow is inlined into its `tdd-implementer` agent prompt.
- Removed human-in-the-loop confirmation gates from `feature-implementer`, `feature-e2e-verifier`, `spec-to-task`, and `init-feature` (they now run autonomously).
- Renamed the `## Design Decisions` spec section to `## Specs` (in both `deep-spec` and `init-feature` spec formats) to match the `SP-n` decision IDs.
- Fixed stale metadata: `sdd-utility` plugin name typo (`sdd-utilty`), outdated `sdd`/`sdd-frontend`/`sdd-utility` plugin descriptions and keywords (removed Jira, caveman, and non-existent skill names), and `README.md` (`sdd-utility` link, missing skills in tables).
- Bumped all plugin and marketplace metadata to `2.0.0`.
- Moved the six workflow templates into the CLI package (`cli/workflows/`) and updated the generated header to `Generated by sdd workflow`.
- Updated `README.md` and marketplace metadata to document `sdd workflow`.

### Removed
- `spec-to-prd` skill and its reference docs.
- `chicago-tdd` skill (its workflow now lives inside `feature-tdd`).
- `using-playwright-mcp` and `ui-heuristic-click-audit` frontend skills.
- `workflow-generator` skill and its reference templates; its behaviour is now provided by the `sdd workflow` CLI command.

## [1.1.0] - 2026-09-29

### Changed
- Published the package as `@onuraslan/sdd` and clarified the install/update workflow using `npx @onuraslan/sdd@latest install`.
- Aligned package, plugin metadata, and marketplace manifest versions to `1.1.0` across the project.
- Improved agent installation behaviour for Claude, Cursor, Codex, Windsurf, and OpenCode with target-specific config handling.
- Added safer reinstall logic to overwrite installs cleanly and treat duplicate MCP registrations as a no-op success.

### Fixed
- Corrected the OpenCode MCP config schema to use the expected local-command format.
- Fixed Claude MCP installation flow so an already-installed Playwright server does not fail the install step.
- Updated README installation guidance to make the difference between initial install and upgrade explicit.
- Resolved stale marketplace metadata and plugin version drift so published package metadata matches the release version.

## [1.0.4] - 2026-08-26

### Changed

### Fixed
- Apply patch for minor fixes and documentation updates; prepared for release.

## [1.0.3] - 2026-08-25

### Changed

### Fixed

## [1.0.3] - 2026-08-25
- Added `code-slop-review` skill and its layered reference docs (`structural-slop`, `test-slop`, `error-handling-slop`, `dead-code-slop`, `architecture-slop`).

- Renamed `sdd-utilty` → `sdd-utility` (git mv).
- Bumped package and plugin metadata to `1.0.3` (marketplace and `plugin.json` files updated).
- Fixed typos in multiple `SKILL.md` files: `spec-to-prd`, `prd-to-task`, and `workflow-generator`.
- Minor documentation clarifications and frontmatter consistency for skills.

## [1.0.2] - 2026-07-23

- Renamed `workflow-gateway` skill to `workflow-generator` (command: `/workflow-generator`) for clarity.
- Fixed typos in `prd-to-task` ("orhcestrator" → "orchestrator") and `chicago-tdd` ("? Done" → "Done").

### Fixed
## [1.0.1] - 2026-07-22

- Updated plugin and marketplace metadata versions from `1.0.0` to `1.0.1`.
- Added required `description` frontmatter fields to installable `SKILL.md` files so they are accepted by `skills.sh`.

### Fixed
- Resolved missing `description` frontmatter warnings for skill installation compatibility.

## [1.0.0] - 2026-07-22

### Added
- Initial changelog structure for the repository.
- Licensing clarification with a root `LICENSE` file.
- Documentation baseline for release notes and future version tracking.
- Initial Claude Code plugin suite structure for core, frontend, backend, and utility skills.
- `sdd/`, `sdd-frontend/`, `sdd-backend/`, and `sdd-utilty/` plugin organizations.
- Workflow-based skill documentation for spec-driven feature development and verification.
- MIT license declaration in metadata and README.

### Changed
- Repository documentation now includes explicit release note expectations.

### Fixed
- Missing repository-level license text file for MIT declaration consistency.
