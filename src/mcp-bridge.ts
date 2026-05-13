import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * MCP JSON-RPC 2.0 request shape. Newline-delimited per MCP 2024-11-05 spec.
 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Pull text from an MCP tool error result. Result shape:
 * `{content: [{type: "text", text: "..."}, ...], isError: true}`.
 */
function extractErrorText(result: unknown): string {
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
 * Wraps a single anneal-memory MCP server subprocess. One bridge per scope
 * (typically per Paperclip agent). Owns the child process lifecycle and
 * JSON-RPC dispatch.
 *
 * Not safe to share across scopes — the underlying SQLite store is bound
 * to one --db path. Callers must hold one McpBridge per agent and route
 * tool calls through it.
 */
export class McpBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private stdoutBuffer = "";
  private initialized = false;
  private startupPromise: Promise<void> | null = null;

  constructor(
    private readonly command: string,
    private readonly dbPath: string,
    private readonly projectName: string,
  ) {}

  /**
   * Start the MCP child process and run the MCP `initialize` handshake.
   * Idempotent — multiple calls return the same promise.
   */
  async start(): Promise<void> {
    if (this.startupPromise) return this.startupPromise;
    this.startupPromise = this.doStart();
    return this.startupPromise;
  }

  private async doStart(): Promise<void> {
    await mkdir(path.dirname(this.dbPath), { recursive: true });

    // anneal-memory CLI structure: top-level args (--db, --project-name) BEFORE
    // the `serve` subcommand. Verified May 13, 2026 against v0.3.0.
    const child = spawn(
      this.command,
      ["--db", this.dbPath, "--project-name", this.projectName, "serve"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    child.on("error", (err) => {
      this.failAllPending(new Error(`MCP child process error: ${err.message}`));
      this.child = null;
    });
    child.on("exit", (code, signal) => {
      const reason = signal
        ? `signal ${signal}`
        : code !== null
          ? `exit code ${code}`
          : "unknown";
      this.failAllPending(new Error(`MCP child process exited: ${reason}`));
      this.child = null;
      this.initialized = false;
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Surface child stderr to host logs via console.error; plugin worker
      // wraps this in ctx.logger when constructing the bridge.
      process.stderr.write(`[anneal-memory mcp] ${chunk}`);
    });

    this.child = child;

    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "anneal-memory-paperclip-plugin",
        version: "0.0.1",
      },
    });
    this.initialized = true;
  }

  /**
   * Invoke an MCP tool. Translates Paperclip-level tool calls into MCP
   * `tools/call` JSON-RPC dispatches.
   *
   * Per MCP 2024-11-05 spec, tool-level errors arrive as
   * `{content: [...], isError: true}` inside a successful JSON-RPC result —
   * distinct from protocol-level errors. We convert tool-errors into
   * Promise rejections so callers get a uniform error surface regardless
   * of which layer failed.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.start();
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true) {
      const text = extractErrorText(result);
      throw new Error(text || `MCP tool '${name}' returned isError=true with no text content`);
    }
    return result;
  }

  /**
   * Read an MCP resource (e.g. `anneal://continuity`).
   */
  async readResource(uri: string): Promise<unknown> {
    await this.start();
    return this.sendRequest("resources/read", { uri });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.initialized = false;
    this.failAllPending(new Error("MCP bridge stopped"));
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error("MCP child process is not running"));
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify(req) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg.id !== "number") continue;
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(
            new Error(
              `MCP error ${msg.error.code}: ${msg.error.message}${
                msg.error.data ? ` (${JSON.stringify(msg.error.data)})` : ""
              }`,
            ),
          );
        } else {
          pending.resolve(msg.result);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        process.stderr.write(
          `[anneal-memory mcp] JSON parse error on stdout line: ${error.message}\n`,
        );
      }
    }
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Per-agent bridge pool. Spawns one MCP subprocess per agent, lazy on first
 * tool call. Reuses bridges across calls for the same agent within a worker
 * lifetime.
 */
export class BridgePool {
  private bridges = new Map<string, McpBridge>();

  constructor(
    private readonly command: string,
    private readonly basePath: string,
  ) {}

  bridgeFor(agentId: string): McpBridge {
    const existing = this.bridges.get(agentId);
    if (existing) return existing;
    const dbPath = path.join(this.basePath, agentId, "memory.db");
    const projectName = `paperclip-agent-${agentId}`;
    const bridge = new McpBridge(this.command, dbPath, projectName);
    this.bridges.set(agentId, bridge);
    return bridge;
  }

  async stopAll(): Promise<void> {
    const stops = Array.from(this.bridges.values()).map((b) => b.stop());
    this.bridges.clear();
    await Promise.allSettled(stops);
  }
}
