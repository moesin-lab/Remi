import { DaemonProtocolClient, DaemonProtocolRpcError } from "./daemon-protocol-client.js";
import { MultiremiTaskReportOutbox, type MultiremiOutboxKind, type MultiremiOutboxRecord, type MultiremiTaskReportOutboxOptions } from "./outbox.js";
import { outboxRecordFrame } from "./report-frames.js";
import type { DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol.js";
import { daemonTraceTransport, type TraceCloseError } from "./trace-transport.js";

export interface DaemonReportTransport {
  report(type: string, partition: string, payload: Record<string, unknown>, wait?: boolean | { timeoutMs: number }): Promise<Record<string, unknown>>;
  rpc(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  bestEffort(type: string, payload: Record<string, unknown>): void;
  upgradeWaiting(): boolean;
}

const shared = new WeakMap<DaemonProtocolClient, { outbox: MultiremiTaskReportOutbox; owners: number; unsubscribe: () => void }>();
type DiscoverRestartHolds = NonNullable<MultiremiTaskReportOutboxOptions['discoverRestartHolds']>;
const restartSources = new WeakMap<DaemonProtocolClient, Map<string,DiscoverRestartHolds>>();

export function registerRestartSource(protocol: DaemonProtocolClient, source: string, discover: DiscoverRestartHolds): void {
  const sources = restartSources.get(protocol) ?? new Map();
  sources.set(source,discover);
  restartSources.set(protocol,sources);
}

export function acquireDaemonOutbox(protocol: DaemonProtocolClient, options: MultiremiTaskReportOutboxOptions): MultiremiTaskReportOutbox {
  let entry = shared.get(protocol);
  if (!entry) {
    const outbox: MultiremiTaskReportOutbox = new MultiremiTaskReportOutbox({ ...options,
      discoverRestartHolds: () => {
        const sources = restartSources.get(protocol);
        return [...(sources?.values() ?? [])].flatMap(discover => discover()).map(incident => ({...incident,
          legacyPaths:[...new Set([...incident.legacyPaths,...(sources?.keys() ?? [])])]}));
      },
      canSend: () => protocol.connectionState() === "connected" && !protocol.uplinkPaused(),
      deliver: async record => {
        if (record.kind === "messages") return options.deliver(record);
        const sequence = outbox.incidentSequence();
        const checkHold = () => { if (outbox.heldSince(record,sequence)) throw new DaemonProtocolRpcError('restart_policy_unverifiable', true); };
        checkHold();
        await deliverCompletionReceipt(protocol, record, checkHold);
        checkHold();
        const reply = await protocol.event(outboxRecordFrame(record) as ReturnType<typeof outboxRecordFrame> & { seq: number });
        if (record.terminal && !outbox.heldSince(record,sequence)) {
          const trace = daemonTraceTransport(protocol);
          if (trace.store.head(record.taskId)) {
            trace.close(record.taskId, record.kind === "turn.complete" ? "completed" : "failed", terminalError(record.payload));
          }
        }
        return reply;
      },
    });
    entry = { outbox, owners: 0, unsubscribe: protocol.onWelcome(() => outbox.pumpAll()) };
    shared.set(protocol, entry);
  }
  entry.owners++;
  return entry.outbox;
}

export async function releaseDaemonOutbox(protocol: DaemonProtocolClient): Promise<void> {
  const entry = shared.get(protocol);
  if (!entry || --entry.owners > 0) return;
  shared.delete(protocol);
  entry.unsubscribe();
  await entry.outbox.close();
}

export function daemonOutboxHasPriority(protocol: DaemonProtocolClient): boolean {
  const outbox = shared.get(protocol)?.outbox;
  return outbox?.pendingTaskIds().some(taskId => !outbox.isHeld(taskId)) ?? false;
}

/** The turn error a failed terminal report records on the trace. */
export function terminalError(payload: Record<string, unknown>): TraceCloseError | null {
  if (typeof payload.error !== "string") return null;
  const reason = typeof payload.failure_reason === "string" ? payload.failure_reason
    : typeof payload.failureReason === "string" ? payload.failureReason : null;
  return { message: payload.error, reason };
}

export interface DaemonReportTraceHooks {
  completion(taskId: string, status: "completed" | "failed"): DaemonTaskCompletionFields;
  close(taskId: string, status: "completed" | "failed", error?: TraceCloseError | null): void;
}

export function daemonReportTransport(protocol: DaemonProtocolClient, runtime: () => string | null, outbox: () => MultiremiTaskReportOutbox,
  waitTimeoutMs = 30_000, waitSignal?: () => AbortSignal, trace?: DaemonReportTraceHooks, executionGeneration: (taskId: string) => number = () => 0): DaemonReportTransport {
  return {
    async report(type, partition, payload, wait = false) {
      const runtimeId = runtime();
      const identity = outbox().reportIdentity(partition,runtimeId);
      const terminal = !outbox().classifyReport(partition,payload.receipt_id ?? identity.receipt_id) && (type === "turn.complete" || type === "task.fail");
      const status = type === "turn.complete" ? "completed" : "failed";
      // The fields describe the close below; the trace is sealed only after the
      // report is queued (or accepted), so a rejected completion can continue the turn.
      const generation = executionGeneration(partition);
      const p = { ...identity, ...(generation ? { generation } : {}), ...payload, runtime_id: payload.runtime_id ?? runtimeId,
        ...(terminal ? trace?.completion(partition, status) : {}) };
      const kind = (type.startsWith("task.") ? type.slice(5) : type) as MultiremiOutboxKind;
      if (wait) {
        const reply = await outbox().enqueueAndWait(partition, kind, p,
          typeof wait === "object" ? wait.timeoutMs : waitTimeoutMs, waitSignal?.());
        if (terminal && !outbox().isHeld(partition)) trace?.close(partition, status, terminalError(payload));
        return reply;
      }
      outbox().enqueue(partition, kind, p);
      if (terminal) trace?.close(partition, status, terminalError(payload));
      return { ok: true };
    },
    rpc: (type, payload) => protocol.rpc(type, payload, runtime() ?? undefined),
    upgradeWaiting: () => protocol.connectionState() === "upgrade_wait",
    bestEffort(type, payload) {
      const taskId = typeof payload.task_id === "string" ? payload.task_id : null;
      if (taskId && outbox().classifyReport(taskId,payload.receipt_id ?? outbox().reportIdentity(taskId,runtime()).receipt_id)) {
        outbox().preserveBestEffort(taskId,type,payload);
        return;
      }
      if (protocol.connectionState() !== "connected") return;
      const generation = taskId ? executionGeneration(taskId) : 0;
      try { protocol.send({ t: type, rt: runtime() ?? undefined,
        p: { ...(taskId ? outbox().reportIdentity(taskId,runtime()) : {}), ...(generation ? { generation } : {}), ...payload } }); }
      catch (error) { if (!(error instanceof DaemonProtocolRpcError)) throw error; }
    },
  };
}

/** The durable completion owns its receipt; transport failures retry delivery, never execution. */
async function deliverCompletionReceipt(protocol: DaemonProtocolClient, record: MultiremiOutboxRecord, checkHold: () => void): Promise<void> {
  if (record.kind !== "turn.complete" || !record.payload.input_receipt) return;
  const { messages } = record.payload.input_receipt as { messages: Array<{ id: string; seq: number }> };
  const { offer_generation, content_hash, receipt_id } = record.payload;
  const input = { turn_id: record.payload.turn_id, attempt_id: record.taskId, input_to_seq: record.payload.input_to_seq,
    offer_generation, content_hash, receipt_id, ...(record.payload.generation !== undefined ? { generation: record.payload.generation } : {}) };
  const runtimeId = record.payload.runtime_id as string;
  const receipt = (ids: string[]) => { checkHold(); return protocol.rpc("turn.input", { ...input, message_ids: ids }, runtimeId); };
  try {
    await receipt(messages.map(message => message.id));
  } catch (error) {
    // A previous completion may have committed before its ACK was lost. Its
    // receipt is then stale; replay the terminal report to obtain its idempotent ACK.
    if (error instanceof DaemonProtocolRpcError && error.code === "stale_attempt") return;
    if (!(error instanceof DaemonProtocolRpcError) || error.code !== "input_gap") throw error;
    checkHold();
    const result = await protocol.rpc("turn.input", { ...input, message_ids: [], resync: true }, runtimeId);
    const aligned = result.input as { attempt_id: string; turn_id: string; input_from_seq: number } | undefined;
    if (!aligned || aligned.attempt_id !== record.taskId || aligned.turn_id !== input.turn_id) throw error;
    try {
      await receipt(messages.filter(message => message.seq > aligned.input_from_seq).map(message => message.id));
    } catch (retryError) {
      // Keep the existing unread reminder/fallback gate authoritative. No receipt
      // is fabricated when the model has not read a folded body.
      if (!(retryError instanceof DaemonProtocolRpcError) || retryError.code !== "input_gap") throw retryError;
    }
  }
}
