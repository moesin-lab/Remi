import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { MultiremiPlatformOperation, MultiremiPlatformPreflight, ReportPlatformOperationInput } from "@multiremi/contracts";
import type { PlatformUpdaterClient } from "@remi-platform/updater/client.js";
import type { PlatformDeploymentDriver } from "@remi-platform/updater/types.js";
import { PlatformUpdateWorker } from "@remi-platform/updater/worker.js";
import { LocalProfileOperationOutbox } from "@remi-platform/updater/operation-outbox.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RecoveryRequiredError } from "@remi-platform/updater/safety.js";
import { DATA_SCHEMA } from "./helpers.js";

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); });

function fixture() {
  const current = { version: "1.0.0", ref: "old", dataSchema: DATA_SCHEMA, publishedAt: null, releaseUrl: null, manifestUrl: null, apiImage: null, webImage: null };
  const reports: ReportPlatformOperationInput[] = [];
  const inspections: Array<{ releaseFeedUrl?: string | null; preflight?: MultiremiPlatformPreflight | null }> = [];
  const state = { source: null as string | null, released: 0, executed: 0, claim: null as MultiremiPlatformOperation | null, failReport: false, recover: false, apiOffline: false, events: [] as string[] };
  const client = {
    async heartbeat(_inspection: unknown, _latest: unknown, update: typeof inspections[number]) { state.events.push("heartbeat"); if (state.apiOffline) throw new Error("API unavailable"); inspections.push(update); return { releaseFeedUrl: state.source }; },
    async claim() { return state.claim; },
    async report(_id: string, input: ReportPlatformOperationInput) { reports.push(input); if (state.failReport) throw new Error("API unavailable"); },
    async drainRelease() { state.released++; },
  } as unknown as PlatformUpdaterClient;
  const driver: PlatformDeploymentDriver = {
    kind: "docker_compose",
    async recoverInterrupted() { state.events.push("recover"); },
    async inspect() { return { driver: this.kind, currentRelease: current, recentReleases: [], services: [] }; },
    async preflight() { return { ready: true, checkedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, checks: [{ code: "host", ok: true, message: "ready" }] }; },
    async execute() { state.executed++; if (state.recover) throw new RecoveryRequiredError("Recovery required"); return current; },
  };
  const operation = { id: "pop_worker", kind: "restart", status: "preparing", driver: "docker_compose", targetVersion: null, targetRef: null, targetManifest: {}, progress: {}, cancelRequested: false, requestedBy: "local", output: null, error: null, previousRelease: null, resultRelease: null, createdAt: "", updatedAt: "", startedAt: null, finishedAt: null } satisfies MultiremiPlatformOperation;
  const urls: string[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    return Response.json({ ...current, version: "1.0.1" });
  }) as typeof fetch);
  return { client, driver, state, reports, inspections, operation, urls, worker: new PlatformUpdateWorker(client, driver, "https://default.example/release.json") };
}

describe("platform updater worker", () => {
  it('reports source artifacts and blocks a new internal updater against an image-only source', async () => {
    const test = fixture();
    Object.assign(test.driver, { updateMode: 'internal_application' });
    await test.worker.tick();
    const check = test.inspections.find(item => item.preflight)?.preflight;
    expect(check?.ready).toBe(false);
    expect(check?.source?.url).toBe('https://default.example/release.json');
    expect(check?.source?.modes.find(mode => mode.mode === 'internal_application')).toMatchObject({ available: false, missing: ['application_bundle'] });
    expect(check?.checks.find(item => item.code === 'release_artifacts')?.ok).toBe(false);
  });
  it('keeps failed source discovery explicit instead of retaining supported modes', async () => {
    const test = fixture();
    await test.worker.tick();
    test.state.source = 'https://broken.example/feed';
    fetchSpy!.mockImplementation(async () => { throw new Error('unreachable'); });
    await test.worker.tick();
    const check = test.inspections.filter(item => item.preflight).at(-1)?.preflight;
    expect(check?.source).toEqual({ url: test.state.source, manifestUrl: null, modes: [], error: 'unreachable' });
    expect(check?.ready).toBe(false);
  });
  it('rejects capabilities from a manifest that does not match the feed identity', async () => {
    const test = fixture();
    fetchSpy!.mockImplementation(async (input: Parameters<typeof fetch>[0]) => Response.json(String(input).endsWith('/manifest')
      ? { version: '9.0.0', ref: 'other' }
      : { version: '1.0.1', ref: 'old', manifestUrl: 'https://default.example/manifest' }));
    await test.worker.tick();
    const check = test.inspections.find(item => item.preflight)?.preflight;
    expect(check?.ready).toBe(false);
    expect(check?.source?.modes).toEqual([]);
    expect(check?.source?.error).toContain('identities differ');
  });
  it('handles an internal check queued before the first host heartbeat registers the driver', async () => {
    const test = fixture();
    test.state.claim = { ...test.operation, kind: 'check_updates', driver: 'systemd_release' };
    await test.worker.tick();
    expect(test.state.executed).toBe(1);
    expect(test.reports.at(-1)?.status).toBe('succeeded');
  });
  it.each(['url', 'ref', 'version'] as const)('resolves a wrapped custom feed for an internal update by %s', async target => {
    const test = fixture();
    const manifest = { version: '1.0.1', ref: '2'.repeat(40), dataSchema: DATA_SCHEMA, application: { format: 1 } };
    fetchSpy!.mockImplementation(async () => Response.json({ latest: manifest }));
    test.state.claim = { ...test.operation, kind: 'update', targetVersion: 'v1.0.1',
      targetRef: target === 'url' ? 'https://default.example/release.json' : target === 'ref' ? manifest.ref : null };
    let executed = false;
    test.driver.execute = async operation => { executed = true; expect(operation.targetManifest).toEqual(manifest); return null; };
    await test.worker.tick();
    expect(executed).toBe(true);
    expect(test.reports.at(-1)?.status).toBe('succeeded');
  });
  it.each(['version', 'ref'] as const)('rejects a custom feed whose %s changes after the internal request', async changed => {
    const test = fixture();
    await test.worker.tick();
    test.state.claim = { ...test.operation, kind: 'update', targetVersion: '1.0.1', targetRef: 'https://default.example/release.json' };
    fetchSpy!.mockImplementation(async () => Response.json({ latest: { version: changed === 'version' ? '1.0.2' : '1.0.1', ref: changed === 'ref' ? 'other' : 'old' } }));
    await test.worker.tick();
    expect(test.state.executed).toBe(0);
    expect(test.reports.at(-1)?.status).toBe('failed');
    expect(test.reports.at(-1)?.error).toContain('check updates again');
  });
  it('replays a durable application outcome and releases its fence before claiming more work', async () => {
    const test = fixture();
    test.driver.pendingFinalization = async () => ({ operationId: 'pop_finished', report: { status: 'succeeded' } });
    test.driver.finalize = async id => { expect(id).toBe('pop_finished'); expect(test.state.released).toBe(1); test.state.events.push('finalize'); };
    await test.worker.tick();
    expect(test.reports[0]?.status).toBe('succeeded');
    expect(test.state.events.indexOf('finalize')).toBeLessThan(test.state.events.indexOf('heartbeat'));
  });
  it('delegates application manifest compatibility checks to the application driver', async () => {
    const test = fixture();
    let validated = false;
    test.driver.validateRelease = async manifest => { expect((manifest as { version: string }).version).toBe('1.0.1'); validated = true; };
    await test.worker.tick();
    expect(validated).toBe(true);
  });
  it('validates an application manifest inside a custom latest wrapper', async () => {
    const test = fixture();
    const manifest = { version: '1.0.1', ref: '2'.repeat(40), application: { format: 1 } };
    fetchSpy!.mockImplementation(async () => Response.json({ latest: manifest }));
    let validated = false;
    test.driver.validateRelease = async value => { expect(value).toEqual(manifest); validated = true; };
    await test.worker.tick();
    expect(validated).toBe(true);
  });
  it("reconciles a durable local-profile result before retrying a claim after API recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "remi-worker-receipt-"));
    try {
      const test = fixture();
      let offline = true;
      test.client.reconcile = async receipts => {
        if (offline) throw new Error("receipt API unavailable");
        expect(receipts[0]?.report.status).toBe("succeeded");
        test.state.claim = null;
      };
      const driver = { ...test.driver, kind: "local_profile" as const };
      test.state.claim = { ...test.operation, kind: "update", driver: "local_profile", targetManifest: { version: "1.0.1" } };
      const worker = new PlatformUpdateWorker(test.client, driver, null, 0, new LocalProfileOperationOutbox(root));
      await expect(worker.tick()).rejects.toThrow("receipt API unavailable");
      expect(test.state.executed).toBe(1);
      expect(test.state.released).toBe(0);
      offline = false;
      await worker.tick();
      expect(test.state.executed).toBe(1);
      expect(test.reports).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("recovers the host before contacting an API that may be down after the switch", async () => {
    const test = fixture();
    test.state.apiOffline = true;
    await expect(test.worker.tick()).rejects.toThrow("API unavailable");
    expect(test.state.events).toEqual(["recover", "heartbeat"]);
  });
  it("uses a saved source immediately and resets to the host default without restarting the updater", async () => {
    const test = fixture();
    await test.worker.tick();
    test.state.source = "https://custom.example/release.json";
    await test.worker.tick();
    test.state.source = null;
    await test.worker.tick();
    expect(test.urls).toEqual(["https://default.example/release.json", "https://custom.example/release.json", "https://default.example/release.json"]);
    expect(test.inspections.filter((item) => item.preflight).map((item) => item.releaseFeedUrl)).toEqual([null, "https://custom.example/release.json", null]);
  });

  it("still claims recovery work when the release feed is unavailable", async () => {
    const test = fixture();
    fetchSpy!.mockImplementation(async () => { throw new Error("feed offline"); });
    test.state.claim = { ...test.operation, kind: "update", status: "verifying" };
    await test.worker.tick();
    expect(test.state.executed).toBe(1);
    expect(test.inspections.find((item) => item.preflight)?.preflight?.ready).toBe(false);
    expect(test.reports.at(-1)?.status).toBe("succeeded");
  });

  it("leaves a verified result pending if terminal reporting fails instead of claiming deployment failure", async () => {
    const test = fixture();
    test.state.claim = test.operation;
    test.state.failReport = true;
    await expect(test.worker.tick()).rejects.toThrow("API unavailable");
    expect(test.reports.map((item) => item.status)).toEqual(["succeeded"]);
    expect(test.state.released).toBe(0);
  });

  it("keeps maintenance pinned when the driver cannot verify recovery", async () => {
    const test = fixture();
    test.state.claim = { ...test.operation, status: "verifying" };
    test.state.recover = true;
    await test.worker.tick();
    expect(test.reports.map((item) => item.status)).toEqual(["verifying"]);
    expect(test.reports[0]?.progress?.recoveryRequired).toBe(true);
    expect(test.state.released).toBe(0);
  });

  it("does not finish or release an operation owned by a different deployment driver", async () => {
    const test = fixture();
    test.state.claim = { ...test.operation, status: "switching", driver: "systemd_release" };
    await expect(test.worker.tick()).rejects.toThrow("left untouched");
    expect(test.state.executed).toBe(0);
    expect(test.reports).toEqual([]);
    expect(test.state.released).toBe(0);
  });
});
