import type { DaemonProtocolSession } from '@multiremi/api/daemon-protocol/session.js';
import { DaemonProtocolLayer, type DaemonProtocolIdentity } from "@multiremi/api/daemon-protocol/index.js";
import { DaemonTaskOffers, prepareTaskOffer } from "@multiremi/api/daemon-protocol/task-offers.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { createProjectKnowledgeServiceFromEnv, type ProjectKnowledgeServiceContract } from "@multiremi/project-knowledge/service.js";
import { createRepositoryWikiServiceFromEnv, type RepositoryWikiServiceContract } from "@multiremi/repository-wiki/service.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { daemonTaskWireResponse } from "@multiremi/api/wire/tasks.js";
import { compareDaemonPendingTasks } from "@multiremi/api/helpers/tasks.js";

interface TaskOfferFixtureOptions {
  projectKnowledge?: ProjectKnowledgeServiceContract;
  repositoryWiki?: RepositoryWikiServiceContract;
  headers?: HeadersInit;
  authToken?: string;
  reply?: { ok: boolean; code?: string };
}

const fixtureReceipts = new WeakMap<MultiremiStore, Map<string, { offer_generation: string; receipt_id: string; content_hash: string; daemon_id: string }>>();

export function fixtureOfferReceipt(store: MultiremiStore, taskId: string) {
  return fixtureReceipts.get(store)?.get(taskId);
}

export async function adoptFixtureOffer(session: DaemonProtocolSession, store: MultiremiStore, offer: Record<string, any>, daemonId: string) {
  const attemptId = offer.p.attempt_id ?? offer.p.id;
  const binding = store.getAttemptSystemPrompt(attemptId)!;
  const receipt = { offer_generation: offer.p.offer_generation, receipt_id: crypto.randomUUID(), content_hash: binding.contentHash, daemon_id: daemonId };
  await session.handleMessage(JSON.stringify({ v: 2, t: 'task.offer_adopt', id: `adopt-${offer.seq}`, rt: offer.rt,
    p: { workspace_id: binding.workspaceId, runtime_id: offer.rt, attempt_id: attemptId,
      ...receipt } }));
  if (store.systemPromptsRepo().offerStatus({ workspace_id: binding.workspaceId, runtime_id: offer.rt, attempt_id: attemptId, ...receipt }) !== 'adopted') throw new Error('Fixture offer adoption did not persist');
  const receipts = fixtureReceipts.get(store) ?? new Map();
  receipts.set(attemptId, receipt);
  fixtureReceipts.set(store, receipts);
}

class OfferUpgradeRejected extends Error {
  constructor(readonly response: Response) { super("Daemon offer upgrade rejected"); }
}

/** Unit-test transport: encoded hello -> production pump -> offer -> encoded accept. */
export async function receiveTaskOffer(store: MultiremiStore, runtimeId: string, options: TaskOfferFixtureOptions = {}): Promise<Record<string, any> | null> {
  let runtime = store.getRuntime(runtimeId);
  if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
  if (!runtime.daemonId) runtime = store.registerRuntime({ id: runtimeId, name: runtime.name, provider: runtime.provider, workspaceId: runtime.workspaceId, daemonId: `dmn_${runtimeId}` });
  // Versionless unit runtimes used the in-process parallel-execution default.
  // A real v2 hello records its version, so advertise the same capability first.
  if (!(runtime.metadata.cli_version ?? runtime.metadata.cliVersion) && runtime.metadata.parallel_agent_execution === undefined) {
    store.updateRuntime(runtimeId, { metadata: { ...runtime.metadata, parallel_agent_execution: 1 } });
  }
  const layer = new DaemonProtocolLayer({ store });
  const project = options.projectKnowledge ?? createProjectKnowledgeServiceFromEnv(store);
  const wiki = options.repositoryWiki ?? createRepositoryWikiServiceFromEnv(store);
  const frames: Record<string, any>[] = [];
  class SingleOffer extends DaemonTaskOffers {
    override kick(id?: string | null, sweep = false) {
      if (!frames.some(frame => frame.t === 'task.offer')) super.kick(id, sweep);
    }
  }
  new SingleOffer({ store, layer, prepare: task => prepareTaskOffer(store, task, project, wiki) });
  let identity: DaemonProtocolIdentity = { accessToken: null, masterToken: true };
  if (options.headers) {
    const resolved = await layer.resolveIdentity(new Request("http://fixture/api/daemon/ws?protocol=2", { headers: options.headers }), options.authToken ?? "");
    if ("response" in resolved) { layer.stop(); throw new OfferUpgradeRejected(resolved.response); }
    identity = resolved.identity;
  }
  const activeTaskIds = store.listTasksForRuntimeStatuses(runtimeId, ["dispatched", "running", "awaiting_human"]).filter(task => task.acceptedAt || task.startedAt).map(task => task.id);
  const session = layer.openSession({ send: text => { frames.push(JSON.parse(text)); return text.length; }, close() {} },
    identity);
  try {
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: {
      protocol: 2, daemon_id: runtime.daemonId ?? "dmn_offer_unit", cli_version: DAEMON_MIN_CLI_VERSION, caps: ["offer", "prompt.policy.adopt.v1"],
      runtimes: [{ runtime_id: runtimeId, provider: runtime.provider, max_concurrency: runtime.maxConcurrency ?? 1, active_task_ids: activeTaskIds,
        capabilities: { agent_plugin_protocol: runtime.metadata.agent_plugin_protocol } }],
    } }));
    await session.handleMessage(JSON.stringify({ v: 2, t: "runtime.ready", rt: runtimeId, p: { active_task_ids: activeTaskIds } }));
    await layer.drain();
    const offer = frames.find(frame => frame.t === "task.offer");
    if (!offer) return null;
    // Stop after the production reply hooks commit, before the next pump's
    // microtask can claim more work. Stopping before the reply drops it.
    if (options.reply?.ok !== false) await adoptFixtureOffer(session, store, offer, runtime.daemonId ?? "dmn_offer_unit");
    layer.onReply(() => layer.stop());
    await session.handleMessage(JSON.stringify({ v: 2, t: "res", re: String(offer.seq), ack: offer.seq, p: options.reply ?? { ok: true } }));
    return offer.p;
  } finally { layer.closeAll(); layer.stop(); await layer.drain(); }
}

// Exercise the real hello/runtime.ready recovery handlers without dispatching
// their newly queued retries. A null prepare callback does not prevent claims:
// the pump calls claimTask before prepare, leaving that retry dispatched.
class RecoveryOnlyTaskOffers extends DaemonTaskOffers {
  override kick(): void {}
}

export async function reconcileRuntimeReady(store: MultiremiStore, runtimeId: string, activeTaskIds: string[] = []): Promise<Record<string, any>[]> {
  const layer = new DaemonProtocolLayer({ store });
  const offers = new RecoveryOnlyTaskOffers({ store, layer, prepare: async () => null, autostart: false });
  const runtime = store.getRuntime(runtimeId);
  const frames: Record<string, any>[] = [];
  const session = layer.openSession({ send: text => { frames.push(JSON.parse(text)); return text.length; }, close() {} },
    { accessToken: null, masterToken: true });
  try {
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: {
      protocol: 2, daemon_id: runtime?.daemonId ?? "dmn_offer_unit", cli_version: DAEMON_MIN_CLI_VERSION, caps: [],
      runtimes: [{ runtime_id: runtimeId, provider: runtime?.provider ?? "claude", max_concurrency: 1, active_task_ids: activeTaskIds }],
    } }));
    offers.start();
    await session.handleMessage(JSON.stringify({ v: 2, t: "runtime.ready", rt: runtimeId, p: { active_task_ids: activeTaskIds } }));
    return frames;
  } finally { layer.closeAll(); layer.stop(); await layer.drain(); }
}

/** Preserve payload assertions while making the test's transport change explicit. */
export async function taskOfferResponse(store: MultiremiStore, runtimeId: string,
  options: Parameters<typeof receiveTaskOffer>[2] = {}): Promise<Response> {
  try { return Response.json({ task: await receiveTaskOffer(store, runtimeId, options) }); }
  catch (error) { if (error instanceof OfferUpgradeRejected) return error.response; throw error; }
}

/** Legacy pending payload assertions belong to the store/wire unit boundary, not a removed route. */
export function pendingTaskWireSnapshot(store: MultiremiStore, runtimeId: string): Record<string, any>[] {
  return store.listTasksForRuntimeStatuses(runtimeId, ["queued", "dispatched"])
    .sort(compareDaemonPendingTasks).map(task => daemonTaskWireResponse(task, store.getTaskTriggerMetadata(task)));
}
