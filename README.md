# @anneal-memory/paperclip-plugin

First-class four-layer memory for [Paperclip](https://github.com/paperclipai/paperclip) agents, wrapping the [anneal-memory](https://github.com/phillipclapham/anneal-memory) Python MCP server.

**Status:** v0.0.1 — full stack end-to-end validated against Paperclip 2026.512.0 on May 13, 2026. Working but requires an upstream Paperclip patch + a one-time agent-instructions edit. See [Known Limitations](#known-limitations) before installing.

---

## ⚠ Read this before installing

**Two things must be done outside this package for the plugin to work end-to-end:**

### 1. `anneal-memory` must be on PATH

The plugin spawns the [anneal-memory](https://github.com/phillipclapham/anneal-memory) Python MCP server as a child process. If `anneal-memory` is not resolvable via PATH, the plugin worker will start but every tool call will fail at child-spawn time.

Install once globally:
```bash
uv tool install anneal-memory
# Verify:
which anneal-memory && anneal-memory --version
```

Alternative paths (pipx, virtualenv) work too; override via the plugin's `mcpCommand` config field.

### 2. Paperclip 2026.512.0 has an upstream tool-registry bug that prevents executeTool from reaching plugin workers

Symptom: every plugin tool call returns `Cannot execute tool "<name>" — worker for plugin "<id>" is not running` even though the worker process is running and tools are registered.

Root cause: `plugin-loader.js` calls `toolDispatcher.registerPluginTools(pluginKey, manifest)` without passing the plugin's UUID dbId. The tool registry then defaults `pluginDbId` to `pluginKey` (the short manifest id). When `executeTool` checks `workerManager.isRunning(tool.pluginDbId)`, it looks up the short id in a workers map keyed by UUID → false → 502.

Filed upstream: **[paperclipai/paperclip#5916](https://github.com/paperclipai/paperclip/issues/5916)** — see that issue for the complete bug report, two-line patch, and reproduction steps. The same detail is also captured in [UPSTREAM_PAPERCLIP_FINDINGS.md](./UPSTREAM_PAPERCLIP_FINDINGS.md) for offline reference. Until Paperclip ships a fix, this plugin requires the patch from issue #5916 applied to the installed `@paperclipai/server` package.

### 3. Plugin tools aren't auto-discovered by `claude_local` agents

Paperclip's `claude_local` adapter does NOT inject plugin tools into Claude Code's runtime tool set. Even after the upstream patch lands, the agent has to be told about the plugin's tools via its instructions bundle. See [Teaching Your Agent About anneal-memory](#teaching-your-agent-about-anneal-memory) below.

---

## What it gives Paperclip agents

- **Episodic store** — typed episodes (`observation` / `decision` / `tension` / `question` / `outcome` / `context`) with SHA-256 hash-chained audit trail
- **Continuity file** — compressed agent memory loaded at session start, citation-validated at compression time
- **Hebbian associations** — co-citation links between episodes, decayed over time
- **Limbic affective tagging** — functional-state modulation of association strength
- **Immune system** — citation-gaming detection + active demotion of ungrounded graduations
- **Per-agent isolation** — each Paperclip agent gets its own SQLite store at `<storeBasePath>/<agentId>/memory.db`

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

One MCP child process per Paperclip agent, lazy on first tool call. The pool reuses bridges within a worker lifetime and installs process-level shutdown handlers so MCP children don't become orphans if the parent dies.

## Tools registered

All six anneal-memory MCP tools surface as Paperclip agent tools under the `anneal-memory:` namespace:

| Tool | Purpose |
|---|---|
| `anneal-memory:record` | Record a typed episode (observation/decision/tension/question/outcome/context) |
| `anneal-memory:recall` | Query episodes — time / type / source / keyword / limit filters |
| `anneal-memory:prepare_wrap` | Get compression package at session boundary; mints a `wrap_token` |
| `anneal-memory:save_continuity` | Validate + save compressed continuity, with structure / citation-grounding / citation-gaming checks |
| `anneal-memory:delete_episode` | GDPR-grade delete by episode ID with tombstone preservation |
| `anneal-memory:status` | Memory health metrics (counts, wrap state, Hebbian density, audit chain) |

## Requirements

- Node.js 20+
- Paperclip v2026.512.0 or later (with [upstream patch](./UPSTREAM_PAPERCLIP_FINDINGS.md) applied)
- `anneal-memory` Python MCP server installed and reachable via PATH

## Install (planned — once Paperclip upstream lands the fix)

```bash
paperclipai plugin install @anneal-memory/paperclip-plugin
```

Or from a local checkout during development:
```bash
git clone https://github.com/phillipclapham/anneal-memory-paperclip-plugin
cd anneal-memory-paperclip-plugin
npm install && npm run build
# Then from your Paperclip instance:
/usr/bin/curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/anneal-memory-paperclip-plugin","isLocalPath":true}'
```

## Config

| Key | Default | Description |
|---|---|---|
| `mcpCommand` | `anneal-memory` | Path / command name for the Python MCP server executable. Override for `uvx`, `pipx`, or virtualenv installs. |
| `storeBasePath` | `~/.paperclip/data/plugins/anneal-memory/stores` | Base directory for per-agent SQLite stores. Each Paperclip agent gets a subdirectory: `<storeBasePath>/<agentId>/memory.db`. |
| `autoRecordEvents` | `false` | (v0.0.1: declared but not yet implemented — see [Known Limitations](#known-limitations).) When implemented, will auto-record Paperclip events as `observation` episodes. |

## Teaching Your Agent About anneal-memory

In Paperclip 2026.512.0, plugin tools are exposed on `/api/plugins/tools/execute` but `claude_local` adapter does not inject them into Claude Code's tool set. The agent must be told the tools exist + how to call them. Paste this into your agent's `instructions/TOOLS.md` once:

````markdown
# Memory Tools (anneal-memory plugin)

This agent has access to first-class persistent memory via the
`anneal-memory` Paperclip plugin. The Paperclip runtime provides
environment variables for invoking these tools:

- `PAPERCLIP_API_URL` — Paperclip server URL
- `PAPERCLIP_AGENT_ID` — your agent UUID
- `PAPERCLIP_COMPANY_ID` — your company UUID
- `PAPERCLIP_PROJECT_ID` — current project UUID
- `PAPERCLIP_RUN_ID` — current run UUID

To invoke a plugin tool, POST to `$PAPERCLIP_API_URL/api/plugins/tools/execute`
with body shape:
```json
{
  "tool": "anneal-memory:<tool_name>",
  "parameters": { ... tool-specific args ... },
  "runContext": {
    "agentId": "$PAPERCLIP_AGENT_ID",
    "runId": "$PAPERCLIP_RUN_ID",
    "companyId": "$PAPERCLIP_COMPANY_ID",
    "projectId": "$PAPERCLIP_PROJECT_ID"
  }
}
```

## Available tools

- **anneal-memory:record** — record an episode. Required: `content` (string),
  `episode_type` (one of: observation, decision, tension, question, outcome, context).
  Optional: `source` (string), `metadata` (object).
- **anneal-memory:recall** — query episodes. All optional: `since` (ISO 8601),
  `until` (ISO 8601), `episode_type`, `source`, `keyword`, `limit` (default 100), `offset`.
- **anneal-memory:prepare_wrap** — get compression package at session boundary.
  Returns a `wrap_token` (32-char hex) you MUST pass to save_continuity.
  Optional: `max_chars` (default 20000), `staleness_days` (default 7).
- **anneal-memory:save_continuity** — save compressed continuity.
  Required: `text` (markdown with `## State / ## Patterns / ## Decisions / ## Context` sections).
  Optional: `wrap_token` (from prepare_wrap), `affective_state` ({ tag, intensity }).
- **anneal-memory:delete_episode** — delete by id. Required: `episode_id`.
- **anneal-memory:status** — health metrics. No args.

## When to use these tools

- Record decisions, tensions, observations as they happen during work.
- Recall prior episodes before making related decisions.
- At session end (long-running tasks, end of run): call prepare_wrap,
  compose a compressed continuity, save_continuity. This persists
  learned patterns across heartbeats.
````

(This manual injection step will likely be unnecessary in future Paperclip
versions once the project addresses plugin-tool auto-discovery for the
`claude_local` adapter.)

## Known Limitations

### Methodology-under-Paperclip-runtime is not yet validated at load

**Read this carefully before relying on the plugin in production.** v0.0.1
mechanically validates that the anneal-memory storage layer works as a
Paperclip plugin: the install/register/dispatch/execute path is clean,
per-agent SQLite isolation is verified, audit chain holds. What v0.0.1
does NOT yet validate is whether the FLOW methodology layer (wrap
discipline, pattern graduation, immune system, consultation synthesis)
executes correctly when run autonomously by Paperclip C-level agents
under load.

The CLI / human-AI partnership / cognitive_loop autonomous proofs that
the underlying methodology works all run OUTSIDE Paperclip's runtime
model. Paperclip's runtime introduces its own semantics — heartbeat
cadence, agent restart model, per-heartbeat tool budgets, inter-agent
coordination via issues/comments, workspace state authority — and we
have not yet seen whether these interact cleanly with FLOW execution at
sustained operational load.

Specific Paperclip semantic blockers worth watching for:

- **Wrap-thrash from heartbeat-driven wrap cadence.** If wraps fire on
  every heartbeat, compression material is too thin → graduation criteria
  don't fire → continuity drifts into noise. FLOW wraps assume session
  boundaries with meaningful work between them.
- **Mid-wrap agent restart.** A restart between `prepare_wrap`'s
  `wrap_token` mint and `save_continuity` invalidates the token and
  loses wrap material. Storage-layer 2PC handles partial commits; doesn't
  help if the runtime aborts cognitive work mid-flight.
- **Tool budget exhaustion mid-wrap.** A real wrap is many tool calls
  (recall context + prepare_wrap + intermediate compression + save). If
  Paperclip caps tool calls per heartbeat below wrap-cost, wraps cannot
  complete in one heartbeat → wrap-shaped output without wrap meaning.
- **Double-tracking drift.** Paperclip tracks coordination via issues/
  comments; anneal-memory tracks via episodes. No canonical correspondence
  between the two yet. Drift risk over time.
- **Workspace state authority conflict.** Paperclip's `project_workspaces`
  and the plugin's per-agent data dir are two filesystem authorities for
  "agent state." Long-run drift potential.
- **Model substrate axis.** Codex / Gemini cannot reliably execute
  wrap-class cognition even on a clean memory backend. Plugin upgrades
  the memory axis only — operator MUST assign Claude Sonnet or Opus to
  the C-level role(s) responsible for wraps. The plugin enforces nothing
  about this.

**Position to hold publicly:** the plugin is mechanical infrastructure
validated. Whether methodology survives Paperclip runtime at load is a
hypothesis. The first operator to deploy under load is the validation
gate. If you are that operator and surface specific failure modes,
please open an issue with reproduction steps — that data IS the v0.1
spec.

### Other v0.0.1 boundaries (less critical, tracked for v0.1)

1. **`autoRecordEvents` config flag is declared but not yet wired** — when
   set, no `onEvent` handler is currently registered. Manifest field will be
   honored in v0.1.
2. **`onHealth` is shallow** — returns "ok" whenever the bridge pool exists.
   Does not probe per-agent MCP children for actual responsiveness.
3. **`validateConfig` RPC is not implemented** — bad config surfaces at first
   tool call instead of plugin install.
4. **Paperclip version pinned exact** to `2026.512.0`. Plugin will need
   re-validation against subsequent Paperclip releases (CalVer).
5. **No retry policy on the first tool call after MCP child auto-restart** —
   the auto-restart mechanism is in place (default 3 attempts, exponential
   backoff from 1s) but tool calls that happen during the restart window
   will fail. v0.1 will queue calls during recovery windows.

## Development

```bash
npm install
npm run typecheck       # tsc --noEmit
npm run build           # tsc → dist/
node test/smoke.mjs     # end-to-end smoke test against real anneal-memory subprocess
```

The smoke test exercises the bridge end-to-end against a real Python
subprocess without involving Paperclip:

- bridge start + initialize handshake
- record / recall / status round-trip
- prepare_wrap → save_continuity full wrap cycle with token validation
- BridgePool multi-agent isolation (separate subprocesses, no cross-store leakage)
- tool-level error conversion (`isError: true` → Promise rejection)

## License

MIT
