# @anneal-memory/paperclip-plugin

First-class four-layer memory for [Paperclip](https://github.com/paperclipai/paperclip) agents, wrapping the [anneal-memory](https://github.com/phillipclapham/anneal-memory) Python MCP server.

**Status:** v0.0.1 scaffold. Not yet installable. Build + integration testing pending.

## What it gives Paperclip agents

- **Episodic store** — typed episodes (observation / decision / tension / question / outcome / context) with SHA-256 hash-chained audit trail
- **Continuity file** — compressed agent memory loaded at session start, citation-validated at compression time
- **Hebbian associations** — co-citation links between episodes, decayed over time
- **Limbic affective tagging** — functional-state modulation of association strength
- **Immune system** — citation gaming detection + active demotion of ungrounded graduations

## Architecture

```
Paperclip host (Node.js)
    ↕  JSON-RPC over stdio (Paperclip plugin protocol)
@anneal-memory/paperclip-plugin (this package — TS worker)
    ↕  JSON-RPC over stdio (MCP 2024-11-05)
anneal-memory Python MCP server (per-agent subprocess)
    ↕  Python library calls
SQLite store + continuity markdown file
```

One MCP child process per Paperclip agent. Each agent gets an isolated SQLite store at `<storeBasePath>/<agentId>/memory.db`.

## Tools registered (V0.0.1)

All six anneal-memory MCP tools surface as Paperclip agent tools under the `anneal-memory:` namespace:

- `anneal-memory:record` — record typed episode
- `anneal-memory:recall` — query episodes (time / type / source / keyword filters)
- `anneal-memory:prepare_wrap` — get compression package at session boundary
- `anneal-memory:save_continuity` — validate + save compressed continuity
- `anneal-memory:delete_episode` — GDPR-grade delete with tombstone
- `anneal-memory:status` — memory health metrics

## Requirements

- Node.js 20+
- Paperclip v2026.512.0 or later
- `anneal-memory` Python MCP server installed and reachable via PATH (or override via `mcpCommand` plugin config)

## Install (planned)

```bash
pnpm paperclipai plugin install @anneal-memory/paperclip-plugin
```

## Config

| Key | Default | Description |
|---|---|---|
| `mcpCommand` | `anneal-memory` | Path / command name for the Python MCP server executable |
| `storeBasePath` | `~/.paperclip/data/plugins/anneal-memory/stores` | Base directory for per-agent SQLite stores |
| `autoRecordEvents` | `false` | When true, auto-record Paperclip events as `observation` episodes |

## License

MIT
