# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Notes
- No new unreleased changes at the moment.
- The repository is currently aligned with the published `v1.0.3` release.

## [1.0.3] - 2026-08-25

### Changed
- Renamed `sdd-utilty` → `sdd-utility` (git mv).
- Fixed typos in multiple `SKILL.md` files: `spec-to-prd`, `prd-to-task`, and `workflow-generator`.

### Fixed
- Minor documentation clarifications and frontmatter consistency for skills.

## [1.0.2] - 2026-07-23

### Changed
- Renamed `workflow-gateway` skill to `workflow-generator` (command: `/workflow-generator`) for clarity.
- Fixed typos in `prd-to-task` ("orhcestrator" → "orchestrator") and `chicago-tdd` ("? Done" → "Done").

### Fixed
- Minor documentation and skill naming improvements.

## [1.0.1] - 2026-07-22

### Changed
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
