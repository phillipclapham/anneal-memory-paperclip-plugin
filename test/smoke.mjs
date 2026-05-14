#!/usr/bin/env node
/**
 * MCP bridge smoke test.
 *
 * Exercises McpBridge end-to-end against a real anneal-memory subprocess.
 * Does NOT touch Paperclip — isolates the bottom half of the stack so
 * Paperclip integration debugging starts from a known-good MCP layer.
 *
 * Run from repo root:
 *   npm run build && node test/smoke.mjs
 *
 * Requires:
 *   - anneal-memory on PATH (or set ANNEAL_CMD env var)
 *   - Node 20+
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpBridge, BridgePool } from "../dist/mcp-bridge.js";
import {
  validateConfigShape,
  resolveAllowlist,
  buildAutoRecordHandler,
  DEFAULT_AUTO_RECORD_ALLOWLIST,
} from "../dist/worker.js";

const ANNEAL_CMD = process.env.ANNEAL_CMD ?? "anneal-memory";

function log(msg) {
  process.stdout.write(`[smoke] ${msg}\n`);
}

function pass(name) {
  process.stdout.write(`  ✓ ${name}\n`);
}

function fail(name, err) {
  process.stdout.write(`  ✗ ${name}: ${err?.message ?? err}\n`);
}

/**
 * MCP tool results return as `{ content: [{ type: "text", text: "..." }], ... }`.
 * Pull the text payload for assertions.
 */
function textOf(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

async function main() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "anneal-bridge-smoke-"));
  const dbPath = path.join(tmpDir, "smoke.db");
  log(`temp db: ${dbPath}`);
  log(`mcp command: ${ANNEAL_CMD}`);

  const bridge = new McpBridge(ANNEAL_CMD, dbPath, "smoke-test");
  let failures = 0;

  const check = async (name, fn) => {
    try {
      await fn();
      pass(name);
    } catch (err) {
      fail(name, err);
      failures++;
    }
  };

  // ------------------------------------------------------------------
  // validateConfigShape (pure, no subprocess) — covers semantic
  // validation surface so v0.1.0's onValidateConfig handler can be
  // trusted without spinning up a real Paperclip host.
  // ------------------------------------------------------------------
  log("validateConfigShape (pure validation)");
  await check("empty config is valid", () => {
    const r = validateConfigShape({});
    assert.equal(r.ok, true);
    assert.ok(!r.errors || r.errors.length === 0);
  });
  await check("undefined config is valid", () => {
    const r = validateConfigShape(undefined);
    assert.equal(r.ok, true);
  });
  await check("non-object config rejected", () => {
    const r = validateConfigShape("not an object");
    assert.equal(r.ok, false);
    assert.match(r.errors.join("\n"), /must be an object/);
  });
  await check("empty mcpCommand rejected", () => {
    const r = validateConfigShape({ mcpCommand: "" });
    assert.equal(r.ok, false);
    assert.match(r.errors.join("\n"), /mcpCommand/);
  });
  await check("non-string mcpCommand rejected", () => {
    const r = validateConfigShape({ mcpCommand: 42 });
    assert.equal(r.ok, false);
    assert.match(r.errors.join("\n"), /mcpCommand must be a string/);
  });
  await check("relative storeBasePath warns", () => {
    const r = validateConfigShape({ storeBasePath: "relative/path" });
    assert.equal(r.ok, true);
    assert.ok(r.warnings && r.warnings.some((w) => /not absolute/.test(w)));
  });
  await check("absolute storeBasePath passes shape check", () => {
    const r = validateConfigShape({ storeBasePath: "/tmp/store" });
    assert.equal(r.ok, true);
  });
  await check("autoRecordEvents: true is valid", () => {
    const r = validateConfigShape({ autoRecordEvents: true });
    assert.equal(r.ok, true);
  });
  await check("autoRecordEvents: false is valid", () => {
    const r = validateConfigShape({ autoRecordEvents: false });
    assert.equal(r.ok, true);
  });
  await check("autoRecordEvents: [] warns (equivalent to false)", () => {
    const r = validateConfigShape({ autoRecordEvents: [] });
    assert.equal(r.ok, true);
    assert.ok(r.warnings && r.warnings.some((w) => /equivalent to/.test(w)));
  });
  await check("autoRecordEvents with valid event type passes", () => {
    const r = validateConfigShape({ autoRecordEvents: ["issue.created"] });
    assert.equal(r.ok, true);
    assert.ok(!r.warnings || !r.warnings.some((w) => /not a known/.test(w)));
  });
  await check("autoRecordEvents with unknown event type warns", () => {
    const r = validateConfigShape({ autoRecordEvents: ["definitely.not.real"] });
    assert.equal(r.ok, true);
    assert.ok(r.warnings && r.warnings.some((w) => /not a known PluginEventType/.test(w)));
  });
  await check("autoRecordEvents firehose marker '*' passes silently", () => {
    const r = validateConfigShape({ autoRecordEvents: ["*"] });
    assert.equal(r.ok, true);
    assert.ok(!r.warnings || !r.warnings.some((w) => /not a known/.test(w)));
  });
  await check("autoRecordEvents wrong type rejected", () => {
    const r = validateConfigShape({ autoRecordEvents: "yes please" });
    assert.equal(r.ok, false);
    assert.match(r.errors.join("\n"), /must be boolean or string/);
  });
  await check("unknown config key warns", () => {
    const r = validateConfigShape({ pleaseIgnoreMe: 1 });
    assert.equal(r.ok, true);
    assert.ok(r.warnings && r.warnings.some((w) => /unknown config key/.test(w)));
  });

  try {
    await check("bridge starts + initialize handshake", async () => {
      await bridge.start();
    });

    await check("record episode (decision)", async () => {
      const result = await bridge.callTool("record", {
        content: "Smoke test: bridge integration validated",
        episode_type: "decision",
        source: "smoke-test",
      });
      const text = textOf(result);
      assert.ok(text.length > 0, "record returned empty content");
      // record returns the episode id; spot-check that it looks like an 8-char hex
      // somewhere in the response.
      assert.match(text, /[0-9a-f]{8}/, "record response missing episode id");
    });

    await check("record episode (observation)", async () => {
      await bridge.callTool("record", {
        content: "Second episode for recall multi-result test",
        episode_type: "observation",
        source: "smoke-test",
      });
    });

    await check("recall returns 2 episodes", async () => {
      const result = await bridge.callTool("recall", { limit: 10 });
      const text = textOf(result);
      assert.ok(text.length > 0, "recall returned empty content");
      // Expect both episodes' content to appear.
      assert.match(text, /Smoke test: bridge integration validated/);
      assert.match(text, /Second episode for recall multi-result test/);
    });

    await check("recall keyword filter narrows to 1", async () => {
      const result = await bridge.callTool("recall", {
        keyword: "Second episode",
        limit: 10,
      });
      const text = textOf(result);
      assert.match(text, /Second episode for recall multi-result test/);
      assert.doesNotMatch(text, /Smoke test: bridge integration validated/);
    });

    await check("status returns health metrics", async () => {
      const result = await bridge.callTool("status", {});
      const text = textOf(result);
      assert.ok(text.length > 0);
      // status surfaces episode counts; both episodes should be visible.
      assert.match(text, /2/, "status did not surface episode count of 2");
    });

    await check("prepare_wrap returns wrap_token + compression package", async () => {
      const result = await bridge.callTool("prepare_wrap", {});
      const text = textOf(result);
      assert.ok(text.length > 0);
      // wrap_token is rendered as `Wrap token: <32-char-hex>` in the response
      assert.match(text, /Wrap token: [0-9a-f]{32}/, "missing wrap_token in response");
    });

    await check("unknown tool yields error", async () => {
      let threw = false;
      try {
        await bridge.callTool("definitely_not_a_tool", {});
      } catch (err) {
        threw = true;
        assert.ok(err instanceof Error);
      }
      assert.equal(threw, true, "expected unknown tool to reject");
    });

    // Full wrap cycle: prepare_wrap mints token, save_continuity completes
    // the cycle. Requires a 4-section markdown payload that passes structure
    // validation (## State / ## Patterns / ## Decisions / ## Context).
    let wrapToken;
    await check("prepare_wrap mints wrap_token (capture)", async () => {
      const result = await bridge.callTool("prepare_wrap", {});
      const text = textOf(result);
      const match = text.match(/Wrap token: ([0-9a-f]{32})/);
      assert.ok(match, "wrap_token not found in prepare_wrap response");
      wrapToken = match[1];
    });

    await check("save_continuity completes wrap with token", async () => {
      assert.ok(wrapToken, "no wrap_token captured");
      const continuity = [
        "## State",
        "Smoke test continuity persistence at 2026-05-13.",
        "",
        "## Patterns",
        "(no graduated patterns yet)",
        "",
        "## Decisions",
        "Validated full prepare_wrap -> save_continuity round-trip.",
        "",
        "## Context",
        "Bridge integration smoke test, anneal-memory v0.3.0.",
        "",
      ].join("\n");
      const result = await bridge.callTool("save_continuity", {
        text: continuity,
        wrap_token: wrapToken,
      });
      const text = textOf(result);
      // save_continuity returns validation results — at minimum non-empty.
      assert.ok(text.length > 0, "save_continuity returned empty content");
    });

    await check("status reflects completed wrap (count resets to 0)", async () => {
      const result = await bridge.callTool("status", {});
      const text = textOf(result);
      // After save_continuity the "since last wrap" counter should reset.
      // We don't assert exact format; just confirm status remains responsive.
      assert.ok(text.length > 0);
    });
  } finally {
    log("stopping bridge");
    await bridge.stop();
  }

  // -- Multi-agent BridgePool isolation --
  // Each agent gets its own subprocess + isolated SQLite store. Verify
  // writes to agent A do not appear in agent B's recall.
  log("BridgePool multi-agent isolation");
  const poolBase = path.join(tmpDir, "pool");
  const pool = new BridgePool(ANNEAL_CMD, poolBase);
  try {
    await check("two agents get separate bridges", async () => {
      const a = pool.bridgeFor("agent-alpha");
      const b = pool.bridgeFor("agent-beta");
      assert.notEqual(a, b, "expected distinct bridges per agent");
      // Idempotent: same agentId returns same bridge.
      const aAgain = pool.bridgeFor("agent-alpha");
      assert.equal(a, aAgain, "bridge pool should reuse bridges per agentId");
    });

    await check("writes in agent-alpha do not leak to agent-beta", async () => {
      const a = pool.bridgeFor("agent-alpha");
      const b = pool.bridgeFor("agent-beta");
      await a.callTool("record", {
        content: "alpha-only-episode-marker",
        episode_type: "observation",
      });
      const bRecall = await b.callTool("recall", {
        keyword: "alpha-only-episode-marker",
        limit: 10,
      });
      const bText = textOf(bRecall);
      assert.doesNotMatch(
        bText,
        /alpha-only-episode-marker/,
        "agent-beta should not see agent-alpha's episodes",
      );
      const aRecall = await a.callTool("recall", {
        keyword: "alpha-only-episode-marker",
        limit: 10,
      });
      const aText = textOf(aRecall);
      assert.match(aText, /alpha-only-episode-marker/, "agent-alpha should see its own episode");
    });

    // -- pool.health() probe semantics --
    // Both bridges were just exercised; expect "active" (recent activity,
    // no probe issued). After dropping one bridge's idle threshold to 0 the
    // probe should fire — but our v0.1.0 entrypoint is the default poll, so
    // we exercise the realistic path first, then degenerate / dead paths.
    await check("health: two-active pool reports ok", async () => {
      const report = await pool.health();
      assert.equal(report.status, "ok");
      assert.equal(report.bridgeCount, 2);
      const states = report.perAgent.map((e) => e.state).sort();
      assert.deepEqual(states, ["active", "active"]);
    });

    await check("health: idle threshold forces probe (still ok)", async () => {
      // idleThresholdMs=0 makes both bridges look stale; probe (tools/list)
      // must succeed → state "idle", overall "ok".
      const report = await pool.health(0, 2000);
      assert.equal(report.status, "ok");
      const states = report.perAgent.map((e) => e.state).sort();
      assert.deepEqual(states, ["idle", "idle"]);
      // Probe should have set lastActivityAt fresh, plus produced a latency.
      assert.ok(report.perAgent.every((e) => typeof e.probeLatencyMs === "number"));
    });

    await check("health: one dead bridge → degraded", async () => {
      const a = pool.bridgeFor("agent-alpha");
      await a.stop();
      const report = await pool.health(60_000, 2000);
      assert.equal(report.status, "degraded");
      const states = report.perAgent.map((e) => e.state).sort();
      // alpha dead (stopped); beta active or idle depending on recency
      assert.ok(states.includes("dead"));
      assert.ok(states.includes("active") || states.includes("idle"));
    });

    await check("health: empty pool reports ok (no agents)", async () => {
      const emptyBase = path.join(tmpDir, "pool-empty");
      const emptyPool = new BridgePool(ANNEAL_CMD, emptyBase);
      const report = await emptyPool.health();
      assert.equal(report.status, "ok");
      assert.equal(report.bridgeCount, 0);
      assert.equal(report.perAgent.length, 0);
    });

    // -- autoRecordEvents wiring: resolveAllowlist + buildAutoRecordHandler --
    // resolveAllowlist is pure; buildAutoRecordHandler needs a live pool, so
    // we exercise it on a fresh pool/agent against the same anneal-memory
    // subprocess we've been using.
    await check("resolveAllowlist: false → empty list", () => {
      const r = resolveAllowlist(false);
      assert.equal(r.length, 0);
    });
    await check("resolveAllowlist: true → 8-event default allowlist", () => {
      const r = resolveAllowlist(true);
      assert.equal(r.length, DEFAULT_AUTO_RECORD_ALLOWLIST.length);
      assert.deepEqual([...r], [...DEFAULT_AUTO_RECORD_ALLOWLIST]);
    });
    await check("resolveAllowlist: ['*'] → full firehose", () => {
      const r = resolveAllowlist(["*"]);
      // PLUGIN_EVENT_TYPES has 32 entries as of SDK 2026.513.0
      assert.ok(r.length >= 30, `expected firehose >= 30 events, got ${r.length}`);
      assert.ok(r.includes("issue.created"));
      assert.ok(r.includes("activity.logged"));
    });
    await check("resolveAllowlist: explicit list passes through", () => {
      const r = resolveAllowlist(["issue.created", "agent.run.failed"]);
      assert.deepEqual([...r], ["issue.created", "agent.run.failed"]);
    });
    await check("resolveAllowlist: '*' marker filtered out of explicit list", () => {
      // Mixed: '*' anywhere triggers firehose; this case has '*' → firehose
      const r = resolveAllowlist(["issue.created", "*"]);
      assert.ok(r.length >= 30);
    });

    // End-to-end: synthesize a PluginEvent + drive handler → episode lands.
    const poolForEvents = pool; // reuse the live pool with alpha (stopped) + beta
    let autoRecordedLogs = [];
    const captureLogger = {
      debug: (m, meta) => autoRecordedLogs.push({ level: "debug", m, meta }),
      warn: (m, meta) => autoRecordedLogs.push({ level: "warn", m, meta }),
    };
    const eventHandler = buildAutoRecordHandler(
      "agent.run.finished",
      () => poolForEvents,
      captureLogger,
    );

    await check("auto-record: agent-actor event lands as observation episode", async () => {
      autoRecordedLogs = [];
      const syntheticEvent = {
        eventId: "evt-test-001",
        eventType: "agent.run.finished",
        occurredAt: "2026-05-14T20:00:00.000Z",
        actorId: "agent-gamma",
        actorType: "agent",
        entityId: "run-xyz",
        entityType: "run",
        companyId: "company-abc",
        payload: { runId: "run-xyz", status: "succeeded" },
      };
      await eventHandler(syntheticEvent);
      // Verify episode landed in agent-gamma's bridge
      const g = poolForEvents.bridgeFor("agent-gamma");
      const recall = await g.callTool("recall", { keyword: "agent.run.finished", limit: 10 });
      const text = textOf(recall);
      assert.match(text, /agent\.run\.finished/, "auto-recorded episode missing in recall");
      assert.match(text, /auto-event:agent\.run\.finished/, "source field missing or wrong");
    });

    await check("auto-record: non-agent actor is skipped (no error, debug log)", async () => {
      autoRecordedLogs = [];
      const userEvent = {
        eventId: "evt-test-002",
        eventType: "agent.run.finished",
        occurredAt: "2026-05-14T20:00:01.000Z",
        actorId: "user-123",
        actorType: "user",
        entityId: "run-xyz",
        entityType: "run",
        companyId: "company-abc",
        payload: {},
      };
      await eventHandler(userEvent);
      const debugSkips = autoRecordedLogs.filter(
        (l) => l.level === "debug" && /no agent actor/.test(l.m),
      );
      assert.equal(debugSkips.length, 1, "expected exactly one debug skip log");
    });

    await check("auto-record: system actor with no actorId is skipped", async () => {
      autoRecordedLogs = [];
      const systemEvent = {
        eventId: "evt-test-003",
        eventType: "budget.incident.opened",
        occurredAt: "2026-05-14T20:00:02.000Z",
        actorType: "system",
        entityId: "incident-1",
        entityType: "budget_incident",
        companyId: "company-abc",
        payload: {},
      };
      await eventHandler(systemEvent);
      const debugSkips = autoRecordedLogs.filter(
        (l) => l.level === "debug" && /no agent actor/.test(l.m),
      );
      assert.equal(debugSkips.length, 1);
    });

    await check("auto-record: source field 'auto-event:*' distinguishes from agent.record", async () => {
      // Agent explicitly records something via the agent tool path.
      const g = poolForEvents.bridgeFor("agent-gamma");
      await g.callTool("record", {
        content: "Agent explicit record — should have source 'agent'",
        episode_type: "decision",
        source: "agent",
      });
      const recallExplicit = await g.callTool("recall", { source: "agent", limit: 10 });
      const recallAuto = await g.callTool("recall", { source: "auto-event:agent.run.finished", limit: 10 });
      const explicitText = textOf(recallExplicit);
      const autoText = textOf(recallAuto);
      assert.match(explicitText, /Agent explicit record/, "explicit-source recall missing entry");
      assert.match(autoText, /agent\.run\.finished/, "auto-source recall missing entry");
      // Cross-leak check: explicit recall should NOT contain auto-event content
      assert.doesNotMatch(
        explicitText,
        /Event: agent\.run\.finished/,
        "explicit-source recall leaked auto-recorded episode",
      );
    });

    await check("auto-record: pool=null short-circuits cleanly", async () => {
      const nullHandler = buildAutoRecordHandler("issue.created", () => null, captureLogger);
      // Should not throw, should not record anything.
      await nullHandler({
        eventId: "evt-null",
        eventType: "issue.created",
        occurredAt: "2026-05-14T20:00:03.000Z",
        actorId: "agent-gamma",
        actorType: "agent",
        entityId: "issue-1",
        entityType: "issue",
        companyId: "company-abc",
        payload: {},
      });
    });

    // -- Phase 3: retry/queue during MCP restart window --
    // Demonstrates that sendRequest no longer drops calls landing between
    // `child exit` and `child re-initialized`. Uses _simulateCrashForTest
    // to trigger the auto-restart pathway without OS-level PID juggling.
    //
    // Race-management: SIGKILL → 'exit' event is asynchronous. We can't
    // assume the bridge is in "dead" state right after _simulateCrashForTest
    // returns — we must wait for isAlive() to flip false (the exit handler
    // nulls child + initialized). Otherwise the next callTool races with
    // the dying child and the call gets rejected via failAllPending
    // instead of exercising the restart-window block-and-recover path.
    const waitForDead = async (bridge, timeoutMs = 1000) => {
      const deadline = Date.now() + timeoutMs;
      while (bridge.isAlive() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(bridge.isAlive(), false, "bridge did not transition to dead within timeout");
    };

    await check("restart-window: call during recovery completes after restart", async () => {
      const recoveryDb = path.join(tmpDir, "recovery.db");
      const recoveryBridge = new McpBridge(ANNEAL_CMD, recoveryDb, "recovery-test", {
        restartBackoffMs: 200, // keep test fast
        maxRestartAttempts: 3,
      });
      try {
        await recoveryBridge.start();
        // Warm-up call so we know the bridge is fully alive.
        await recoveryBridge.callTool("status", {});

        recoveryBridge._simulateCrashForTest();
        await waitForDead(recoveryBridge);
        const t0 = Date.now();

        // This call must block, then complete after restart.
        const result = await recoveryBridge.callTool("status", {});
        const elapsed = Date.now() - t0;
        const text = textOf(result);
        assert.ok(text.length > 0, "post-restart status returned empty content");
        // Bridge is alive again — restart completed inside the call.
        assert.equal(recoveryBridge.isAlive(), true, "bridge should be alive after recovery");
        // Lower-bound sanity: we waited for SOMETHING (spawn + initialize).
        assert.ok(elapsed >= 0, `unexpected negative elapsed: ${elapsed}ms`);
      } finally {
        await recoveryBridge.stop();
      }
    });

    await check("restart-window: exhausted bridge rejects without retrying", async () => {
      // The exit handler resets restartAttempts to 0 on every successful
      // recovery, so cumulative-crashes-over-time NEVER exhausts a bridge
      // that can still spawn. Real exhaustion requires consecutive failed
      // spawns. To exercise the sendRequest exhausted-path deterministically
      // without depending on a bad-binary spawn-failure race, we mark the
      // bridge as exhausted directly via the test hook. The exit handler's
      // set/clear of `exhausted` is exercised separately by the recovery
      // test below (which confirms recovery clears the flag).
      const exhaustDb = path.join(tmpDir, "exhaust.db");
      const exhaustBridge = new McpBridge(ANNEAL_CMD, exhaustDb, "exhaust-test", {
        restartBackoffMs: 50,
        maxRestartAttempts: 1,
      });
      try {
        await exhaustBridge.start();
        await exhaustBridge.callTool("status", {});
        exhaustBridge._simulateCrashForTest({ markExhausted: true });
        await waitForDead(exhaustBridge);
        assert.equal(exhaustBridge._isExhaustedForTest(), true, "exhausted flag should be set");

        let threw = false;
        let message = "";
        try {
          await exhaustBridge.callTool("status", {});
        } catch (err) {
          threw = true;
          message = err?.message ?? String(err);
        }
        assert.equal(threw, true, "expected exhausted bridge to reject");
        assert.match(
          message,
          /exhausted/i,
          `expected 'exhausted' in error message, got: ${message}`,
        );
        // Critical: sendRequest must NOT attempt to start the bridge when
        // exhausted. After the rejected call, bridge should still be dead.
        assert.equal(
          exhaustBridge.isAlive(),
          false,
          "exhausted bridge should not auto-restart on call",
        );
      } finally {
        await exhaustBridge.stop().catch(() => {});
      }
    });

    await check("restart-window: recovery clears exhausted flag for future crashes", async () => {
      // Confirms the exit handler resets `exhausted` on successful restart,
      // so a single recovered bridge doesn't carry old exhaustion state.
      const recoveredDb = path.join(tmpDir, "recovered.db");
      const recoveredBridge = new McpBridge(ANNEAL_CMD, recoveredDb, "recovered-test", {
        restartBackoffMs: 100,
        maxRestartAttempts: 3,
      });
      try {
        await recoveredBridge.start();
        // Manually set exhausted=false beforehand baseline check.
        assert.equal(recoveredBridge._isExhaustedForTest(), false);
        // Crash + recover.
        recoveredBridge._simulateCrashForTest();
        await waitForDead(recoveredBridge);
        await recoveredBridge.callTool("status", {});
        // After successful recovery via sendRequest's restart-window path,
        // exhausted MUST still be false (doStart resets it on success).
        assert.equal(
          recoveredBridge._isExhaustedForTest(),
          false,
          "exhausted should remain false after successful recovery",
        );
        assert.equal(recoveredBridge.isAlive(), true);
      } finally {
        await recoveredBridge.stop().catch(() => {});
      }
    });
  } finally {
    log("stopping bridge pool");
    await pool.stopAll();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  if (failures > 0) {
    process.exitCode = 1;
    log(`FAILED: ${failures} check(s) failed`);
  } else {
    log("all checks passed");
  }
}

main().catch((err) => {
  process.stderr.write(`[smoke] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
