# choices.json schema

Input for `scripts/build_preview.py build`. One file per round: `.design/choices-k1.json`, `.design/choices-k2.json`, or `.design/choices-k2-<slug>.json` for a single-scope Layer 2 round. Output names follow the file: `choices-k2-chat.json` → `.design/choose-k2-chat.html` and `.design/choices-k2-chat.selections.txt`.

```json
{
  "project": "serenity-spa",
  "layer": 1,
  "title": "Layer 1 — Global decisions",
  "tokens": {},
  "sample": {
    "heading": "Calm your mind, restore your body",
    "text": "Massages, facials and rituals in a quiet space.",
    "primary": "Book a session",
    "secondary": "See treatments",
    "cardTitle": "Hot stone massage",
    "cardText": "60 min · from €80",
    "field": "Your email"
  },
  "decisions": [
    {
      "id": "D01",
      "title": "Color palette",
      "affects": "Every screen",
      "scope": "global",
      "preview": "components",
      "alternatives": [
        {
          "id": "A",
          "name": "Warm neutral",
          "desc": "Soft pink primary, charcoal text, gold CTA",
          "values": "#E8B4B8 · #2D3436 · #D4AF37",
          "vars": { "--primary": "#E8B4B8", "--text": "#2D3436", "--bg": "#FFF5F5", "--on-primary": "#2D3436" }
        },
        { "id": "KEEP", "name": "Keep current", "desc": "What the project uses today", "vars": {} }
      ]
    }
  ]
}
```

## Fields

- **project, layer** (required): `layer` is 1 or 2. They end up in the copied block and are checked by `check`.
- **tokens** (Layer 2): the locked Layer 1 CSS variables. Leave it empty: `build` reads them from the Tokens block of `DESIGN.md` (`--design-md PATH`, default `./DESIGN.md`). Every preview is drawn with them; an alternative's `vars` override them. Page files are not read by `build`: when re-asking a page whose file has overrides, put the effective values in `tokens` (or in the current alternative's `vars`).
- **decisions[].scope** (Layer 2): the screen or screen type the decision belongs to. Decisions with the same `scope` are written to one `design/pages/<slug>.md` (kebab-case ASCII of the scope, e.g. `project-chat`); reuse the slug of an existing file. Layer 1 decisions use `global`.
- **sample**: the project's real text for the built-in preview. Fill it from the scan; without it previews show generic text and `build` warns.
- **decisions[].preview**: `components` (default: swatches, heading, text, buttons, card, input), `type` (heading, text, small text; for fonts) or `none` (only the alternative's `html`).
- **alternatives[]**: `id` (A, B, C…, or `KEEP`; `OTHER` is reserved and added by the template), `name`, `desc`, `values` (concrete values in small print), optional `vars`, `preview`, `html`.
- `KEEP` ("Keep current") must carry the project's actual current `vars` or `html`, taken from the scan; otherwise its preview shows neutral defaults instead of today's style.
- At least 3 alternatives per decision, not counting `KEEP`. Neutral names and descriptions; no `selected`/`default`/`recommended`-style keys (the script rejects them).
- **ui** (optional): override template labels, e.g. `{"copy": "Copy choices", "copied": "Copied ✓", "send": "Send choices", "sent": "Sent ✓", "sentNote": "Choices sent. Return to the terminal — you can close this tab.", "sendFailed": "Could not send — use Copy", "todo": "Unanswered", "other": "Other (my own description)", "otherPh": "Describe what you want", "note": "Note (optional)", "affects": "Affected area", "fallback": "Copy this text manually:", "layer": "Layer"}`.

## Preview variables

Built-in previews read these CSS variables (all optional, with neutral defaults):
`--bg --surface --text --muted --primary --on-primary --accent --border --radius --space --shadow --font-heading --font-body`.
DESIGN.md's Tokens block uses these exact names, so Layer 2 previews can reuse them.

**No web fonts or any other network resource.** Previews must render offline: no `<link>`, `@import`, `url(...)` or CDN. Font alternatives use system/locally available stacks only (e.g. `system-ui, sans-serif`, `Georgia, serif`, `'Times New Roman', serif`, `Palatino, 'Palatino Linotype', serif`, `ui-monospace, Menlo, Consolas, monospace`). A font that isn't installed would silently fall back and mislead the choice, so don't offer it as an alternative; the user can name it under "Other". The script rejects a `fonts` field and warns on URLs.

## Custom `html` (layouts, flows, anything the variables can't show)

Inline HTML drawn inside the preview, styled by the same variables. Wireframe helper classes:
`.wf` (flex row) · `.wf-col` (column) · `.wf-b` (dashed box) · `.wf-f` (filled box) · `.wf-p` (primary box) · `.wf-t` (text line).

```html
<div class="wf"><div class="wf-f" style="flex:0 0 28%">Sidebar</div>
<div class="wf wf-col"><div class="wf-p">Order #1042</div><div class="wf-b"><div class="wf-t"></div></div></div></div>
```

Use the project's real labels and data inside wireframes. Set `"preview": "none"` when the wireframe is the whole preview.

## Selections block (what Send and Copy produce)

```
DESIGN-SELECTIONS project=<name> layer=<1|2>
D01: B (<alternative name>) | note: <if any>
D02: OTHER (<user description>) | note: <if any>
D03: —
```

## Script behavior worth knowing

- `build` warnings about contrast (< 4.5:1 for text/background, on-primary/primary, primary/background, muted/background), steering words or missing `sample` are not optional: fix the alternative and rebuild before delivering.
- `build --only D03,D05` renders just those decisions (for re-asking unanswered ones) as `.design/choose-k<layer>-partial.html`.
- `serve` runs `build` first (same validation, warnings and options), then serves `.design/choose-k<layer>.html` on `127.0.0.1` under a random token and opens the browser. When the page is served over HTTP the template shows **Send selections**; the button posts the selections block to the server, which writes `.design/choices-k<layer>.selections.txt` (`-partial` with `--only`), prints it and exits. Blocked until every decision is answered. Default `--timeout` is 1800s (exit code 3 if nothing arrives); `--no-open` suppresses the browser. Opened as a plain `file://`, Send is hidden and Copy is the only path.
- Output names derive from the choices filename: drop the `choices-` prefix and use the rest (`choices-k2-chat` → `choose-k2-chat`); `--only` appends `-partial`. A filename without the prefix falls back to `k<layer>`.
- This script never writes `DESIGN.md` or `design/pages/`: Step 6 does that from the `check` output (`design-md-template.md` for Layer 1 and the index, `page-md-template.md` per Layer 2 scope).
- `check` saves answers in `<choices>.resolved.json` and merges them across rounds, so `missing` always covers all decisions. An earlier answer is dropped if its alternative's name changed in the JSON. `--fresh` ignores saved answers.
- `check` adds a `fingerprint` to every resolved decision: `sha256` of its chosen `id`/`values`/`vars`/`html` (`OTHER`: its description), used by the delta manifest.
- `check` returns `tokens` (the chosen alternatives' `vars`, merged) and, per decision, the chosen alternative plus `rejected` (without `KEEP`). A chosen `KEEP` is flagged `unchanged`; an `OTHER` is flagged `custom` and has no `vars`, so derive its values from the description.
