# delta schema

Written by Step 6 of the `design-decisions` skill after every locked round, at
`design/deltas/delta-<round>.json`. It records what changed so an implementation
skill can prioritize work. It is a change log, not the source of truth:
`DESIGN.md` and `design/pages/<slug>.md` stay canonical.

## Naming

The round label comes from the choices file, like the preview output:

| Choices file | Delta file |
|---|---|
| `.design/choices-k1.json` | `design/deltas/delta-k1.json` |
| `.design/choices-k2.json` | `design/deltas/delta-k2.json` |
| `.design/choices-k2-chat.json` | `design/deltas/delta-k2-chat.json` |

Create `design/deltas/` if needed. One file per round; re-running the same round
overwrites it.

## Schema

```json
{
  "project": "example-app",
  "round": "k2-pricing",
  "layer": 2,
  "created_at": "2026-11-24T21:40:00Z",
  "version_from": 2,
  "version_to": 3,
  "design_files": ["DESIGN.md", "design/pages/pricing.md"],
  "scopes": [
    {
      "scope": "pricing",
      "slug": "pricing",
      "source": "design/pages/pricing.md",
      "changes": [
        {
          "id": "D10",
          "kind": "changed",
          "title": "Pricing: plan cards",
          "from": {"choice": "A", "name": "Comparison table", "values": "single table"},
          "to": {"choice": "C", "name": "Plan cards", "values": "three cards · highlighted middle plan"},
          "to_fingerprint": "sha256:…",
          "note": ""
        }
      ]
    }
  ]
}
```

## Fields

- **project, round, layer, created_at:** identity of the round. `round` is the label from the choices filename.
- **version_from / version_to:** `DESIGN.md` version before and after the round; `version_from` is `null` for the first Layer 1 round.
- **design_files:** files written or updated by this round, relative to the project root.
- **scopes[]:** one entry per scope with at least one change; unchanged scopes are omitted. For Layer 1 use one entry with `scope: "global"`, `slug: "global"`, `source: "DESIGN.md"`.
- **scope, slug, source:** human scope name, page-file slug, and the file that now holds the decisions (`DESIGN.md` while Layer 2 is still inline).
- **changes[]:** `kind` is `added`, `changed` or `removed`; `from`/`to` are `null` for added/removed. `from` comes from the files read before writing, `to` from the locked values; for `OTHER`, use `{"choice": "OTHER", "desc": "<description>"}`. Include the user's `note` verbatim.
- **to_fingerprint:** the `fingerprint` that `check` reports for the decision after the round; `null` for `removed`. An implementation skill stores it in its applied-ledger and re-applies when it changes.

## Fingerprint

`check` computes it, so copy it from the `check` output instead of recomputing:

- Normal choice: `sha256` of `{"id": "<Dxx>", "choice": "<alternative id>", "values": "...", "vars": {...}, "html": "..."}`.
- `OTHER`: `sha256` of `{"id": "<Dxx>", "choice": "OTHER", "desc": "<description>"}`.
- Serialize with `json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`, UTF-8, and prefix the hex digest with `sha256:`.
- `KEEP` is fingerprinted like any other alternative id.

## Rules

- Emit the file only after the round is locked; never for an unanswered or invalid round.
- Only `added`, `changed` and `removed` decisions appear; don't list rejected alternatives or unchanged decisions.
- The locked files are canonical. Never edit them to make the delta match.
- No comments; valid UTF-8 JSON with ASCII keys.
- If `check` is unavailable (manual Copy path), write the delta without `to_fingerprint` and say so in the user summary; an implementation skill must then fall back to comparing versions.
