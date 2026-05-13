# Changelog

All notable changes to `@anneal-memory/paperclip-plugin` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned for v0.1.0

- `autoRecordEvents` config flag wired (currently declared but no `onEvent` handler).
- `validateConfig` RPC implementation — bad config surfaces at plugin install, not first tool call.
- Per-agent MCP responsiveness probe in `onHealth` (currently shallow — returns "ok" whenever bridge pool exists).
- Retry/queue policy for tool calls landing during MCP child auto-restart window.
- Re-validation against Paperclip releases beyond 2026.512.0.

## [0.0.2] - 2026-05-13

Documentation polish release. **No code changes** — same v0.0.1 plugin
mechanically. Substantially expanded discovery surface and
operator-facing documentation, plus standalone agent-instructions
template.

### Added

- `CHANGELOG.md` — this file (Keep-a-Changelog format), with v0.0.1
  retrospective + load-test receipts + filed-upstream cross-references.
- `TOOLS.md` — standalone drop-in agent instructions template, extracted
  from the README inline section. Operators can copy directly into their
  Paperclip agent's instructions bundle without editing.

### Changed

- `README.md` — substantially expanded discovery surface:
  - Status line now links empirical receipts + 5 upstream Paperclip findings filed day-one.
  - New "In-production validation" section with the ANN-13 v2 4-wrap receipt table demonstrating immune-system demotion (continuity shrunk 569 chars) + closed-loop learning (agent codified demotion lesson as pattern and applied on next graduation).
  - "Install (planned)" section replaced with comprehensive 5-step **Quickstart** including the #5916 patch diff inline. Plugin works end-to-end with current Paperclip 2026.512.0 + the manual patch documented in Quickstart Step 2.
  - "Teaching Your Agent" section references the new standalone `TOOLS.md` instead of inlining the template.
  - New "Filed upstream" section listing all 5 upstream findings filed against `paperclipai/paperclip` (#5916, #5932, #5933, #5935, #5937) with one-line each.
  - "Methodology-under-Paperclip-runtime" Known Limitations section rewritten to reflect today's empirical wins. Single-cycle validation: graduation + immune system + closed-loop learning all confirmed in production via ANN-13 v2 sequence. Sustained-load behavior over days/weeks remains the open empirical question; first operator to deploy at production scale is the v0.1 validation gate.
- `UPSTREAM_PAPERCLIP_FINDINGS.md` — added cross-references for `#5932`/`#5933`/`#5935`/`#5937` (previously uncommitted from when they were filed earlier May 13).

### Status

Plugin remains the same v0.0.1 code at the mechanical layer — only documentation surface evolved. Operators upgrading from v0.0.1 → v0.0.2 receive no behavioral changes; the upgrade is for the discovery surface, agent-instruction template, and complete release-notes documentation.

## [0.0.1] - 2026-05-13

Initial release. TypeScript plugin pack that wraps the
[anneal-memory](https://github.com/phillipclapham/anneal-memory) Python MCP
server as a per-agent subprocess, surfacing first-class four-layer memory
(episodic + continuity + Hebbian + limbic) plus immune system to Paperclip
agents.

### Added

- 6 plugin tools under the `anneal-memory:` namespace — `record`, `recall`,
  `prepare_wrap`, `save_continuity`, `delete_episode`, `status`.
- Per-agent SQLite store isolation at `<storeBasePath>/<agentId>/memory.db`.
- `BridgePool` manages MCP child processes — one Python subprocess per
  Paperclip agent, lazy on first tool call, bridge reuse within worker
  lifetime.
- Process-level shutdown handlers so MCP children don't become orphans if
  the Paperclip host dies.
- Auto-restart on MCP child crash (default 3 attempts, exponential backoff
  from 1s).
- Smoke test (`test/smoke.mjs`) — end-to-end bridge validation against a
  real `anneal-memory` subprocess covering record/recall/status round-trip,
  full wrap cycle with token validation, multi-agent isolation, and
  tool-level error conversion. 13/13 green.
- 3 install-path config keys: `mcpCommand`, `storeBasePath`, `autoRecordEvents`
  (last is declared but not yet wired — see v0.1.0 planned items).

### Validated end-to-end against Paperclip 2026.512.0

Three named load tests validated specific hypotheses about whether FLOW
methodology can execute under Paperclip's autonomous runtime, plus a
fourth carry-forward test:

- **B1 — single-agent wrap cycle (Claude C-level): PASS.** Agent
  autonomously executed a full wrap (status → record ×3 → prepare_wrap →
  save_continuity → status) with structurally-correct 4-section FlowScript
  continuity and surfaced a novel runtime quirk (Finding #5) as a pattern
  unprompted.
- **B2 — multi-agent C-level coordination: PASS.** CMO + CTO parallel
  Claude agents; each agent's SQLite store contained only its own episodes.
  Zero cross-contamination. Direct refutation of the
  global-continuity-fills-too-fast failure mode for autonomous
  multi-agent setups.
- **B3 — Codex C-level wrap cognition: PASS-WITH-NUANCE.** Codex executed
  valid wrap-class cognition end-to-end on the plugin contract (4 minutes
  vs Claude's 1 minute, more methodical exploration, one tombstone
  self-correction). Refutes the strong "Codex can't run wraps" claim;
  cognitive-texture difference vs Claude is real but mechanical capability
  holds.
- **B1.5 — cold-session memory carry-forward: PASS.** Agent on a
  cold-context session read its own continuity, refused to redo B1
  ("the continuity already proves it"), proposed B2-style continuity-merge
  as the next test, surfaced a novel meta-pattern (write-path vs read-path
  test taxonomy). Multi-cycle wrap-thrash disconfirmed.

### Sustained-load receipts — ANN-13 v2 (4-wrap sequence)

Operator-driven cadence (no agent self-comments — sidesteps Finding #7's
wake-loop). Demonstrates compression-with-intelligence in production:

- **Wrap #2:** 6,373 chars. New patterns surfaced from heartbeat #1
  evidence.
- **Wrap #3:** 5,804 chars. **Immune system demoted a bad self-citation.**
  Continuity SHRANK 569 chars. Agent re-examined a pattern it had
  graduated earlier, ruled the supporting evidence didn't hold, removed
  the graduation.
- **Wrap #4:** 7,027 chars. **Closed-loop learning.** Agent codified the
  wrap-#3 demotion lesson as a new pattern AND applied it on the next
  graduation evaluation. Memory got smarter because it corrected itself.

This is the architectural claim made operationally real — graduation +
immune system + structurally-enforced compression produce process
evolution, not bloat-instead-of-smart.

### Filed upstream

Five Paperclip findings surfaced during plugin development and load
testing, all filed against
[paperclipai/paperclip](https://github.com/paperclipai/paperclip):

- **[#5916](https://github.com/paperclipai/paperclip/issues/5916)** —
  Plugin tool execution always returns 502 because `registerPluginTools`
  drops the plugin's UUID `dbId`. Two-line patch inlined in issue body.
  **Required** for this plugin to work end-to-end; manual patch
  application documented in README pending upstream merge.
- **[#5932](https://github.com/paperclipai/paperclip/issues/5932)** —
  `acpx_local` adapter ships without the `claude-agent-acp` runtime
  dependency; every agent run fails at `exit=1` before `initialize`.
  Workaround: use the `claude_local` adapter.
- **[#5933](https://github.com/paperclipai/paperclip/issues/5933)** —
  `PAPERCLIP_PROJECT_ID` environment variable sometimes empty/unset.
  Plugin runtime validation rejects calls that rely on it. Agent
  self-recovers via cwd-path parsing.
- **[#5935](https://github.com/paperclipai/paperclip/issues/5935)** —
  Heartbeat wake fires on the agent's own issue comments, producing a
  sub-minute self-perpetuating wake-loop. Caught in under 4 minutes by
  the agent itself in heartbeat #2 via the plugin's memory layer.
  Workaround: agents record state to plugin memory only, operators read
  state out-of-band, no agent self-comments on assigned issues.
- **[#5937](https://github.com/paperclipai/paperclip/issues/5937)** —
  Auto-recovery flow creates sibling issues whose run contexts override
  issue-level operator protocol. When ANN-13 completed without
  auto-close, Paperclip created ANN-14 + ANN-15 recovery issues that
  instructed the same agent (in different run contexts) to close ANN-13
  — overriding ANN-13's explicit "operator owns close" rule.

### Known Limitations

- Paperclip version pinned to `2026.512.0`; will need re-validation
  against subsequent CalVer releases.
- `autoRecordEvents` manifest field declared but no `onEvent` handler
  registered — autorecord behavior not active.
- `onHealth` returns "ok" whenever bridge pool exists; does not probe
  per-agent MCP children for actual responsiveness.
- `validateConfig` RPC not implemented; bad config surfaces at first
  tool call instead of plugin install.
- No retry policy for tool calls landing in the MCP child auto-restart
  window — those fail; subsequent calls succeed after restart completes.
- `claude_local` adapter does NOT auto-discover plugin tools; agents
  must be taught the tool surface via instructions (see README §
  "Teaching Your Agent About anneal-memory").

### Methodology-under-Paperclip-runtime validation status

v0.0.1 mechanically validates that the anneal-memory storage layer works
as a Paperclip plugin and that the four-layer memory + immune system
execute correctly under multi-cycle load (the ANN-13 v2 receipts above).
What v0.0.1 does NOT yet validate is sustained-load behavior over days/
weeks at scale — heartbeat cadence over many cycles, day-over-day
continuity carry-forward, multi-week pattern accumulation. The first
operator to deploy under sustained load is the v0.1 validation gate. If
that's you and you surface specific failure modes, please open an issue
with reproduction steps.

[Unreleased]: https://github.com/phillipclapham/anneal-memory-paperclip-plugin/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/phillipclapham/anneal-memory-paperclip-plugin/releases/tag/v0.0.2
[0.0.1]: https://github.com/phillipclapham/anneal-memory-paperclip-plugin/releases/tag/v0.0.1
