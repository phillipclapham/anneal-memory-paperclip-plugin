# Upstream Paperclip Findings — May 13, 2026

Five findings surfaced during plugin development + load-testing against Paperclip
2026.512.0. Findings #1, #4, and #5 are real bugs/gaps with clear repro steps.
Findings #2 and #3 are architectural/UX gaps. All five were validated end-to-end
and reproduced.

This document is structured so each finding can be lifted directly into a GitHub
issue against [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
without further synthesis. Finding #1 is already filed as
[paperclipai/paperclip#5916](https://github.com/paperclipai/paperclip/issues/5916).

## Load-test results (after Finding #1 patch applied)

The findings below were generated while running three load tests against a
local Paperclip 2026.512.0 instance with the Finding #1 two-line patch applied.
Each test validated a specific hypothesis about whether FLOW methodology can
execute under Paperclip's autonomous runtime:

- **B1 — single-agent wrap cycle (Claude C-level)**: PASS. Agent autonomously
  executed full wrap cycle (status → record × 3 → prepare_wrap → save_continuity
  → status) with structurally-correct 4-section FlowScript continuity, evidence
  citation, and even surfaced a novel runtime quirk (Finding #5) as a pattern.
  Heartbeat continuation did NOT trigger wrap-thrash — wrap-cadence hypothesis
  disconfirmed for this scenario.

- **B2 — multi-agent C-level coordination**: PASS. CMO + CTO Claude agents ran
  in parallel; each agent's SQLite store contained only its own episodes. Zero
  cross-contamination. BridgePool per-agent routing works under Paperclip's
  multi-agent coordination semantics. (Initial attempt with `acpx_local`
  adapter failed and surfaced Finding #4.)

- **B3 — Codex C-level wrap cognition**: PASS-WITH-NUANCE. Codex CAN execute
  wrap-class cognition end-to-end on the plugin contract — valid FlowScript
  continuity, evidence citation, even used a graduation marker. Took 4 minutes
  vs Claude's 1 minute, with more methodical exploration and one self-correction
  (tombstone). Cognitive texture difference vs Claude exists (Claude surfaced
  a novel runtime pattern; Codex executed exactly what was asked) but
  refutes the strong "Codex can't run wraps" claim.

**Conclusion**: Methodology executes under Paperclip runtime when the Finding #1
patch is applied. Wrap-thrash, mid-wrap restart, tool budget exhaustion, and
cross-store leakage hypotheses all disconfirmed in single-cycle scope.
Sustained-load behavior (heartbeat cadence over many cycles, day-over-day
continuity carry-forward, multi-week pattern accumulation) requires longer
testing than this session.

---

## Finding #1 — `executeTool` always returns 502 "worker not running" for plugins installed at runtime (REAL BUG, two-line patch)

### Severity

High. Every plugin that registers tools is unusable through the
`/api/plugins/tools/execute` HTTP endpoint until the server is restarted
AND the `initialize()` path in plugin-tool-dispatcher.js re-registers
the plugin via the 3-arg `registry.registerPlugin(...)` call.

But even server restart does NOT fully fix the issue, because the plugin
loader's `loadAll()` runs AFTER dispatcher initialize and calls the 2-arg
path which OVERWRITES the correct registration. Result: the bug applies on
both install path AND startup path.

### Symptom

Plugin installs cleanly. Worker process starts. 6/6 tools registered in
`plugin-tool-registry`. `GET /api/plugins/tools` lists the tools. Then:

```
POST /api/plugins/tools/execute
{
  "tool": "anneal-memory:status",
  "parameters": {},
  "runContext": { "agentId": "<valid uuid>", "runId": "<valid uuid>", "companyId": "<valid uuid>", "projectId": "<valid uuid>" }
}

→ 502
{
  "error": "Cannot execute tool \"anneal-memory:status\" — worker for plugin \"anneal-memory\" is not running."
}
```

The worker process IS running (verified via `ps`). The IPC channel is
healthy (verified — `plugin-worker-manager` logs `worker status running`).
The check that fails is `workerManager.isRunning(tool.pluginDbId)` inside
the registry's `executeTool`.

### Root cause

**File:** `server/src/services/plugin-loader.ts` (line ~1907 in source,
~1151 in compiled `dist/services/plugin-loader.js`)

```ts
toolDispatcher.registerPluginTools(pluginKey, manifest);
//                                  ^^^^^^^^^^
//   pluginKey = "anneal-memory" (the short manifest id)
//   the UUID dbId is in scope as `pluginId` but is NOT passed
```

**File:** `server/src/services/plugin-tool-dispatcher.ts` (line ~429 in
source, ~210 in compiled `dist/services/plugin-tool-dispatcher.js`)

```ts
registerPluginTools(pluginId, manifest) {
    registry.registerPlugin(pluginId, manifest);
    //                                ^^^^^^^^
    //   3rd arg (pluginDbId) is omitted
},
```

**File:** `server/src/services/plugin-tool-registry.ts` (line ~298-299 in
source, ~119-120 in compiled `dist/services/plugin-tool-registry.js`)

```ts
registerPlugin(pluginId, manifest, pluginDbId) {
    const dbId = pluginDbId ?? pluginId;
    //                         ^^^^^^^^
    //   falls back to pluginId (the SHORT key) when dbId is missing
    // ...
}
```

Each tool's `pluginDbId` then gets set to `"anneal-memory"` (the short
manifest id) instead of the UUID `"33af600d-04b0-..."` that the worker
manager uses as its map key. The `isRunning(dbId)` check in `executeTool`
calls `workers.get("anneal-memory")` → undefined → returns false → 502.

The `registerFromDb` path at line 269 of the dispatcher correctly passes
`plugin.id` as the third arg, but it's overwritten by the `registerPluginTools`
call from `plugin-loader.ts` immediately after.

### Patch (two lines)

```diff
--- a/server/src/services/plugin-tool-dispatcher.ts
+++ b/server/src/services/plugin-tool-dispatcher.ts
-    registerPluginTools(pluginId, manifest) {
-        registry.registerPlugin(pluginId, manifest);
+    registerPluginTools(pluginId, manifest, pluginDbId) {
+        registry.registerPlugin(pluginId, manifest, pluginDbId);
     },

--- a/server/src/services/plugin-loader.ts
+++ b/server/src/services/plugin-loader.ts
-                toolDispatcher.registerPluginTools(pluginKey, manifest);
+                toolDispatcher.registerPluginTools(pluginKey, manifest, pluginId);
```

The `pluginId` variable is already in scope at the call site (used in
adjacent log statements). No new lookups or async paths required.

### Reproduction

1. `npx paperclipai onboard -y --data-dir /tmp/repro/` then `npx paperclipai run --data-dir /tmp/repro/`
2. Build any plugin that declares tools in its manifest (the bundled
   `plugin-kitchen-sink-example` works) and install it via
   `POST /api/plugins/install` with `{isLocalPath: true, packageName: "/absolute/path"}`
3. Verify worker is running and tools are registered:
   - `GET /api/plugins` → status: "ready", lastError: null
   - `GET /api/plugins/tools` → tools listed with full schema
   - server log shows `worker process started and initialized` + `registered N tool(s)`
4. Create a company + agent + project via API. Capture all their UUIDs.
5. Find a real `runId` UUID from `/api/companies/<id>/live-runs` (or use a fresh agent-assigned issue).
6. `POST /api/plugins/tools/execute` with full real-UUID runContext.
7. Observe 502 `worker for plugin not running` despite worker process being alive.

### Workaround until patched

Manually edit the compiled JS in the installed Paperclip package as shown
in the diff above. Restart the Paperclip server. Tool execution then
works end-to-end.

### Evidence

This bug was caught and patched locally as part of
[anneal-memory-paperclip-plugin v0.0.1](https://github.com/phillipclapham/anneal-memory-paperclip-plugin)
development on May 13, 2026. After applying the patch, a full round-trip
`anneal-memory:status` → `anneal-memory:record` → `anneal-memory:recall`
→ `anneal-memory:status` succeeded against a real Paperclip agent run.
Episode `9b5513a3` was recorded by Paperclip's dispatcher, persisted to
SQLite via the plugin's MCP child subprocess, and verified by direct CLI
inspection of the store + audit hash chain validation.

---

## Finding #2 — Plugin tools are not auto-injected into `claude_local` (and likely `acpx_local`) agent runtimes

### Severity

Medium-high. Plugin tools registered with Paperclip do not appear in
Claude Code's tool list when running through the `claude_local` adapter.
The agent has no way to autonomously discover that the plugin exists.

### Symptom

After installing a plugin that registers tools, an agent running on
`claude_local` (Claude Code) was given a task that explicitly directed
it to call `anneal-memory:status`. The agent (Claude Opus 4.7) responded:

> "I'll handle this plugin validation test directly. Let me first check
> if the anneal-memory tools are available."

It then ran `ToolSearch` for `"anneal-memory"` and received
`"No matching deferred tools found"`. After several search attempts, it
concluded:

> "The anneal-memory:* tools aren't directly available in my tool set.
> Let me check the Paperclip plugin infrastructure to understand how to
> invoke them."

The agent then resorted to listing filesystem directories, reading config
files, inspecting `PAPERCLIP_*` env vars, and curl-ing endpoints to figure
out how plugin tools are invoked. It found the env vars but no
documentation in its instructions bundle about the `/api/plugins/tools/execute`
endpoint.

### Root cause (apparent)

Paperclip's `claude_local` adapter spawns Claude Code with its native
tool set (Bash, Read, Edit, Grep, ToolSearch, etc.) but does NOT augment
the tool list with plugin-registered tools. Plugin tools exist only on
Paperclip's HTTP API surface (`/api/plugins/tools/execute`), and the
agent has no documentation of that surface in its instructions bundle.

The agent's `instructions/TOOLS.md` is generated as:
```
# Tools

(Your tools will go here. Add notes about them as you acquire and use them.)
```

This is a placeholder that's never populated by Paperclip's plugin
lifecycle — even after a plugin with `agent.tools.register` capability is
installed and activated.

### Suggested fixes (any of these would work)

1. **Inject plugin tool documentation into agent instructions** — when
   a plugin with `agent.tools.register` capability is loaded, Paperclip
   appends the namespaced tool list (with descriptions + parameter schemas
   + the runContext-aware invocation pattern via `/api/plugins/tools/execute`)
   to the agent's `instructions/TOOLS.md`.

2. **Native tool injection at adapter layer** — for `claude_local`,
   teach Paperclip to inject plugin tools into Claude Code's MCP server
   list at agent startup so they appear as first-class tools.

3. **Operator manual step + documentation** — accept the manual snippet
   approach but make it discoverable (e.g., `paperclipai plugin docs <pluginKey>`
   command that prints the canonical TOOLS.md snippet for operators to paste).

### Why this matters

For self-hosted operators who actually want to use plugins (rather than
the plugin's existence being an architectural promise), this gap means
every plugin install requires a manual instructions edit per agent. That
significantly limits adoption — and contradicts the "additive,
capability-gated, isolated from core via stable SDK" framing in
PLUGIN_SPEC §6.2.

### Evidence

Reproduced May 13, 2026 against Paperclip 2026.512.0 with the
`anneal-memory-paperclip-plugin` v0.0.1 installed. Full agent reasoning
trace captured in the heartbeat-run log for run
`5b34a856-b086-44c3-8214-323dac32c5ca`. The agent's exploration consumed
~6 minutes of run time + 50+ tool calls before concluding the tools
were not available via its native tool set.

---

## Finding #3 — Plugin lifecycle disable/enable does NOT cleanly re-establish IPC

### Severity

Low-medium. Affects plugin developers iterating on local installs.

### Symptom

After a plugin's lifecycle is cycled via:
```
POST /api/plugins/<pluginDbId>/disable
POST /api/plugins/<pluginDbId>/enable
```

The plugin's tools are re-registered, the worker process is restarted
(visible in `ps`), and lifecycle logs report success:

```
plugin lifecycle: ready → disabled
plugin lifecycle: disabled → ready
starting plugin worker
worker status: stopped → starting → running
worker process started and initialized
registered 6 tool(s) for plugin
plugin activated successfully
```

BUT subsequent `executeTool` calls still return:
```
"Cannot execute tool — worker for plugin not running"
```

Uninstall + reinstall DOES work. Server restart DOES work (subject to
Finding #1). Only disable + enable specifically fails.

### Root cause (suspected, not confirmed)

The IPC channel between Paperclip's `plugin-worker-manager` and the
restarted worker process appears not to fully reconnect during a
disable/enable cycle. The worker process spawns and reports ready, but
the host's view of the worker IPC state stays stale. Could be a missing
re-attachment of stdin/stdout handlers, or a leftover handle from the
prior disabled state.

This is partially obscured by Finding #1, but reproduces independently:
after the upstream patch is applied, disable+enable still fails to
restore tool execution while uninstall+reinstall works.

### Reproduction

(Requires Finding #1 patch applied so we're not chasing two bugs.)

1. Install a plugin that registers tools.
2. Confirm `executeTool` works (returns 200 with structured result).
3. `POST /api/plugins/<pluginDbId>/disable` (verify worker stops in log).
4. `POST /api/plugins/<pluginDbId>/enable` (verify worker restarts + tools register in log).
5. Retry the `executeTool` call from step 2.
6. Observe: same call now 502s with "worker not running" until plugin is uninstalled + reinstalled OR server is restarted.

### Workaround

For local plugin iteration, prefer uninstall + reinstall over disable + enable.

---

---

## Finding #4 — `acpx_local` adapter is missing the `claude-agent-acp` binary; agents created with `adapterType: "acpx_local"` fail every run with ACP startup error

### Severity

Medium. Operators following the docs/code suggestion of `acpx_local` (which
appears as an adapter option in the API) create agents that cannot run at all.
The fallback is to use `claude_local` instead — but new operators (Tony, my own
test agents) won't know that without hitting the failure first.

### Symptom

Create an agent via `POST /api/companies/<id>/agents` with
`{"adapterType": "acpx_local", "adapterConfig": {}}`. Default adapterConfig
gets populated by Paperclip with `{"mode": "persistent", "agent": "claude", ...}`.
Assign an issue to the agent. The run starts, the wrapper script executes,
and exits with code 1 before initialize completes:

```
{"type":"acpx.error","message":"ACP agent exited before initialize completed (exit=1, signal=null): /Users/.../wrappers/claude-cda420dc81fed546.sh: line 9: /Users/.../node_modules/@paperclipai/adapter-acpx-local/node_modules/.bin/claude-agent-acp"}
```

The wrapper script's final line execs `claude-agent-acp` but the binary
doesn't exist at that path. The npx-installed Paperclip ships
`@paperclipai/adapter-acpx-local` but not its `claude-agent-acp` dependency.

Paperclip then auto-creates a `stranded_assigned_issue` recovery issue that
blocks the original — operators have to discover the binary-missing failure
through chains of blocked issues.

### Root cause (suspected)

Either: (a) `@paperclipai/adapter-acpx-local/package.json` doesn't declare
`claude-agent-acp` as a runtime dependency, or (b) npx-flavor installs of
Paperclip skip optional/peer dependencies that the adapter needs at runtime.

### Suggested fix

Either: (a) bundle `claude-agent-acp` as a hard dep of `@paperclipai/adapter-acpx-local`,
(b) emit a clear startup-time check that surfaces the missing binary BEFORE
the first run fails, or (c) document `claude_local` as the recommended default
and `acpx_local` as requiring additional setup.

### Workaround

Use `adapterType: "claude_local"` instead. Confirmed working in the same
Paperclip instance.

### Reproduction

1. Paperclip 2026.512.0 installed via `npx paperclipai onboard ...`
2. `POST /api/companies/<id>/agents` with `{"name": "X", "adapterType": "acpx_local"}`
3. Assign any issue
4. Observe: wrapper script ENOENT on `claude-agent-acp`, run exits 1, recovery
   issue auto-created.

---

## Finding #5 — `PAPERCLIP_PROJECT_ID` env var is sometimes empty/unset; plugin runtime context validation rejects calls when relying on it

### Severity

Low-medium. Affects every plugin that needs `projectId` in `runContext`. Agents
that source `projectId` solely from `$PAPERCLIP_PROJECT_ID` will hit a runtime
error on their first tool call.

### Symptom

A Claude C-level agent running an issue invoked `anneal-memory:status` via
the `/api/plugins/tools/execute` endpoint, passing `runContext` constructed
from environment variables:

```bash
curl -X POST "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -H "Content-Type: application/json" \
  -d "{...,\"runContext\":{\"agentId\":\"$PAPERCLIP_AGENT_ID\",\"runId\":\"$PAPERCLIP_RUN_ID\",\"companyId\":\"$PAPERCLIP_COMPANY_ID\",\"projectId\":\"$PAPERCLIP_PROJECT_ID\"}}"
```

The call failed because `$PAPERCLIP_PROJECT_ID` was empty/unset in the
agent's run environment. The agent self-recovered by sourcing `projectId`
from the working-directory path
(`.paperclip-anneal-test/instances/default/projects/<companyId>/<projectId>/...`)
and recording the runtime quirk as a pattern in its own continuity.

### Root cause (suspected)

Either: (a) Paperclip doesn't always set `PAPERCLIP_PROJECT_ID` even when
the run is associated with a project (e.g., the issue is project-less or
the runtime's env-vars population logic has a gap), or (b) the env var is
intentionally optional for cases where projectId is genuinely unset, and
the plugin contract should either accept null/empty projectId OR document
the cwd-derivation fallback as canonical.

### Suggested fix

Either: (a) ensure `PAPERCLIP_PROJECT_ID` is always set when a project context
exists, (b) document the cwd-path-derivation fallback as the canonical agent
pattern for plugins requiring `projectId`, or (c) relax the plugin tool route's
`runContext` validation to allow null `projectId` (and update plugin authors'
expectations accordingly).

### Reproduction

1. Apply Finding #1 patch.
2. Install a plugin that requires `projectId` in `runContext` for `executeTool` calls.
3. Create an issue with a `projectId` field set.
4. Have an agent invoke a plugin tool using `$PAPERCLIP_PROJECT_ID` from env.
5. Observe: env var is empty; tool call fails with `"runContext.projectId must be a string"`.

---

## Filed upstream

**[paperclipai/paperclip#5916](https://github.com/paperclipai/paperclip/issues/5916)** — filed May 13, 2026. Title: "Plugin tool execution always 502s — registerPluginTools drops the plugin UUID dbId". Finding #1 with the patch diff inlined as the primary body; Findings #2 and #3 mentioned at the bottom as separate concerns the maintainers can split out if they prefer.

**[paperclipai/paperclip#5932](https://github.com/paperclipai/paperclip/issues/5932)** — filed May 13, 2026. Title: "`acpx_local` adapter ships without `claude-agent-acp` runtime dep — agents fail with exit=1 before initialize". Finding #4 as standalone issue. Reproduction repro and three suggested fixes inlined.

**[paperclipai/paperclip#5933](https://github.com/paperclipai/paperclip/issues/5933)** — filed May 13, 2026. Title: "`PAPERCLIP_PROJECT_ID` env var sometimes empty/unset; plugin `runContext` validation rejects calls relying on it". Finding #5 as standalone issue. Includes the second reproduction caught on May 13 during the carry-forward verification run.

**[paperclipai/paperclip#5935](https://github.com/paperclipai/paperclip/issues/5935)** — filed May 13, 2026. Title: "Heartbeat wake fires on agent's own issue comments — sub-minute self-perpetuating wake-loop". Finding #7 (new — caught later May 13 during the sustained heartbeat test). Severity high; affects any sustained agent workflow that includes comment-posting on the assigned issue. Agent self-detected the dynamic in real time and recorded it across three heartbeat observation episodes.

**[paperclipai/paperclip#5937](https://github.com/paperclipai/paperclip/issues/5937)** — filed May 13, 2026. Title: "Auto-recovery flow uses sibling-issue creation to override issue-level operator protocol". Finding #8 (new — caught in the same sustained-load testing session as #5935). Severity high; affects any operator workflow with explicit stage gates. Agent protocol adherence is per-run-context, not cross-run, so recovery cascades creating sibling issues can override the source issue's stated protocol via a side-channel. Full close-attack trace included with timestamps.

Repository: <https://github.com/paperclipai/paperclip>

Plugin context: <https://github.com/phillipclapham/anneal-memory-paperclip-plugin>

Reporter: Phill Clapham — building anneal-memory plugin for Paperclip,
caught the bug on day 1 of integration.
