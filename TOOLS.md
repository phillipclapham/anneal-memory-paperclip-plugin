# anneal-memory Plugin — Agent Instructions Template

This file is a drop-in agent instructions template for the
`@anneal-memory/paperclip-plugin`. Operators: copy the content below the
divider into your Paperclip agent's `TOOLS.md` (or equivalent
instructions bundle).

```bash
cp TOOLS.md ~/.paperclip/agents/<your-agent>/instructions/TOOLS.md
```

**Why this manual step exists:** Paperclip's `claude_local` adapter in
v2026.512.0 does not auto-inject plugin tools into the Claude Code
runtime tool set. The agent must be told the tools exist and how to call
them. Once Paperclip ships plugin-tool auto-discovery for `claude_local`,
this manual injection becomes unnecessary.

The template below is written in the agent's voice and references the
Paperclip runtime environment variables an agent sees at runtime
(`PAPERCLIP_API_URL`, `PAPERCLIP_AGENT_ID`, etc.). Drop-in ready — no
editing required.

---

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

- **`anneal-memory:record`** — record an episode.
  - **Required:** `content` (string), `episode_type` (one of:
    `observation`, `decision`, `tension`, `question`, `outcome`,
    `context`).
  - **Optional:** `source` (string), `metadata` (object).

- **`anneal-memory:recall`** — query episodes. All parameters optional:
  `since` (ISO 8601), `until` (ISO 8601), `episode_type`, `source`,
  `keyword`, `limit` (default 100), `offset`.

- **`anneal-memory:prepare_wrap`** — get a compression package at a
  session boundary. Returns a `wrap_token` (32-char hex) you MUST pass
  to `save_continuity`.
  - **Optional:** `max_chars` (default 20000), `staleness_days`
    (default 7).

- **`anneal-memory:save_continuity`** — save compressed continuity.
  - **Required:** `text` (markdown with `## State`, `## Patterns`,
    `## Decisions`, `## Context` sections).
  - **Optional:** `wrap_token` (from `prepare_wrap`), `affective_state`
    (`{ tag, intensity }`).

- **`anneal-memory:delete_episode`** — delete by id.
  - **Required:** `episode_id`.

- **`anneal-memory:status`** — health metrics. No arguments.

## When to use these tools

- **Record** decisions, tensions, observations as they happen during
  work. Episodes are the evidence chain everything downstream depends
  on — write them liberally.
- **Recall** prior episodes before making related decisions. The
  memory's value compounds when retrieval informs current choices.
- **At session end** (long-running tasks, end of run, completion of a
  meaningful work unit): call `prepare_wrap`, compose compressed
  continuity, then `save_continuity`. This persists learned patterns
  across heartbeats — without the wrap step, episodes accumulate but
  patterns never graduate, and the memory grows without getting
  smarter.

## Wrap discipline

A wrap is a cognitive event, not a token-budget event. Trigger wraps
on session-boundary work-unit completions, not on arbitrary heartbeat
schedules or "I'm running long" instincts. Without meaningful work
between wraps, compression material is too thin and graduation
criteria don't fire.

If `prepare_wrap` returns a token, you MUST follow it with
`save_continuity` passing that token in the same logical session. The
token is a 2-phase commit handle — abandoning it loses the wrap's
compression work.
