# SDD Plugin Suite

**Spec-driven development from planning to implementation.**

This repository is a collection of skills that automate software development workflows using Spec-Driven Development (SDD). Designed for developers and QA engineers who want structured, adaptive workflows without rigid templates.

---

## Installation

You can install SDD in four ways:

### Option 1: npm package installation (recommended)

Install or update the package and run the interactive installer from the npm bundle itself:

```bash
npx @onuraslan/sdd@latest install
```

This installer reads the skill content from the installed npm package and copies it directly to the target agent directory. It does not clone the GitHub repository at runtime.

When the `sdd` plugin is part of the selection, the installer also registers the Playwright MCP server for the chosen target, writing it to that target's own MCP config file (Claude Code is configured through the `claude mcp add` CLI). Installing `vibecoding` alone registers no MCP server.

#### Update an existing installation

To upgrade the installed skill set to the latest published version, simply rerun the same command:

```bash
npx @onuraslan/sdd@latest install
```

If you installed it globally instead of via npx, update it with:

```bash
npm update -g @onuraslan/sdd
```

### Option 2: Claude Code plugin marketplace

```bash
/plugin marketplace add https://github.com/onur-aslan/sdd
```

### Option 3: Codex plugin marketplace

```bash
codex plugin marketplace add onur-aslan/sdd
```

### Option 4: skills.sh installer

If you want to copy the skills into your project for local editing and customization, you can also install them with `skills.sh`:

```bash
npx skills@latest add onur-aslan/sdd
```

> The npm package route is the recommended runtime distribution path for the installer. The repository is kept as the source of truth for publishing and release management.
---

## Plugins

| Plugin | Description |
|--------|-------------|
| [**SDD Core**](sdd/) | Spec-driven development workflows from spec design to implementation, plus domain-agnostic bug-fix and enhancement loops |
| [**Vibecoding**](vibecoding/) | Glossary management, working conventions, and Playwright artifact cleanup |

---

## SDD Core Plugin

Automated workflows that guide you from specification to implementation. The `sdd workflow` command selects the right workflow based on your task type.

### Getting Started

**1. Generate your workflow:**

```bash
npx @onuraslan/sdd@latest workflow
```

This will:
- Ask you to choose: Feature Development, Bug Fix, or Enhancement
- Write the selected workflow to `docs/workflow.md`

You can also select non-interactively:

```bash
npx @onuraslan/sdd@latest workflow --type feature
```

**2. Follow the steps in `docs/workflow.md`:**

Each workflow file contains a sequence of skills to run in order. Run them one by one:

---

### Workflows

#### 1. Feature Development

```
deep-spec -> sdd-developer
          -> [large spec: spec-to-task] -> feature-tdd
```

`sdd-developer` runs the whole pipeline autonomously (implement → review and fix → per-story E2E verification); it reads `spec.md` by default, or the path you pass. `feature-tdd` runs the same pipeline with per-task Chicago TDD over a `feature.md` task breakdown. Pass `--no-verify` to skip E2E verification.

#### 2. Bug Fix

```
bug-fix
```

#### 3. Enhancement

```
enhancement
```

### Core Skills

| Skill | Command | Description |
|-------|---------|-------------|
| `deep-spec` | `/deep-spec` | Interview-driven spec creation |
| `spec-to-task` | `/spec-to-task` | Split spec into tasks with Gherkin scenarios |
| `feature-tdd` | `/feature-tdd [feature.md] [max_turns] [--no-verify]` | One-shot pipeline: per-task Chicago TDD (Red-Green), review and fix, and per-story E2E verification, autonomously |
| `sdd-developer` | `/sdd-developer [spec.md] [max_turns] [--no-verify]` | One-shot pipeline: baseline checks, implement, review and fix, and per-story E2E verification, autonomously |
| `feature-e2e-verifier` | `/feature-e2e-verifier <spec.md>` | E2E verify User Stories by testing all Acceptance Criteria sequentially |
| `bug-fix` | `/bug-fix "<description>"` | Autonomously reproduce, diagnose, and fix bugs with a bounded fix-and-verify loop |
| `enhancement` | `/enhancement` | Plan, implement, and verify enhancements through an approved plan and a bounded execution loop |
| `load-project-features` | `/load-project-features` | Discover existing project features from the codebase and generate a spec for each |

---

## Vibecoding Plugin

Utilities for glossary management, working conventions, and Playwright artifact cleanup.

### Core Skills

| Skill | Command | Description |
|-------|---------|-------------|
| `glossary-builder` | `/glossary-builder` | Build domain glossary for project |
| `using-glossary` | `/using-glossary` | Use glossary for consistent terminology |
| `ask-first` | `/ask-first` | Plan before implement — pause for approval on non-trivial tasks |
| `buy-before-build` | `/buy-before-build` | Prefer industry best practices and proven solutions before custom builds |
| `grounded-mode` | `/grounded-mode` | Persistent grounded response mode, toggleable by the user |
| `git-cleanup-playwright-artifacts` | `/git-cleanup-playwright-artifacts` | Clean up Playwright screenshots and test artifacts |

---

## License

MIT

## Author

Onur ASLAN
