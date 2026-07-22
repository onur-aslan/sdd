# UI Heuristic Checklist (static-screenshot audit)

Core framing: for every criterion below, act like a UI/UX expert glancing
at the screenshot — what would they notice first, what would bother them,
what would they say should be different. Not a pixel-measuring tool, a
trained eye's first-pass judgment. Each criterion is just one angle of
that same expert glance.

Only criteria that are reliably scorable from a single static screenshot are
included. Interaction-dependent heuristics (keyboard nav, focus order,
inline validation, offline state, alt text) are intentionally excluded —
they require DOM/runtime inspection, not an image, and scoring them from a
screenshot produces false confidence.

For each criterion below, produce:
- `score`: 0-10
- `confidence`: high | medium | low
- `issues`: short bullet list of concrete problems seen in this image
- `fix`: concrete, actionable suggestion (component/CSS-level if possible)

## 1. Visual Hierarchy
Is there one clear primary focal point / primary CTA? Does the eye flow
logically (top-left → primary action, typical F/Z pattern)? Penalize
competing elements of equal visual weight.

## 2. Typography
≤3 font families. Clear size/weight distinction between heading and body.
Line length and size look readable at normal viewing distance.

## 3. Color Contrast
Text-to-background contrast looks like it meets WCAG AA (~4.5:1 for body
text, ~3:1 for large text/UI components). Status/state is not conveyed by
color alone (icon/label/pattern also present).

## 4. CTA Clarity
Primary action button uses a clear action verb ("Save changes", not
"Submit" or "OK" alone). No two CTAs of equal visual weight competing for
the same decision. Primary vs secondary buttons are visually distinct.

## 5. Layout
No overflow, clipped text, overlapping elements, or broken grid.

Is each component/menu/view placed where a UX expert would put it? Judge
like a UX reviewer: "this should be here, not there" — nav in the
conventional spot, controls near what they act on, nothing important
buried or blocking something else. Fix = say where it should move to.

## 6. Microcopy
Visible text is short, scannable, task-focused. No jargon or ambiguous
labels ("Continue" to what? "Yes" to what?).

## 7. Visual/Asset Quality
No broken images, pixelation, stretched/squished images, placeholder text
left in production ("Lorem ipsum", "TODO").

## 8. Above-the-Fold Priority
In the initial visible viewport (before scroll), is the primary value
proposition or primary CTA visible? Or is it buried below irrelevant
content?

---

## Explicitly out of scope for this audit (do not score, mark N/A)
Navigation flow correctness, form validation behavior, loading/empty/error
states, keyboard accessibility, focus indicators, alt text, multi-page
brand consistency (unless multiple screenshots of the same flow are
supplied). Note in the report that these require a separate
interaction-based or DOM-based audit.

## Overall score per screenshot
`overall = average of the 8 scores`, rounded to 1 decimal. Report
alongside the lowest-scoring criterion as the "top issue".
