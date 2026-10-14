import { randomUUID } from "node:crypto";
import { EXTERNAL_CHAT_RPC_MAX_BYTES, type ExternalChatClient, type ExternalChatOperation, type ExternalChatRpcResult } from "@multiremi/contracts/external-chats.js";
import type { DaemonProtocolLayer } from "../daemon-protocol/index.js";
import type { DaemonProtocolSession } from "../daemon-protocol/session.js";
import type { DaemonParsedFrame } from "../daemon-protocol/frames.js";
import { externalChatFailure, externalChatResult, isExternalChatWrite } from "./result.js";

interface Job {
  id: string;
  runtimeId: string;
  operation: ExternalChatOperation;
  bytes: number;
  deadlineAt: number;
  dispatched: boolean;
  timer: ReturnType<typeof setTimeout>;
  finish(result: ExternalChatRpcResult): void;
}

interface ConnectionRequests { active: Map<string, Job>; queue: Job[]; bytes: number }

export interface SocketExternalChatClientOptions {
  timeoutMs?: number;
  maxInFlight?: number;
  maxQueued?: number;
  maxPendingBytes?: number;
}

/** Socket-scoped, bounded reverse RPC. Native writes are never replayed or retried. */
export class SocketExternalChatClient implements ExternalChatClient {
  private readonly connections = new Map<DaemonProtocolSession, ConnectionRequests>();
  private readonly timeoutMs: number;
  private readonly maxInFlight: number;
  private readonly maxQueued: number;
  private readonly maxPendingBytes: number;

  constructor(private readonly layer: DaemonProtocolLayer, options: SocketExternalChatClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxInFlight = options.maxInFlight ?? 4;
    this.maxQueued = options.maxQueued ?? 32;
    this.maxPendingBytes = options.maxPendingBytes ?? EXTERNAL_CHAT_RPC_MAX_BYTES * 2;
    layer.onReply((frame, session) => this.reply(frame, session));
    layer.onClose(session => {
      const requests = this.connections.get(session);
      this.connections.delete(session);
      if (!requests) return;
      for (const job of [...requests.active.values(), ...requests.queue]) {
        job.finish(externalChatFailure("daemon_unreachable", "The owning Runtime disconnected",
          job.dispatched && isExternalChatWrite(job.operation)));
      }
    });
  }

  request(runtimeId: string, operation: ExternalChatOperation): Promise<ExternalChatRpcResult> {
    const session = this.layer.registry.sessionForRuntime(runtimeId) as DaemonProtocolSession | null;
    if (!session || session.isClosed) return Promise.resolve(externalChatFailure("daemon_unreachable", "The owning Runtime is offline"));
    const bytes = Buffer.byteLength(JSON.stringify(operation));
    if (bytes > EXTERNAL_CHAT_RPC_MAX_BYTES) return Promise.resolve(externalChatFailure("request_too_large", "The external Chat request is too large"));
    let requests = this.connections.get(session);
    if (!requests) this.connections.set(session, requests = { active: new Map(), queue: [], bytes: 0 });
    if ((requests.active.size >= this.maxInFlight && requests.queue.length >= this.maxQueued)
      || requests.bytes + bytes > this.maxPendingBytes) {
      return Promise.resolve(externalChatFailure("daemon_busy", "The owning Runtime's external Chat request queue is full"));
    }

    return new Promise(resolve => {
      const id = randomUUID();
      let done = false;
      const job: Job = { id, runtimeId, operation, bytes, deadlineAt: Date.now() + this.timeoutMs, dispatched: false,
        timer: setTimeout(() => job.finish(externalChatFailure("daemon_timeout", "The owning Runtime did not acknowledge the request",
          job.dispatched && isExternalChatWrite(operation))), this.timeoutMs),
        finish: result => {
          if (done) return;
          done = true;
          clearTimeout(job.timer);
          session.settleRequest(id);
          requests!.active.delete(id);
          requests!.queue = requests!.queue.filter(pending => pending !== job);
          requests!.bytes -= bytes;
          resolve(result);
          if (!session.isClosed) this.dispatch(session, requests!);
          if (!requests!.active.size && !requests!.queue.length) this.connections.delete(session);
        },
      };
      requests!.bytes += bytes;
      requests!.queue.push(job);
      this.dispatch(session, requests!);
    });
  }

  private dispatch(session: DaemonProtocolSession, requests: ConnectionRequests): void {
    while (!session.isClosed && requests.active.size < this.maxInFlight && requests.queue.length) {
      const job = requests.queue.shift()!;
      requests.active.set(job.id, job);
      if (Date.now() >= job.deadlineAt) {
        job.finish(externalChatFailure("daemon_timeout", "The owning Runtime did not acknowledge the request"));
        continue;
      }
      job.dispatched = true;
      try {
        if (session.request(job.id, { t: "external_chat.request", rt: job.runtimeId, p: { ...job.operation } })) continue;
      } catch {
        // The socket may have sent the request before failing; do not repeat a native write.
      }
      job.finish(externalChatFailure("daemon_unreachable", "The owning Runtime could not acknowledge the request", isExternalChatWrite(job.operation)));
    }
  }

  private reply(frame: DaemonParsedFrame, session: DaemonProtocolSession): void {
    const job = frame.re ? this.connections.get(session)?.active.get(frame.re) : null;
    if (!job || (frame.rt && frame.rt !== job.runtimeId)) return;
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(frame.payload)); }
    catch { bytes = EXTERNAL_CHAT_RPC_MAX_BYTES + 1; }
    if (bytes > EXTERNAL_CHAT_RPC_MAX_BYTES) {
      job.finish(externalChatFailure("invalid_external_chat_response", "The Runtime's external Chat response is too large", isExternalChatWrite(job.operation)));
      return;
    }
    job.finish(externalChatResult(frame.payload, job.operation));
  }
}
