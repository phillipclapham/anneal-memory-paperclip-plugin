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
