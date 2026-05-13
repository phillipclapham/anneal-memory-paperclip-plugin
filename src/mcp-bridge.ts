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
  timer?: NodeJS.Timeout;
}

/**
 * Minimal logger shape matching Paperclip's `ctx.logger`. The plugin
 * worker passes `ctx.logger` straight through; the bridge falls back
 * to a no-op logger when used standalone (e.g. from smoke tests).
 */
export interface BridgeLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export interface McpBridgeOptions {
  logger?: BridgeLogger;
  /** Default per-call timeout in ms. Default 30000. Set 0 to disable. */
  defaultCallTimeoutMs?: number;
  /** Maximum auto-restart attempts after MCP child exits unexpectedly. Default 3. */
  maxRestartAttempts?: number;
  /** Initial backoff for auto-restart in ms (doubles per attempt). Default 1000. */
  restartBackoffMs?: number;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_BACKOFF_MS = 1_000;

function noopLogger(): BridgeLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
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
 * to one `--db` path. Callers must hold one McpBridge per agent and route
 * tool calls through it.
 *
 * Features:
 * - per-call timeout (default 30s, override per call)
 * - auto-restart on unexpected child exit, with bounded exponential backoff
 * - structured stderr logging via Paperclip's `ctx.logger`
 * - synchronous best-effort cleanup hook for process exit handlers
 */
export class McpBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private stdoutBuffer = "";
  private initialized = false;
  private startupPromise: Promise<void> | null = null;
  private intentionalShutdown = false;
  private restartAttempts = 0;
  private readonly logger: BridgeLogger;
  private readonly defaultCallTimeoutMs: number;
  private readonly maxRestartAttempts: number;
  private readonly restartBackoffMs: number;

  constructor(
    private readonly command: string,
    private readonly dbPath: string,
    private readonly projectName: string,
    opts: McpBridgeOptions = {},
  ) {
    this.logger = opts.logger ?? noopLogger();
    this.defaultCallTimeoutMs = opts.defaultCallTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.maxRestartAttempts = opts.maxRestartAttempts ?? DEFAULT_MAX_RESTARTS;
    this.restartBackoffMs = opts.restartBackoffMs ?? DEFAULT_BACKOFF_MS;
  }

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
      this.logger.error("MCP child process error", {
        dbPath: this.dbPath,
        error: err.message,
      });
      this.failAllPending(new Error(`MCP child process error: ${err.message}`));
      this.child = null;
    });

    child.on("exit", (code, signal) => {
      const reason = signal
        ? `signal ${signal}`
        : code !== null
          ? `exit code ${code}`
          : "unknown";
      const wasIntentional = this.intentionalShutdown;
      this.logger.warn("MCP child exited", {
        dbPath: this.dbPath,
        reason,
        intentional: wasIntentional,
      });
      this.failAllPending(new Error(`MCP child process exited: ${reason}`));
      this.child = null;
      this.initialized = false;
      this.startupPromise = null;

      if (!wasIntentional && this.restartAttempts < this.maxRestartAttempts) {
        this.restartAttempts++;
        const backoff = this.restartBackoffMs * Math.pow(2, this.restartAttempts - 1);
        this.logger.info("scheduling MCP child auto-restart", {
          attempt: this.restartAttempts,
          maxAttempts: this.maxRestartAttempts,
          backoffMs: backoff,
        });
        setTimeout(() => {
          if (!this.intentionalShutdown) {
            this.start().catch((err) => {
              this.logger.error("MCP child auto-restart failed", {
                attempt: this.restartAttempts,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }, backoff).unref();
      } else if (!wasIntentional) {
        this.logger.error("MCP child exhausted restart attempts; bridge dead", {
          attempts: this.restartAttempts,
        });
      }
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Route MCP child stderr through Paperclip's structured logger so
      // debugging surfaces alongside lifecycle events instead of bypassing
      // them via raw process.stderr.
      const trimmed = chunk.trimEnd();
      if (trimmed) {
        this.logger.warn("MCP child stderr", {
          dbPath: this.dbPath,
          content: trimmed,
        });
      }
    });

    this.child = child;

    await this.sendRequest(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "anneal-memory-paperclip-plugin",
          version: "0.0.1",
        },
      },
      this.defaultCallTimeoutMs,
    );
    this.initialized = true;
    this.restartAttempts = 0; // successful start resets the backoff counter
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
   *
   * @param opts.timeoutMs - override the default per-call timeout (ms). Set 0 to disable.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    await this.start();
    const timeoutMs = opts.timeoutMs ?? this.defaultCallTimeoutMs;
    const result = await this.sendRequest("tools/call", { name, arguments: args }, timeoutMs);
    if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true) {
      const text = extractErrorText(result);
      throw new Error(text || `MCP tool '${name}' returned isError=true with no text content`);
    }
    return result;
  }

  /**
   * Read an MCP resource (e.g. `anneal://continuity`).
   */
  async readResource(uri: string, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    await this.start();
    return this.sendRequest(
      "resources/read",
      { uri },
      opts.timeoutMs ?? this.defaultCallTimeoutMs,
    );
  }

  async stop(): Promise<void> {
    this.intentionalShutdown = true;
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.initialized = false;
    this.failAllPending(new Error("MCP bridge stopped"));
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Best-effort SYNCHRONOUS cleanup for process exit handlers
   * (`process.on('exit', ...)` which cannot await). Sends SIGKILL
   * immediately. Use `stop()` for graceful shutdown.
   */
  killSync(): void {
    this.intentionalShutdown = true;
    if (this.child) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* swallow */
      }
      this.child = null;
    }
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error("MCP child process is not running"));
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingCall = { resolve, reject };
      if (timeoutMs && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`MCP call timed out after ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      child.stdin.write(JSON.stringify(req) + "\n", (err) => {
        if (err) {
          if (pending.timer) clearTimeout(pending.timer);
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
        if (pending.timer) clearTimeout(pending.timer);
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
        this.logger.warn("MCP stdout JSON parse error", {
          dbPath: this.dbPath,
          error: error.message,
        });
      }
    }
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Per-agent bridge pool. Spawns one MCP subprocess per agent, lazy on first
 * tool call. Reuses bridges across calls for the same agent within a worker
 * lifetime. Installs process-level shutdown hooks to clean up MCP children
 * when the parent (TS plugin worker) terminates.
 */
export class BridgePool {
  private bridges = new Map<string, McpBridge>();
  private shutdownHandlersInstalled = false;

  constructor(
    private readonly command: string,
    private readonly basePath: string,
    private readonly opts: McpBridgeOptions = {},
  ) {}

  bridgeFor(agentId: string): McpBridge {
    const existing = this.bridges.get(agentId);
    if (existing) return existing;
    const dbPath = path.join(this.basePath, agentId, "memory.db");
    const projectName = `paperclip-agent-${agentId}`;
    const bridge = new McpBridge(this.command, dbPath, projectName, this.opts);
    this.bridges.set(agentId, bridge);
    return bridge;
  }

  async stopBridge(agentId: string): Promise<void> {
    const bridge = this.bridges.get(agentId);
    if (!bridge) return;
    this.bridges.delete(agentId);
    await bridge.stop();
  }

  async stopAll(): Promise<void> {
    const stops = Array.from(this.bridges.values()).map((b) => b.stop());
    this.bridges.clear();
    await Promise.allSettled(stops);
  }

  /**
   * Best-effort SYNCHRONOUS shutdown — sends SIGKILL to every active child.
   * Called from `process.on('exit', ...)` handlers where async is not allowed.
   */
  killAllSync(): void {
    for (const bridge of this.bridges.values()) {
      bridge.killSync();
    }
    this.bridges.clear();
  }

  /**
   * Install process-level handlers so MCP child processes are cleaned up
   * when the TS plugin worker terminates. Without this, children become
   * orphans owned by PID 1 if the parent dies unexpectedly.
   *
   * Handlers registered (idempotent — multiple calls are no-ops after first):
   * - `exit`: synchronous SIGKILL of all children
   * - `SIGINT` (Ctrl-C): cleanup then exit 130
   * - `SIGTERM`: cleanup then exit 143
   * - `uncaughtException`: log + cleanup + exit 1
   */
  installShutdownHandlers(): void {
    if (this.shutdownHandlersInstalled) return;
    this.shutdownHandlersInstalled = true;

    const logger = this.opts.logger ?? noopLogger();
    const cleanup = () => {
      try {
        this.killAllSync();
      } catch {
        /* exit handlers must not throw */
      }
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      logger.info("BridgePool: SIGINT received, killing MCP children");
      cleanup();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      logger.info("BridgePool: SIGTERM received, killing MCP children");
      cleanup();
      process.exit(143);
    });
    process.on("uncaughtException", (err) => {
      logger.error("BridgePool: uncaught exception, killing MCP children", {
        error: err instanceof Error ? err.message : String(err),
      });
      cleanup();
      process.exit(1);
    });
  }
}
