# discovery

Run this checklist at the start of every `apply-design` run, before planning. Do not write the result to the repository as a code map: it goes stale and silently misleads the next run. Keep the result in the run's context and plan.

The goal is to answer three questions for each pending decision:

1. Where is it implemented today?
2. What exactly must change?
3. What proves it changed?

## 1. Read the rules

- `CLAUDE.md`, `AGENTS.md`, `README`, and any `docs/` they point to.
- Build/test/lint commands, package manager, workspace layout.
- Mandatory architecture rules: theme/token layer, API client, data hooks, config-driven UI, review/commit rules.
- Forbidden changes, protected files, environment constraints.

Project rules override this skill's defaults. If two rules conflict, report it; don't guess.

## 2. Read the design state

- `DESIGN.md`: status, layers, Tokens block, Layer 2 index, changelog.
- `design/pages/<slug>.md`: the page file for the current scope; it overrides `DESIGN.md` for that scope.
- `design/deltas/*.json`: pending changes; newest `created_at` wins per decision.
- `design/applied.md`: what is already applied and verified.
- Competing authorities: `MASTER.md`, `STYLEGUIDE.md`, `design-system/`, storybook docs, or any file claiming binding UI rules. Compare; stop on contradiction before editing.

## 3. Detect the stack

- Manifests: `package.json`, `pyproject.toml`, `requirements*.txt`, `go.mod`, `Cargo.toml`, `*.csproj`, etc.
- Framework and language; SPA/router; server-rendered templates.
- UI library and styling: component library, CSS framework, CSS-in-JS, CSS variables, Tailwind config.
- Fonts, icon set, animation library.
- Package manager and lockfile; monorepo/workspace layout.

## 4. Find the theme and token layer

- Theme entry point(s): `theme.*`, `tailwind.config.*`, `tokens.*`, `variables.css`, design-system package.
- Color mode: default, toggle, persistence key, system preference.
- Palette, typography, spacing, density, radius, shadows, motion.
- How components consume tokens; hardcoded values that should be tokens.
- Where the design's token names map to the project's keys.

## 5. Find the app shell and navigation

- Layout shell, sidebar/topbar, drawer widths, breakpoints, mobile behavior.
- Navigation config and role/permission config.
- Routing: URL router or state-based view switch; how to reach each screen by clicking.
- Auth gate, login screen, forced-password-change or onboarding flows.

## 6. Find the screens in scope

- Routes/views and their page components; feature components; modals/dialogs.
- Shared primitives and where they are reused.
- Empty, loading, error, and permission-denied states.
- The real labels and sample data needed for assertions.

## 7. Find the data and API layer

- HTTP client and base URL; token storage and auth headers.
- Data hooks/loaders and cache/state library.
- Server-side filtering, sorting, pagination; existing filter UI components.
- Feature flags, environment switches, and mock data.

## 8. Collect verification inputs

- Install command (if dependencies are missing).
- Dev server command, port, protocol; how to run it in the background.
- Backend/proxy target and how to start it; health check.
- Test accounts per role: read names from the project docs or ask the user. Never read, print, or store secret values.
- Seed data needed to reach the scope; safe test data.
- Theme toggle and viewport support.

## 9. Map decisions to evidence

For each pending decision:

| Field | Answer |
|---|---|
| Decision | `Dxx` and title |
| Current implementation | file + symbol/selector |
| Required change | concrete edit |
| Token/prop | exact theme key or CSS variable |
| Assertion | what to measure in the browser |
| Risk | shared component, regression surface, unknown |

If a decision has no implementation site, say so and ask whether it is new work or out of scope. If two decisions conflict in code, report it.

## 10. Output of discovery

- A short summary: stack, theme/token layer, shell/nav model, screens, data layer, commands.
- The plan table from step 9.
- A list of assumptions and open questions.
- No persisted file. The plan is the artifact; the next run discovers again.
