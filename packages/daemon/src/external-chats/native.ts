import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import WebSocket from "ws";
import { EXTERNAL_CHAT_MAX_TEXT_CHARS, EXTERNAL_CHAT_RPC_MAX_BYTES } from "@multiremi/contracts/external-chats";

export type NativeObject = Record<string, unknown>;
export function object(value: unknown): NativeObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as NativeObject : {};
}
export function array(value: unknown): NativeObject[] {
  return Array.isArray(value) ? value.map(object) : [];
}
export function string(value: unknown): string { return typeof value === "string" ? value : ""; }

export class NativeError extends Error {
  constructor(readonly code: string | number, readonly detail = "") {
    super("Native Codex request failed");
  }
}

export interface NativeRequest {
  id: string;
  nativeId: string | number;
  method: string;
  params: NativeObject;
}

export interface NativeConnection {
  readonly connection: "live" | "isolated";
  readonly version: string;
  readonly attached: Set<string>;
  readonly closed?: boolean;
  rpc(method: string, params?: NativeObject): Promise<NativeObject>;
  pending(threadId: string): NativeRequest[];
  respond(id: string, result: NativeObject): void;
  close(): Promise<void>;
}

export interface NativeOptions {
  codexBinary?: string;
  codexArgs?: string[];
  uid?: number;
  requestTimeoutMs?: number;
}

export type NativeConnectionFactory = (home: string, options: NativeOptions) => Promise<NativeConnection>;
const MAX_NATIVE_BYTES = 16 * 1024 * 1024;
const SUPPORTED_REQUESTS = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval", "item/tool/requestUserInput",
]);

/** Display every field that may change what a basic native approval authorizes. */
export function nativeRequestText(method: string, params: NativeObject): string {
  const fields = method === "item/commandExecution/requestApproval"
    ? ["command", "cwd", "reason", "kind", "environmentId", "commandActions", "additionalPermissions", "networkApprovalContext", "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments"]
    : method === "item/fileChange/requestApproval" ? ["reason", "grantRoot"]
    : ["reason", "cwd", "environmentId", "permissions"];
  return JSON.stringify(Object.fromEntries(fields.filter(field => params[field] !== undefined && params[field] !== null).map(field => [field, params[field]])), null, 2);
}

export function supportedNativeRequest(method: string, params: NativeObject): boolean {
  if (!SUPPORTED_REQUESTS.has(method) || !string(params.threadId) || !string(params.turnId)) return false;
  // Leave room for bounded history in the same response; never present only part of an approval.
  if (Buffer.byteLength(JSON.stringify(params)) > EXTERNAL_CHAT_RPC_MAX_BYTES / 2) return false;
  if (method !== "item/tool/requestUserInput") return nativeRequestText(method, params).length <= EXTERNAL_CHAT_MAX_TEXT_CHARS;
  if (!Array.isArray(params.questions) || params.questions.length === 0 || params.questions.length > 20) return false;
  const seen = new Set<string>();
  return params.questions.every(value => {
    const question = object(value);
    const id = string(question.id);
    // Question IDs are JSON map keys, including Unicode/spaces, rather than filesystem or URL references.
    if (!id || id.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)
      || seen.has(id) || typeof question.header !== "string" || question.header.length > 100
      || typeof question.question !== "string" || question.question.length > 4_000) return false;
    seen.add(id);
    if (question.options === undefined || question.options === null) return true;
    return Array.isArray(question.options) && question.options.length <= 30 && question.options.every(value => {
      const option = object(value);
      return typeof option.label === "string" && option.label.length <= 240 && typeof option.description === "string" && option.description.length <= 1_000;
    });
  });
}

/** Only a missing socket permits a private process; a failed live connection never falls back. */
export async function connectNative(home: string, options: NativeOptions): Promise<NativeConnection> {
  home = realpathSync(home);
  const socket = join(home, "app-server-control", "app-server-control.sock");
  let livePath: string | undefined;
  try {
    let current = socket;
    for (let hop = 0; hop < 16; hop++) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        current = resolve(dirname(current), readlinkSync(current));
        continue;
      }
      if (!stat.isSocket() || stat.uid !== options.uid) throw new NativeError("source_socket_invalid");
      // Bun cannot realpath a Unix socket; its existing parent is enough to normalize the path.
      livePath = join(realpathSync(dirname(current)), basename(current));
      break;
    }
    if (!livePath) throw new NativeError("source_socket_invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const channel = new Channel(livePath ? "live" : "isolated", options.requestTimeoutMs ?? 15_000);
  try {
    if (livePath) {
      await channel.openWebSocket(livePath);
    } else {
      const binary = options.codexBinary ?? process.env.CODEX_PATH ?? Bun.which("codex");
      if (!binary || /claude|cluade/i.test(basename(realpathSync(binary)))) throw new NativeError("codex_unavailable");
      const prefix = options.codexArgs ?? [];
      const version = spawnSync(binary, [...prefix, "--version"], {
        env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 8_000, stdio: ["ignore", "pipe", "ignore"],
      });
      const match = version.status === 0 && version.stdout.match(/codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)/);
      // This is the oldest cold-process writer implementation verified for this connector.
      if (!match || Number(match[1]) === 0 && (Number(match[2]) < 162 || Number(match[2]) === 162 && Number(match[3]) < 1)) {
        throw new NativeError("codex_writer_version_unsupported");
      }
      channel.openStdio(binary, [...prefix, "app-server", "--listen", "stdio://"], home);
    }
    const initialized = await channel.rpc("initialize", {
      clientInfo: { name: "codex-backend", title: "Remi native chats", version: "1" },
      capabilities: { experimentalApi: true },
    });
    if (realpathSync(string(initialized.codexHome)) !== home) throw new NativeError("source_home_mismatch");
    channel.version = string(initialized.userAgent).match(/(?:codex_cli_rs|codex-cli|codex-tui|codex|Codex Desktop)\/(\d+\.\d+\.\d+[^\s;)]*)/)?.[1] ?? "";
    channel.notify("initialized");
    return channel;
  } catch (error) {
    await channel.close();
    throw error;
  }
}

class Channel implements NativeConnection {
  version = "";
  readonly attached = new Set<string>();
  private readonly generation = randomUUID().replaceAll("-", "");
  private readonly requests = new Map<string, NativeRequest>();
  private readonly inflight = new Map<number, { resolve(value: NativeObject): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  closed = false;
  private socket?: WebSocket;
  private child?: ChildProcess;
  private closePromise?: Promise<void>;

  constructor(readonly connection: "live" | "isolated", private timeoutMs: number) {}

  async openWebSocket(socket: string): Promise<void> {
    // Keep Bun's Unix handshake compatible with Codex Desktop 0.154 by disabling compression.
    const ws = new WebSocket(`ws+unix://${socket}:/`, { handshakeTimeout: this.timeoutMs, maxPayload: MAX_NATIVE_BYTES, perMessageDeflate: false });
    this.socket = ws;
    ws.on("message", data => this.receive(data.toString()));
    ws.on("error", () => this.fail(new NativeError("native_connection_failed")));
    ws.on("close", () => this.fail(new NativeError("native_connection_closed")));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", () => reject(new NativeError("native_connection_failed")));
    });
  }

  openStdio(binary: string, args: string[], home: string): void {
    const child = spawn(binary, args, {
      env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "ignore"],
      detached: process.platform !== "win32",
    });
    this.child = child;
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_NATIVE_BYTES) {
        this.fail(new NativeError("native_response_too_large"));
        return;
      }
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) this.receive(line);
      }
    });
    child.on("error", () => this.fail(new NativeError("native_connection_failed")));
    child.on("exit", () => this.fail(new NativeError("native_connection_closed")));
    child.stdin!.on("error", () => this.fail(new NativeError("native_connection_closed")));
  }

  rpc(method: string, params?: NativeObject): Promise<NativeObject> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new NativeError("native_connection_closed"));
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        reject(new NativeError("native_request_timeout"));
      }, this.timeoutMs);
      this.inflight.set(id, { resolve, reject, timer });
      try { this.write({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { clearTimeout(timer); this.inflight.delete(id); reject(error); this.fail(new NativeError("native_connection_failed")); }
    });
  }

  notify(method: string): void { this.write({ method }); }
  pending(threadId: string): NativeRequest[] { return [...this.requests.values()].filter(r => r.params.threadId === threadId); }

  respond(id: string, result: NativeObject): void {
    const request = this.requests.get(id);
    if (!request) throw new NativeError("native_request_unknown");
    this.write({ id: request.nativeId, result });
    this.requests.delete(id);
  }

  private write(message: NativeObject): void {
    if (this.closed) throw new NativeError("native_connection_closed");
    const text = JSON.stringify(message);
    const completed = (error?: Error | null) => { if (error) this.fail(new NativeError("native_connection_failed")); };
    if (this.socket) this.socket.send(text, completed);
    else this.child!.stdin!.write(text + "\n", completed);
  }

  private receive(text: string): void {
    let message: NativeObject;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid native message");
      message = parsed;
    }
    catch { this.fail(new NativeError("native_protocol_invalid")); return; }
    if (typeof message.id === "number" && !message.method) {
      const pending = this.inflight.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.inflight.delete(message.id);
      if (message.error) {
        const error = object(message.error);
        pending.reject(new NativeError(typeof error.code === "number" ? error.code : "native_error", string(error.message)));
      } else pending.resolve(object(message.result));
    } else if (message.method && (typeof message.id === "number" || typeof message.id === "string")) {
      const method = string(message.method);
      const params = object(message.params);
      if (!supportedNativeRequest(method, params)) {
        // Live app-servers broadcast callbacks to multiple clients; the first
        // reply (including an error) consumes the request for all of them.
        // Leave client-specific tools/auth and oversized approvals to their
        // native client. A rejected callback must not poison history or later turns.
        if (this.connection === "live") return;
        // This private stdio process has no other client that could answer it.
        try { this.write({ id: message.id, error: { code: -32601, message: "Remi does not support this native client request" } }); }
        catch { this.fail(new NativeError("native_connection_failed")); }
        return;
      }
      const key = `${this.generation}_${createHash("sha256").update(JSON.stringify(message.id)).digest("hex").slice(0, 24)}`;
      this.requests.set(key, { id: key, nativeId: message.id, method, params });
    } else if (message.method === "serverRequest/resolved") {
      const params = object(message.params);
      for (const [key, request] of this.requests) if (request.nativeId === params.requestId) this.requests.delete(key);
    } else if (message.method === "thread/closed") {
      const id = string(object(message.params).threadId);
      this.attached.delete(id);
      for (const [key, request] of this.requests) if (request.params.threadId === id) this.requests.delete(key);
    }
  }

  private invalidate(error: Error): void {
    this.closed = true;
    for (const pending of this.inflight.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.inflight.clear();
    this.requests.clear();
    this.attached.clear();
  }

  private fail(error: Error): void {
    this.invalidate(error);
    void this.close().catch(() => {});
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.invalidate(new NativeError("native_connection_closed"));
      this.closePromise = Promise.resolve().then(() => this.cleanup());
    }
    return this.closePromise;
  }

  private async cleanup(): Promise<void> {
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); socket.removeListener("close", finish); resolve(); };
        const timer = setTimeout(finish, 1_000);
        socket.once("close", finish);
        socket.terminate();
      });
    }
    const child = this.child;
    if (!child?.pid) return;
    child.stdin?.end();
    await this.exited(child, 1_000);
    if (process.platform !== "win32") {
      // detached spawn gives this child its own group, even after its leader exits.
      if (!this.groupAlive(child)) return;
      this.killOwned(child, "SIGTERM");
      if (await this.groupExited(child, 1_000)) return;
      this.killOwned(child, "SIGKILL");
      if (!await this.groupExited(child, 1_000)) throw new NativeError("native_cleanup_failed");
      await this.exited(child, 1_000);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    this.killOwned(child, "SIGTERM");
    if (await this.exited(child, 1_000)) return;
    this.killOwned(child, "SIGKILL");
    if (!await this.exited(child, 1_000)) throw new NativeError("native_cleanup_failed");
  }

  private exited(child: ChildProcess, timeout: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = (exited: boolean) => { clearTimeout(timer); child.removeListener("exit", onExit); resolve(exited); };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeout);
      child.once("exit", onExit);
    });
  }

  private killOwned(child: ChildProcess, signal: NodeJS.Signals): void {
    this.assertOwnedGroup(child);
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid!, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private assertOwnedGroup(child: ChildProcess): void {
    // Only the PID assigned by our detached spawn can be used; caller/native request IDs never select a group.
    if (child !== this.child || !child.pid || child.pid <= 0 || child.pid === process.pid) throw new NativeError("native_cleanup_failed");
  }

  private groupAlive(child: ChildProcess): boolean {
    this.assertOwnedGroup(child);
    try { process.kill(-child.pid!, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      // A group being reaped can transiently return EPERM on macOS; it is still not proven absent.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
      throw error;
    }
  }

  private async groupExited(child: ChildProcess, timeout: number): Promise<boolean> {
    const until = Date.now() + timeout;
    while (this.groupAlive(child)) {
      if (Date.now() >= until) return false;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return true;
  }
}
