# ASCII Mock Format for Vertical Slices

## Layer Overview Diagram

Show all layers and their components at a glance:

```
                    LAYER DIAGRAM
┌────────────────────────────────────────────┐
│  PRESENTATION                              │
│  ┌────────┐  ┌────────┐  ┌────────┐       │
│  │ Screen │  │ Widget │  │ Dialog │       │
│  └───┬────┘  └───┬────┘  └───┬────┘       │
├──────┼──────────┼──────────┼──────────────┤
│  DOMAIN         │          │              │
│  ┌───┴────┐  ┌──┴───┐  ┌──┴─────┐        │
│  │UseCase │  │Service│ │Manager │        │
│  └───┬────┘  └──┬───┘  └──┬─────┘        │
├──────┼──────────┼──────────┼──────────────┤
│  DATA           │          │              │
│  ┌───┴────┐  ┌──┴───┐  ┌──┴─────┐        │
│  │ Repo   │  │Gateway│ │ Store  │        │
│  └───┬────┘  └──┬───┘  └──┬─────┘        │
├──────┼──────────┼──────────┼──────────────┤
│  EXTERNAL       ▼          ▼              │
│  ┌────────┐  ┌────────┐  ┌────────┐       │
│  │REST API│  │ gRPC   │  │ Queue  │       │
│  └────────┘  └────────┘  └────────┘       │
└────────────────────────────────────────────┘
```

## Vertical Slice Detail Diagram

Create one diagram per vertical slice, showing how it cuts through all layers:

```
         VERTICAL SLICE 1: Read User Profile
         ────────────────────────────────────
         
         ┌──────────────┐
         │   Screen     │  ◄── ENTRY: User opens profile page
         └──────┬───────┘
                │
                ▼  ════════════════════════════
         ┌──────────────┐
         │  UseCase     │  ◄── Business logic: GetUserProfile
         └──────┬───────┘
                │
                ▼  ════════════════════════════
         ┌──────────────┐
         │  Repository  │  ◄── Data access layer
         └──────┬───────┘
                │
                ▼  ════════════════════════════
         ┌──────────────┐
         │  REST API    │  ◄── EXIT: GET /api/users/:id
         └──────────────┘
```

## Rules

- Show each vertical slice as a separate diagram
- Use `▼` for flow direction
- Use `═══` marks to highlight the slice path through layers
- Label ENTRY (top) and EXIT (bottom) points clearly
- Include a one-line description at each layer (what happens at that step)
- Include a brief description of what the slice validates (in the title)
