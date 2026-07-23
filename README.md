# SDD Plugin Suite

**Spec-driven development from planning to implementation.**

This repository is a collection of skills that automate software development workflows using Spec-Driven Development (SDD). Designed for developers and QA engineers who want structured, adaptive workflows without rigid templates.

---

## Installation

You can install this repository in two ways:

### Option 1: Claude Code plugin marketplace

```bash
/plugin marketplace add https://github.com/onur-aslan/sdd
```

### Option 2: skills.sh installer

If you want to copy the skills into your project for local editing and customization, you can also install them with `skills.sh`:

```bash
npx skills@latest add onur-aslan/sdd
```
---

## Plugins

| Plugin | Description |
|--------|-------------|
| [**SDD Core**](sdd/) | Automated workflows from spec design to implementation |
| [**SDD Frontend**](sdd-frontend/) | Frontend-specific skills for UI design, enhancement, and testing |
| [**SDD Backend**](sdd-backend/) | Backend development skills for API, database, and server-side logic |
| [**SDD Utility**](sdd-utilty/) | Code quality analysis, gap analysis, session handoff, and glossary |

---

## SDD Core Plugin

Automated workflows that guide you from specification to implementation. The **workflow-gateway** skill selects the right workflow based on your task type.

### Getting Started

**1. Run workflow-generator to select your workflow:**

```bash
/workflow-generator
```

This will:
- Ask you to choose: Feature Development, Bug Fix, Enhancement, or Help me decide
- Detect if it's Backend, Frontend, or Both
- Write the selected workflow to `docs/workflow.md`

**2. Follow the steps in `docs/workflow.md`:**

Each workflow file contains a sequence of skills to run in order. Run them one by one:

---

### Workflows

#### 1. Feature Development (Frontend)

```
deep-spec -> spec-to-prd -> [small scope: implementer] | [large PRD: prd-to-task -> feature-implementer] -> feature-e2e-verifier -> prd-test-writer -> gap-analysis -> code-slop-review
```

#### 2. Feature Development (Backend)

```
deep-spec -> spec-to-prd -> [small scope: implementer -> verify-with-curl] | [large PRD: prd-to-task -> chicago-tdd (per task)] -> feature-e2e-verifier -> prd-test-writer -> gap-analysis -> code-slop-review
```

#### 3. Bug Fix

```
bug-fix-frontend|backend -> verify-with-playwright-mcp|verify-with-curl
```

#### 4. Enhancement

```
frontend|backend-enhancement -> verify-with-playwright-mcp|verify-with-curl
```

### Core Skills

| Skill | Command | Description |
|-------|---------|-------------|
| `workflow-generator` | `/workflow-generator` | Entry point -- selects workflow, writes `docs/workflow.md` |
| `deep-spec` | `/deep-spec` | Interview-driven spec creation |
| `spec-to-prd` | `/spec-to-prd` | Convert spec.md to PRD |
| `prd-to-task` | `/prd-to-task` | Split PRD into tasks with Gherkin scenarios |
| `implementer` | `/implementer` | Implement from conversation context (no files needed) |
| `feature-implementer` | `/feature-implementer <feature.md>` | Implement tasks sequentially |
| `chicago-tdd` | `/chicago-tdd <task.md>` | TDD for a single task (Red-Green-Refactor) |
| `prd-test-writer` | `/prd-test-writer <prd.md>` | Write acceptance tests in parallel |
| `feature-e2e-verifier` | `/feature-e2e-verifier <prd.md>` | E2E verify User Stories |

---

## SDD Frontend Plugin

Frontend-specific skills for UI design, enhancement, and verification.

### Core Skills

| Skill | Command | Description |
|-------|---------|-------------|
| `frontend-enhancement` | `/frontend-enhancement` | Interview-driven UI enhancement with ASCII mockup planning |
| `bug-fix-frontend` | `/bug-fix-frontend "<description>"` | Senior-level frontend bug fixing with auto-verification |
| `feature-e2e-verifier` | `/feature-e2e-verifier <prd.md>` | E2E verify User Stories by testing all Acceptance Criteria sequentially |
| `verify-with-playwright-mcp` | `/verify-with-playwright-mcp` | Visual verification with auto-fix loop |
| `using-playwright-mcp` | `/using-playwright-mcp` | General-purpose Playwright browser automation |
| `git-cleanup-playwright-artifacts` | `/git-cleanup-playwright-artifacts` | Clean up Playwright screenshots and test artifacts |

---

## SDD Backend Plugin

Backend development skills for API, database, and server-side logic with unit testing.

### Core Skills

| Skill | Command | Description |
|-------|---------|-------------|
| `bug-fix-backend` | `/bug-fix-backend` | Fix backend bugs |
| `backend-enhancement` | `/backend-enhancement` | Enhance backend features |
| `verify-with-curl` | `/verify-with-curl` | Verify APIs with curl requests |

---

## SDD Utility Plugin

Code quality and session management utilities.

### Core Skills

| Skill | Command | Description |
|-------|---------|-------------|
| `code-slop-review` | `/code-slop-review` | 5-layer code quality analysis |
| `gap-analysis` | `/gap-analysis` | Compare implementation against requirements |
| `glossary-builder` | `/glossary-builder` | Build domain glossary for project |
| `using-glossary` | `/using-glossary` | Use glossary for consistent terminology |
| `ask-first` | `/ask-first` | Plan before implement — pause for approval on non-trivial tasks |
| `handoff` | `/handoff` | Capture session knowledge for the next skill |
| `handoff-resume` | `/handoff-resume` | Resume session from handoff file |
| `init-feature` | `/init-feature` | Initialize a new feature |

### Handoff Workflow

Use this 3-step workflow to transfer session knowledge between sessions:

```
/handoff -> /clear -> /handoff-resume
```

1. **`/handoff`** — Captures current session context, decisions, and progress into a handoff file.
2. **`/clear`** — Clears the conversation history to start fresh.
3. **`/handoff-resume`** — Loads the handoff file and restores session context for the next skill.

---

## License

MIT

## Author

Onur ASLAN
