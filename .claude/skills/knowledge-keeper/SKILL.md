---
name: knowledge-keeper
description: >
  Automatically logs new discoveries to CLAUDE.md files.
  Triggers when fixing bugs, discovering pitfalls, finding
  performance issues, or learning new patterns in the codebase.
user-invocable: false
---

# Knowledge Keeper

You are responsible for maintaining the project's institutional knowledge.

## When to Update

After ANY of these events:
- A bug is fixed -> log root cause and solution
- A non-obvious behavior is discovered -> log as pitfall
- A performance issue is identified -> log cause and fix
- A new integration pattern works -> log as learned pattern
- A workaround is needed -> log why and what

## Where to Update

- Match the discovery to the closest subdirectory CLAUDE.md
- If cross-cutting -> update root CLAUDE.md
- Existing subdirectory CLAUDE.md files:
  - `src/lib/structure/CLAUDE.md` — 3D viewer, rendering, InstancedMesh
  - `src/lib/symmetry/CLAUDE.md` — moyo-wasm, symmetry analysis
  - `src/lib/structure/workers/CLAUDE.md` — Bond Worker, WASM fallback
  - `extensions/rust/src/CLAUDE.md` — Rust WASM entry points
  - `server/CLAUDE.md` — Python backend, MCP server, CLI agents
  - `src/lib/api/CLAUDE.md` — Data access layer, three-tier routing

## Entry Format

```
### [YYYY-MM-DD] Short Title
**Category**: bug | pitfall | performance | pattern | workaround
**Context**: What were we trying to do
**Discovery**: What we found
**Solution/Note**: How it was resolved or what to watch out for
```

## Rules

- Keep entries concise (3-5 lines max)
- Never delete existing entries unless they are proven wrong
- If a section doesn't exist, create it under the appropriate heading
- Deduplicate: check if similar entry already exists before adding
- Use the date format from the currentDate context
- Write the entry IMMEDIATELY after discovery, don't batch or defer
