# @anneal-memory/paperclip-plugin

First-class four-layer memory for [Paperclip](https://github.com/paperclipai/paperclip) agents, wrapping the [anneal-memory](https://github.com/phillipclapham/anneal-memory) Python MCP server.

---

## ⛔ Maintenance mode — terminal at v0.0.2 (May 14, 2026)

**This plugin is no longer under active development.** v0.0.2 on npm continues to work for whoever wants it, with the manual upstream patch documented below.

**Why:**
- 5 high-quality bug reports filed against `paperclipai/paperclip` (#5916, #5932, #5933, #5935, #5937) received zero maintainer engagement in 24+ hours while Paperclip shipped two new releases (`2026.513.0` stable, `2026.514.0-canary.1`). Signal: Paperclip is running an internal roadmap, not a community-issue triage process. Building distribution-surface plugins against a closed-vision framework has a low return ceiling.
- Paperclip native memory is the structural substitute on a Q3-Q4 2026 timeframe. Plugin-shape memory becomes legacy when that ships.
- The generally-stronger distribution surface for anneal-memory's four-layer architecture is the **standalone Python MCP server** ([`anneal-memory` on PyPI](https://pypi.org/project/anneal-memory/)). It wires into any harness — Claude Code, OpenCode, custom — not just Paperclip.

**For operators who want anneal-memory in their agent stack:**

```bash
pip install anneal-memory
```

Then wire its MCP server into your harness directly. No Paperclip-host patches required. Full documentation at [github.com/phillipclapham/anneal-memory](https://github.com/phillipclapham/anneal-memory).

**Design exploration preserved:** The `v0.1.0-archived` branch contains 28 hours of design work (autoRecordEvents wiring, validateConfig RPC, onHealth probe, retry/queue policy) and 46/46 passing smoke tests against SDK `2026.513.0`. Never released; preserved for anyone investigating the design space. Commit log explains the decision chain.

**Upstream bug filings remain open** — they document real Paperclip-runtime issues independent of this plugin's status.

---

**Status:** v0.0.1 — full stack end-to-end validated against Paperclip 2026.512.0 on May 13, 2026 across 4 named load tests (B1/B2/B3/B1.5) plus an ANN-13 v2 4-wrap sustained-load sequence demonstrating immune-system demotion and closed-loop learning in production (see [In-production validation](#in-production-validation)). 5 upstream Paperclip findings filed day-one (see [Filed upstream](#filed-upstream)). Working but requires an upstream Paperclip patch + a one-time agent-instructions edit. See [Known Limitations](#known-limitations) before installing.

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

## In-production validation

The architectural claim is that the four-layer memory + immune system
produces **compression-with-intelligence** — memory that gets smarter
(not just longer) as evidence accumulates. The ANN-13 v2 4-wrap sequence
on May 13, 2026 demonstrates this in production runtime:

| Wrap | Continuity size | What happened |
|---|---|---|
| #2 | 6,373 chars | New patterns surfaced from heartbeat #1 evidence. |
| **#3** | **5,804 chars** | **Immune system demoted a bad self-citation. Continuity SHRANK 569 chars.** Agent re-examined a pattern it had graduated earlier, ruled the supporting evidence didn't hold, removed the graduation. |
| **#4** | 7,027 chars | **Closed-loop learning.** Agent codified the wrap-#3 demotion lesson as a new pattern AND applied it on the next graduation evaluation. Memory got smarter because it corrected itself. |

This is the architecturally distinctive behavior versus flat-retrieval
memory substrates: graduation + active demotion + structurally-enforced
compression produce process evolution, not bloat-instead-of-smart.

Three additional named load tests passed earlier the same day:

- **B1 — single-agent wrap cycle (Claude C-level): PASS.** Full
  wrap completed autonomously with 4-section FlowScript continuity;
  agent surfaced a novel runtime quirk (Finding #5) as a pattern
  unprompted.
- **B2 — multi-agent C-level coordination: PASS.** Parallel CMO + CTO
  agents; each SQLite store contained only its own episodes. Direct
  refutation of the global-continuity-fills-too-fast failure mode.
- **B3 — Codex C-level wrap cognition: PASS-WITH-NUANCE.** Codex
  executed valid wrap-class cognition (4 min vs Claude's 1 min, more
  methodical, one tombstone self-correction). Refutes strong "Codex
  can't run wraps" claim; texture difference is real, mechanical
  capability holds.
- **B1.5 — cold-session memory carry-forward: PASS.** Agent on a
  cold-context session read its own continuity, refused to redo B1,
  proposed B2-style continuity-merge as next test, surfaced a novel
  meta-pattern (write-path vs read-path test taxonomy).

Full receipt in [CHANGELOG.md](./CHANGELOG.md).

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

## Quickstart

Five steps to a working install on Paperclip 2026.512.0. Will collapse
to a one-liner once Paperclip ships the [#5916](https://github.com/paperclipai/paperclip/issues/5916)
patch upstream.

### 1. Install `anneal-memory` (Python MCP server) globally

The plugin spawns this as a child process per agent. Must be on PATH.

```bash
uv tool install anneal-memory
# Verify:
which anneal-memory && anneal-memory --version
```

Alternative paths (`pipx`, virtualenv) work too; override via the plugin's
`mcpCommand` config field.

### 2. Apply the upstream #5916 patch to your Paperclip server

Required until the patch lands upstream. Two-line fix in the compiled JS
of your installed `@paperclipai/server` package:

```diff
--- a/dist/services/plugin-tool-dispatcher.js  (~line 210)
+++ b/dist/services/plugin-tool-dispatcher.js
-    registerPluginTools(pluginId, manifest) {
-        registry.registerPlugin(pluginId, manifest);
+    registerPluginTools(pluginId, manifest, pluginDbId) {
+        registry.registerPlugin(pluginId, manifest, pluginDbId);
     },

--- a/dist/services/plugin-loader.js  (~line 1151)
+++ b/dist/services/plugin-loader.js
-                toolDispatcher.registerPluginTools(pluginKey, manifest);
+                toolDispatcher.registerPluginTools(pluginKey, manifest, pluginId);
```

The `pluginId` variable is already in scope at the call site. No new
lookups or async paths required.

Full reproduction steps + line-number context in
[#5916](https://github.com/paperclipai/paperclip/issues/5916) and
[UPSTREAM_PAPERCLIP_FINDINGS.md](./UPSTREAM_PAPERCLIP_FINDINGS.md).

Restart your Paperclip server after applying the patch.

### 3. Install the plugin

From a local checkout (the canonical path while Paperclip's published
install command awaits #5916):

```bash
git clone https://github.com/phillipclapham/anneal-memory-paperclip-plugin
cd anneal-memory-paperclip-plugin
npm install && npm run build

# From your Paperclip instance host:
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/anneal-memory-paperclip-plugin","isLocalPath":true}'
```

Verify the plugin loaded:

```bash
curl http://127.0.0.1:3100/api/plugins
# Look for: status: "ready", lastError: null, tools: 6
```

### 4. Teach your agent about the plugin tools

Paperclip's `claude_local` adapter does not auto-discover plugin tools in
v2026.512.0. Drop the `TOOLS.md` template into your agent's instructions
bundle:

```bash
cp TOOLS.md ~/.paperclip/agents/<your-agent>/instructions/TOOLS.md
```

The template is the agent's instructions verbatim — operator-facing
intro at the top, agent-bound content below the divider. No editing
required.

### 5. Verify end-to-end

Have your agent call `anneal-memory:status`. Expected response shape:

```json
{
  "episode_count": 0,
  "continuity_chars": 0,
  "wrap_state": "ready",
  "hebbian_density": 0,
  "audit_chain_ok": true
}
```

If you see this, the full stack — agent → Paperclip dispatcher → plugin
worker → MCP child → SQLite store — is working. Memory health check
passed. Begin recording episodes; call `prepare_wrap` + `save_continuity`
at session boundaries to graduate patterns.

---

**Future state** (once Paperclip ships #5916 upstream): steps 2 and 3
collapse to a single line.

```bash
uv tool install anneal-memory
paperclipai plugin install @anneal-memory/paperclip-plugin
cp TOOLS.md ~/.paperclip/agents/<your-agent>/instructions/TOOLS.md
```

Step 4 may also become unnecessary if Paperclip adds plugin-tool
auto-discovery for `claude_local`.

## Config

| Key | Default | Description |
|---|---|---|
| `mcpCommand` | `anneal-memory` | Path / command name for the Python MCP server executable. Override for `uvx`, `pipx`, or virtualenv installs. |
| `storeBasePath` | `~/.paperclip/data/plugins/anneal-memory/stores` | Base directory for per-agent SQLite stores. Each Paperclip agent gets a subdirectory: `<storeBasePath>/<agentId>/memory.db`. |
| `autoRecordEvents` | `false` | (v0.0.1: declared but not yet implemented — see [Known Limitations](#known-limitations).) When implemented, will auto-record Paperclip events as `observation` episodes. |

## Teaching Your Agent About anneal-memory

In Paperclip 2026.512.0, plugin tools are exposed on
`/api/plugins/tools/execute` but the `claude_local` adapter does not
inject them into Claude Code's tool set. The agent must be told the
tools exist and how to call them.

Drop-in template lives at **[`TOOLS.md`](./TOOLS.md)**. Copy into your
agent's instructions bundle:

```bash
cp TOOLS.md ~/.paperclip/agents/<your-agent>/instructions/TOOLS.md
```

The template is the agent's instructions verbatim — operator-facing
intro at the top, agent-bound content below the divider. No editing
required.

(This manual injection step will likely be unnecessary in future
Paperclip versions once the project addresses plugin-tool
auto-discovery for the `claude_local` adapter.)

## Known Limitations

### Methodology-under-Paperclip-runtime: validated single-cycle, sustained-load open

**Read this carefully before relying on the plugin in production.** Today's
load testing (May 13, 2026) updated the validation status:

**What v0.0.1 has validated** under Paperclip 2026.512.0 runtime:

- Storage layer — install/register/dispatch/execute path clean,
  per-agent SQLite isolation verified, audit chain holds.
- **Wrap discipline + pattern graduation** — B1 single-agent + B3 Codex
  wrap cycles both completed with structurally-correct 4-section
  FlowScript continuity; graduation criteria fired correctly.
- **Immune system in production** — ANN-13 v2 wrap #3 demoted a bad
  self-citation autonomously; continuity SHRANK by 569 chars (see
  [In-production validation](#in-production-validation)).
- **Closed-loop learning** — ANN-13 v2 wrap #4 codified the demotion
  lesson as a pattern and applied it on the next graduation.
- **Multi-agent autonomous coordination** — B2 CMO + CTO parallel
  agents maintained per-store isolation under Paperclip's multi-agent
  coordination semantics.
- **Cross-substrate wrap cognition** — B3 confirmed Codex can run
  wrap-class cognition on the plugin contract (texture difference vs.
  Claude exists; mechanical capability holds).
- **Cold-session carry-forward** — B1.5 agent on a fresh context read
  its own continuity and refused to redo prior work; wrap-thrash
  disconfirmed at session-cold boundary.

**What v0.0.1 does NOT yet validate:** sustained operational load over
days and weeks. Heartbeat cadence over many cycles, day-over-day
continuity carry-forward at production scale, multi-week pattern
accumulation, multi-tenant coordination at scale. Single-cycle
methodology execution under Paperclip's runtime now has empirical
receipts; sustained-load is the remaining hypothesis.

Specific Paperclip semantic blockers — current status:

- **Wrap-thrash from heartbeat-driven wrap cadence.** DISCONFIRMED in
  single-cycle scope (B1 + B1.5). Open at sustained-load scope.
- **Mid-wrap agent restart.** Hypothetical — storage-layer 2PC handles
  partial commits; runtime-abort behavior in production not tested.
- **Tool budget exhaustion mid-wrap.** DISCONFIRMED in single-cycle
  scope; B1/B2/B3 wraps all completed within heartbeat budgets at
  observed tool-call counts.
- **Double-tracking drift.** OPEN. Paperclip tracks coordination via
  issues/comments; plugin tracks via episodes. Canonical correspondence
  still ad hoc.
- **Workspace state authority conflict.** OPEN. `project_workspaces`
  and per-agent plugin data dir are two filesystem authorities for
  "agent state." Long-run drift potential.
- **Model substrate axis.** CONFIRMED real (and orthogonal to the plugin).
  Codex executes mechanical wrap cognition but with detectable texture
  difference vs. Claude (more methodical, less novel-pattern surfacing).
  Operator should assign Claude Sonnet or Opus to wrap-executing C-level
  roles; the plugin enforces nothing about this.

**Position to hold publicly:** plugin is mechanical infrastructure
validated AND single-cycle methodology execution under Paperclip
runtime is validated, including immune system + closed-loop learning
in production. Sustained-load behavior over days/weeks remains the
open empirical question. The first operator to deploy at production
scale is the v0.1 validation gate. If you surface specific failure
modes, please open an issue with reproduction steps — that data IS
the v0.1 spec.

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

## Filed upstream

Five Paperclip findings surfaced during plugin development and load
testing, all filed against [paperclipai/paperclip](https://github.com/paperclipai/paperclip):

- **[#5916](https://github.com/paperclipai/paperclip/issues/5916)** —
  Plugin tool execution always 502s because `registerPluginTools`
  drops the plugin's UUID `dbId`. Two-line patch inlined in the issue.
  **Required** for this plugin to work end-to-end. Detailed reproduction
  steps + offline reference in [UPSTREAM_PAPERCLIP_FINDINGS.md](./UPSTREAM_PAPERCLIP_FINDINGS.md).
- **[#5932](https://github.com/paperclipai/paperclip/issues/5932)** —
  `acpx_local` adapter ships without the `claude-agent-acp` runtime
  dependency. Workaround: use `claude_local` adapter.
- **[#5933](https://github.com/paperclipai/paperclip/issues/5933)** —
  `PAPERCLIP_PROJECT_ID` env var sometimes empty/unset. Agent
  self-recovers via cwd-path parsing.
- **[#5935](https://github.com/paperclipai/paperclip/issues/5935)** —
  Heartbeat wake fires on agent's own issue comments, producing a
  sub-minute self-perpetuating wake-loop. Workaround: agents record
  state to plugin memory only, operators read state out-of-band, no
  agent self-comments on assigned issues.
- **[#5937](https://github.com/paperclipai/paperclip/issues/5937)** —
  Auto-recovery flow creates sibling issues whose run contexts override
  issue-level operator protocol (e.g., "operator owns close" rules).

Full triage notes + load-test context in
[UPSTREAM_PAPERCLIP_FINDINGS.md](./UPSTREAM_PAPERCLIP_FINDINGS.md) and
[CHANGELOG.md](./CHANGELOG.md).

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
