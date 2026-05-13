import path from "node:path";
import os from "node:os";
import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { DEFAULT_MCP_COMMAND, PLUGIN_ID, TOOL_NAMES } from "./constants.js";
import { BridgePool } from "./mcp-bridge.js";

interface PluginConfig {
  mcpCommand?: string;
  storeBasePath?: string;
  autoRecordEvents?: boolean;
}

let pool: BridgePool | null = null;
let currentContext: PluginContext | null = null;

async function loadConfig(ctx: PluginContext): Promise<Required<PluginConfig>> {
  const raw = (await ctx.config.get()) as PluginConfig | undefined;
  const mcpCommand = raw?.mcpCommand ?? DEFAULT_MCP_COMMAND;
  // Default per Paperclip PLUGIN_SPEC section 8.1: plugin data directory.
  // Conservative fallback to ~/.paperclip/data/plugins/<id>/stores when host
  // does not provide an explicit path resolver in V1.
  const fallbackBase = path.join(
    os.homedir(),
    ".paperclip",
    "data",
    "plugins",
    PLUGIN_ID,
    "stores",
  );
  const storeBasePath = raw?.storeBasePath ?? fallbackBase;
  const autoRecordEvents = raw?.autoRecordEvents ?? false;
  return { mcpCommand, storeBasePath, autoRecordEvents };
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
    pool = new BridgePool(config.mcpCommand, config.storeBasePath);
    await registerTools(ctx);
    ctx.logger.info("anneal-memory plugin setup complete", {
      mcpCommand: config.mcpCommand,
      storeBasePath: config.storeBasePath,
      autoRecordEvents: config.autoRecordEvents,
    });
  },

  async onHealth() {
    return {
      status: pool ? "ok" : "error",
      message: pool
        ? "anneal-memory plugin ready"
        : "anneal-memory plugin pool not initialized",
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
