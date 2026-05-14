/**
 * Plugin identity + tool name constants.
 *
 * Plugin ID is short (`anneal-memory`) rather than matching the full npm
 * package name. Paperclip's PLUGIN_SPEC permits this and short IDs produce
 * cleaner tool namespacing for agents: `anneal-memory:record` rather than
 * `@anneal-memory/paperclip-plugin:record`.
 */

export const PLUGIN_ID = "anneal-memory";
export const PLUGIN_VERSION = "0.1.0";

/**
 * Tool names match the six tools exposed by the anneal-memory Python MCP
 * server (anneal_memory.integrity.TOOLS). Each Paperclip tool call routes
 * to the MCP `tools/call` JSON-RPC method with the same name.
 */
export const TOOL_NAMES = {
  record: "record",
  recall: "recall",
  prepareWrap: "prepare_wrap",
  saveContinuity: "save_continuity",
  deleteEpisode: "delete_episode",
  status: "status",
} as const;

/**
 * Default MCP server command. Resolves via PATH; users can override via
 * plugin config when `anneal-memory` is installed at a non-standard location
 * (e.g. uvx, pipx with custom prefix, virtualenv).
 */
export const DEFAULT_MCP_COMMAND = "anneal-memory";
