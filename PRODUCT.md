# Product

## Register

product

## Users

A developer or tech lead working on a self-hosted, air-gapped network. They run unattended Jira bug sweeps and interview-driven enhancement and feature sessions. The studio usually lives on a second monitor or in a narrow window beside an IDE, and sessions can run for minutes or hours — often scheduled overnight. The job: start a safe, correctly scoped run with as few decisions as possible, see what is happening now, catch the handful of outcomes that need human judgment, and leave an auditable trail.

## Product Purpose

`sdd studio` is the local operator console for sdd's autonomous workflows. It turns CLI-only automation into a glanceable, trustworthy control surface: Jira bugs in, reviewed commits and a merge request out; a change request in, a reviewed plan or spec out. Success means the operator can walk away, come back, and understand exactly what happened without reading raw logs — and never worries that the tool touched the wrong tree or the wrong system.

## Brand Personality

Calibrated, candid, unhurried. The voice of a good technical editor: precise, plain, quietly confident. It should feel like a well-kept instrument and a well-kept document — not a product demo, not a chat toy.

## Anti-references

- Neon cyberpunk terminal: glow, saturated cyan or magenta on black.
- GitHub / Jira clone: the familiar blue-gray developer panel, dense for density's sake.
- AI chat interface: bubbles, avatars, "talk to the AI".
- SaaS card dashboard: nested cards, gradient headings, hero metrics, identical card grids.
- Cream / sand "editorial" pastiche: warm beige paper used as a shortcut for taste.

## Design Principles

1. **State before controls.** The current run, what needs attention, and what happens next are visible before any setting.
2. **Plain language over jargon.** "Start fixing bugs", not "Start sweep". Internal event names never reach the screen.
3. **Safety is legible.** Isolated worktree, read-only Jira, no force push, local-only storage, and approval-gated writes are stated where the decision is made, not buried in docs: the feature interview only writes its spec, and the enhancement interview changes code only after the plan is approved.
4. **The document is the interface.** A run produces an auditable record: plan, log, per-bug outcome, review flags. An interview session keeps its opening message and transcript; the rendered plan, report, or spec is the review surface, with the raw text one click away.
5. **Quiet until it matters.** One action color, one attention color. Everything else is ink and paper. Motion explains, never decorates.
6. **Configuration is a drawer, not the room.** Defaults are computed; only decisions a human must make are exposed.

## Accessibility & Inclusion

WCAG 2.2 AA. Body text at least 4.5:1, large text at least 3:1. Full keyboard operation with visible focus. Native dialog semantics, labelled controls, status announced through a polite live region. Reduced-motion alternatives for every animation. Colour is never the only carrier of state (dot + label + shape). The layout holds at 320px width and at 200% zoom.
