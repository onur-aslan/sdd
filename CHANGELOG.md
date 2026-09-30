# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Notes

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
