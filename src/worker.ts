import { access, constants as fsConstants, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginConfigValidationResult,
  type PluginContext,
  type PluginEvent,
  type PluginEventType,
  type PluginHealthDiagnostics,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";
import type { BridgePool as BridgePoolType } from "./mcp-bridge.js";
import { DEFAULT_MCP_COMMAND, PLUGIN_ID, TOOL_NAMES } from "./constants.js";
import { BridgePool } from "./mcp-bridge.js";

export interface PluginConfig {
  mcpCommand?: string;
  storeBasePath?: string;
  /**
   * `false` (default) — explicit-only recording.
   * `true` — subscribe to the curated default observation-class allowlist
   *   (issue.created, issue.updated, issue.comment.created,
   *   agent.run.{started,finished,failed}, approval.decided,
   *   budget.incident.opened).
   * `string[]` — explicit allowlist; entries must be members of
   *   PLUGIN_EVENT_TYPES (validated). Pass `["*"]` to opt into the full
   *   firehose explicitly.
   */
  autoRecordEvents?: boolean | string[];
}

export interface ResolvedPluginConfig {
  mcpCommand: string;
  storeBasePath: string;
  autoRecordEvents: boolean | string[];
}

/**
 * Curated default allowlist when `autoRecordEvents: true`. Observation-class
 * events that meaningfully populate memory without firehose pollution. See
 * decisions / CHANGELOG v0.1.0 for the rejection rationale on the events
 * NOT in this list (cost_event.created, activity.logged firehose;
 * issue.checked_out/released lifecycle dust; admin events).
 */
export const DEFAULT_AUTO_RECORD_ALLOWLIST: readonly string[] = Object.freeze([
  "issue.created",
  "issue.updated",
  "issue.comment.created",
  "agent.run.started",
  "agent.run.finished",
  "agent.run.failed",
  "approval.decided",
  "budget.incident.opened",
]);

const KNOWN_EVENT_TYPES = new Set<string>(PLUGIN_EVENT_TYPES);

let pool: BridgePool | null = null;
let currentContext: PluginContext | null = null;

function resolveStoreBaseFallback(): string {
  return path.join(os.homedir(), ".paperclip", "data", "plugins", PLUGIN_ID, "stores");
}

async function loadConfig(ctx: PluginContext): Promise<ResolvedPluginConfig> {
  const raw = (await ctx.config.get()) as PluginConfig | undefined;
  return {
    mcpCommand: raw?.mcpCommand ?? DEFAULT_MCP_COMMAND,
    // Default per Paperclip PLUGIN_SPEC section 8.1: plugin data directory.
    // Conservative fallback to ~/.paperclip/data/plugins/<id>/stores when host
    // does not provide an explicit path resolver in V1.
    storeBasePath: raw?.storeBasePath ?? resolveStoreBaseFallback(),
    autoRecordEvents: raw?.autoRecordEvents ?? false,
  };
}

/**
 * Pure shape + semantic validation of a raw config blob. Does NOT touch the
 * filesystem — composable separately and trivially unit-testable. The
 * filesystem-aware checks live in `validateConfig` so they can be skipped /
 * mocked / overridden.
 */
export function validateConfigShape(raw: unknown): PluginConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (raw !== undefined && raw !== null && typeof raw !== "object") {
    errors.push("config must be an object");
    return { ok: false, errors };
  }
  const cfg = (raw ?? {}) as Record<string, unknown>;

  if (cfg.mcpCommand !== undefined && typeof cfg.mcpCommand !== "string") {
    errors.push("mcpCommand must be a string");
  } else if (typeof cfg.mcpCommand === "string" && cfg.mcpCommand.trim() === "") {
    errors.push("mcpCommand must not be empty (omit the key for the default)");
  }

  if (cfg.storeBasePath !== undefined) {
    if (typeof cfg.storeBasePath !== "string") {
      errors.push("storeBasePath must be a string");
    } else if (cfg.storeBasePath.trim() === "") {
      errors.push("storeBasePath must not be empty (omit the key for the default)");
    } else if (!path.isAbsolute(cfg.storeBasePath)) {
      warnings.push(
        `storeBasePath '${cfg.storeBasePath}' is not absolute; resolved against the worker's cwd at runtime`,
      );
    }
  }

  if (cfg.autoRecordEvents !== undefined) {
    const v = cfg.autoRecordEvents;
    if (typeof v === "boolean") {
      // ok
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        warnings.push("autoRecordEvents: [] disables auto-recording — equivalent to `false`");
      }
      for (const entry of v) {
        if (typeof entry !== "string") {
          errors.push("autoRecordEvents entries must be strings");
          continue;
        }
        if (entry === "*") continue; // firehose marker
        if (!KNOWN_EVENT_TYPES.has(entry)) {
          warnings.push(
            `autoRecordEvents entry '${entry}' is not a known PluginEventType — kept for forward-compat but no events will match unless a future SDK adds it`,
          );
        }
      }
    } else {
      errors.push("autoRecordEvents must be boolean or string[]");
    }
  }

  // Surface unknown keys so config drift doesn't silently disappear.
  const knownKeys = new Set(["mcpCommand", "storeBasePath", "autoRecordEvents"]);
  for (const key of Object.keys(cfg)) {
    if (!knownKeys.has(key)) {
      warnings.push(`unknown config key '${key}' will be ignored`);
    }
  }

  return errors.length === 0
    ? { ok: true, ...(warnings.length > 0 ? { warnings } : {}) }
    : { ok: false, errors, ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * Filesystem-aware part of config validation. Combined with `validateConfigShape`
 * by `onValidateConfig`. Resolves the effective values (applying defaults) before
 * checking so that defaults are validated when the operator omits the key.
 */
async function validateConfigFilesystem(
  raw: Record<string, unknown> | undefined,
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const mcpCommand = (raw?.mcpCommand as string | undefined) ?? DEFAULT_MCP_COMMAND;
  if (path.isAbsolute(mcpCommand)) {
    try {
      await access(mcpCommand, fsConstants.X_OK);
    } catch (err) {
      errors.push(
        `mcpCommand '${mcpCommand}' is not executable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Bare names rely on host PATH resolution; we can't pre-check without
  // spawning, which is too expensive for a config-validation hop.

  const storeBasePath = (raw?.storeBasePath as string | undefined) ?? resolveStoreBaseFallback();
  if (path.isAbsolute(storeBasePath)) {
    try {
      const s = await stat(storeBasePath);
      if (!s.isDirectory()) {
        errors.push(`storeBasePath '${storeBasePath}' exists but is not a directory`);
      } else {
        try {
          await access(storeBasePath, fsConstants.W_OK);
        } catch {
          errors.push(`storeBasePath '${storeBasePath}' exists but is not writable`);
        }
      }
    } catch (err: unknown) {
      // ENOENT is OK — we mkdir at first use. Surface anything else.
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        warnings.push(
          `could not stat storeBasePath '${storeBasePath}': ${e.message ?? String(err)} — will attempt mkdir at first use`,
        );
      }
    }
  }

  return { errors, warnings };
}

function dispatchToolCall(
  toolName: string,
): (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult> {
  return async (params, runCtx): Promise<ToolResult> => {
    if (!pool) {
      return { error: "anneal-memory plugin is not initialized" };
    }
    const agentId = runCtx.agentId ?? `run-${runCtx.runId ?? "unknown"}`;
    const bridge = pool.bridgeFor(agentId);
    try {
      const result = await bridge.callTool(toolName, (params ?? {}) as Record<string, unknown>);
      const content = extractContentText(result);
      return { content, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      currentContext?.logger.error(`anneal-memory tool '${toolName}' failed`, {
        agentId,
        runId: runCtx.runId,
        error: message,
      });
      return { error: message };
    }
  };
}

/**
 * MCP tool responses follow the shape `{ content: [{ type: "text", text: "..." }] }`.
 * Extract human-readable text for Paperclip's run log; full structured result
 * stays available via ToolResult.data.
 */
function extractContentText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (
      entry &&
      typeof entry === "object" &&
      (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string"
    ) {
      parts.push((entry as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/**
 * Resolve the auto-record allowlist from config. Pure function — does not
 * read state or invoke side effects, so it composes cleanly with smoke tests.
 *
 * - `false` → []
 * - `true` → DEFAULT_AUTO_RECORD_ALLOWLIST (8 curated observation-class events)
 * - `["*"]` (anywhere in array) → full PLUGIN_EVENT_TYPES firehose
 * - `string[]` → as provided (with `*` entries filtered)
 */
export function resolveAllowlist(autoRecordEvents: boolean | string[]): readonly string[] {
  if (autoRecordEvents === false) return [];
  if (autoRecordEvents === true) return DEFAULT_AUTO_RECORD_ALLOWLIST;
  if (!Array.isArray(autoRecordEvents)) return [];
  if (autoRecordEvents.includes("*")) return PLUGIN_EVENT_TYPES;
  return autoRecordEvents.filter((e): e is string => typeof e === "string" && e !== "*");
}

/**
 * Build the per-event-type auto-record handler. Captures the eventType for
 * logging context and routes through the supplied BridgePool. Exported so
 * smoke tests can drive the handler with a synthetic PluginEvent without
 * standing up a Paperclip host.
 *
 * Routing rule: only auto-record events with an attributable agent actor
 * (`actorType === "agent"` and `actorId` present). Without an agent owner,
 * there is no per-agent store to land the episode in — drop with a debug
 * log. This is deliberate v0.1.0 scope: company-level / system-level events
 * stay out of memory until v0.2+ adds a synthetic company-store agent.
 */
export function buildAutoRecordHandler(
  eventType: string,
  getPool: () => BridgePoolType | null,
  logger?: { debug?: (m: string, meta?: Record<string, unknown>) => void; warn?: (m: string, meta?: Record<string, unknown>) => void },
): (event: PluginEvent) => Promise<void> {
  return async (event) => {
    const livePool = getPool();
    if (!livePool) return;
    if (event.actorType !== "agent" || !event.actorId) {
      logger?.debug?.("auto-record skipped: no agent actor", {
        eventType,
        eventId: event.eventId,
        actorType: event.actorType,
      });
      return;
    }
    const bridge = livePool.bridgeFor(event.actorId);
    const content = `Event: ${event.eventType} on ${event.entityType ?? "<no-entity-type>"}/${event.entityId ?? "<no-entity-id>"}`;
    try {
      await bridge.callTool("record", {
        content,
        episode_type: "observation",
        source: `auto-event:${event.eventType}`,
        metadata: {
          eventId: event.eventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          actorId: event.actorId,
          actorType: event.actorType,
          entityId: event.entityId,
          entityType: event.entityType,
          companyId: event.companyId,
          payload: event.payload,
        },
      });
    } catch (err) {
      logger?.warn?.("auto-record failed", {
        eventType: event.eventType,
        eventId: event.eventId,
        agentId: event.actorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/**
 * Subscribe handlers for each event in the allowlist. Capability-gated:
 * if `ctx.events.on` throws (e.g. host denies events.subscribe capability
 * or surface changed in a future SDK), warn-log and continue. The plugin
 * still functions for explicit record/recall — just no ambient observation.
 */
async function wireAutoRecordEvents(
  ctx: PluginContext,
  allowlist: readonly string[],
): Promise<void> {
  if (allowlist.length === 0) return;
  try {
    for (const eventType of allowlist) {
      ctx.events.on(
        eventType as PluginEventType,
        buildAutoRecordHandler(eventType, () => pool, ctx.logger),
      );
    }
    ctx.logger.info("auto-record events subscribed", {
      count: allowlist.length,
      events: allowlist,
    });
  } catch (err) {
    ctx.logger.warn(
      "auto-record subscription failed; plugin continues without ambient observation",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}

async function registerTools(ctx: PluginContext): Promise<void> {
  for (const toolName of Object.values(TOOL_NAMES)) {
    // Manifest carries displayName/description/parametersSchema; the SDK
    // accepts a minimal registration here that re-references the manifest
    // declarations and provides the handler.
    ctx.tools.register(
      toolName,
      {
        displayName: toolName,
        description: `anneal-memory ${toolName} (see manifest for schema)`,
        parametersSchema: { type: "object" },
      },
      dispatchToolCall(toolName),
    );
  }
}

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    const config = await loadConfig(ctx);
    pool = new BridgePool(config.mcpCommand, config.storeBasePath, {
      logger: ctx.logger,
    });
    pool.installShutdownHandlers();
    await registerTools(ctx);
    await wireAutoRecordEvents(ctx, resolveAllowlist(config.autoRecordEvents));
    ctx.logger.info("anneal-memory plugin setup complete", {
      mcpCommand: config.mcpCommand,
      storeBasePath: config.storeBasePath,
      autoRecordEvents: config.autoRecordEvents,
    });
  },

  async onValidateConfig(config) {
    const shape = validateConfigShape(config);
    const fs = await validateConfigFilesystem(config as Record<string, unknown> | undefined);
    const errors = [...(shape.errors ?? []), ...fs.errors];
    const warnings = [...(shape.warnings ?? []), ...fs.warnings];
    return errors.length === 0
      ? { ok: true, ...(warnings.length > 0 ? { warnings } : {}) }
      : { ok: false, errors, ...(warnings.length > 0 ? { warnings } : {}) };
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    if (!pool) {
      return {
        status: "error",
        message: "anneal-memory plugin pool not initialized",
      };
    }
    const report = await pool.health();
    const counts = report.perAgent.reduce(
      (acc, e) => {
        acc[e.state] = (acc[e.state] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    return {
      status: report.status,
      message:
        report.bridgeCount === 0
          ? "anneal-memory plugin ready (no agents active yet)"
          : `anneal-memory plugin: ${counts.active ?? 0} active, ${counts.idle ?? 0} idle, ${counts.unresponsive ?? 0} unresponsive, ${counts.dead ?? 0} dead`,
      details: {
        bridgeCount: report.bridgeCount,
        counts,
        perAgent: report.perAgent,
      },
    };
  },

  async onShutdown() {
    if (pool) {
      await pool.stopAll();
      pool = null;
    }
    currentContext?.logger.info("anneal-memory plugin shut down");
    currentContext = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
