import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MultiremiPlatformOperation } from "@multiremi/contracts";
import { LocalProfileOperationOutbox, type PlatformOperationReceipt } from "@remi-platform/updater/operation-outbox.js";
import { PlatformUpdaterClient } from "@remi-platform/updater/client.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remi-host-outbox-")); roots.push(root);
  const operation: MultiremiPlatformOperation = {
    id: "pop_recovery", kind: "update", status: "preparing", driver: "local_profile",
    targetVersion: "0.2.84", targetRef: "https://example.test/release.json", targetManifest: {},
    progress: {}, requestedBy: "local", output: null, error: null, previousRelease: null,
    resultRelease: null, cancelRequested: false, createdAt: "2026-09-30T12:00:00.000Z",
    updatedAt: "2026-09-30T12:00:00.000Z", startedAt: "2026-09-30T12:00:00.000Z", finishedAt: null,
  };
  const release = { version: "0.2.84", ref: "a".repeat(40), publishedAt: null, releaseUrl: null,
    manifestUrl: null, apiImage: "api:target", webImage: "web:target" };
  const journal = (data: object) => {
    const directory = join(root, "host-operations", operation.id); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "operation.json"), JSON.stringify({ updatedAt: "2026-09-30T12:05:00.000Z", ...data }));
  };
  return { root, operation, release, journal, outbox: new LocalProfileOperationOutbox(root) };
}

describe("durable API/Web host outcomes", () => {
  it("recovers a completed switch after the process dies before its API report", async () => {
    const f = fixture(); await f.outbox.remember(f.operation);
    f.journal({ status: "succeeded", phase: "succeeded", resultRelease: f.release });
    const received: PlatformOperationReceipt[][] = [];
    const restarted = new LocalProfileOperationOutbox(f.root);
    await restarted.reconcile({ async reconcile(receipts) { received.push(receipts); } });
    expect(received[0]![0]!.operation.targetManifest).toEqual({});
    expect(received[0]![0]!.report.status).toBe("succeeded");
    expect(received[0]![0]!.report.resultRelease).toEqual(f.release);
    expect(received[0]![0]!.completedAt).toBe("2026-09-30T12:05:00.000Z");
    // A second DB restore may erase the earlier ACK. Re-send the same receipt.
    await restarted.reconcile({ async reconcile(receipts) { received.push(receipts); } });
    expect(received[1]).toEqual(received[0]);
  });

  it("persists automatic rollback as rolled_back rather than a generic failure", async () => {
    const f = fixture(); await f.outbox.remember(f.operation);
    f.journal({ status: "rolled_back", phase: "rolled_back", resultRelease: f.release, error: "Web unhealthy" });
    const receipt = await f.outbox.complete(f.operation.id, { status: "failed", error: "command failed" });
    expect(receipt.report).toMatchObject({ status: "rolled_back", resultRelease: f.release, error: "Web unhealthy" });
  });

  it("keeps the maintenance gate held while data recovery remains incomplete", async () => {
    const f = fixture(); await f.outbox.remember(f.operation);
    f.journal({ status: "recovery_required", phase: "rolling_back" });
    await expect(f.outbox.complete(f.operation.id, { status: "failed" })).rejects.toThrow("recovery is incomplete");
    const entry = JSON.parse(readFileSync(join(f.root, "host-operation-receipts", `${f.operation.id}.json`), "utf8"));
    expect(entry.receipt).toBeNull();
  });

  it("survives API downtime without rewriting a successful deployment outcome", async () => {
    const f = fixture(); await f.outbox.remember(f.operation);
    f.journal({ status: "succeeded", phase: "succeeded", resultRelease: f.release });
    await f.outbox.complete(f.operation.id, { status: "succeeded", resultRelease: f.release });
    await expect(f.outbox.reconcile({ async reconcile() { throw new Error("API offline"); } })).rejects.toThrow("offline");
    const restarted = new LocalProfileOperationOutbox(f.root);
    const received: PlatformOperationReceipt[] = [];
    await restarted.reconcile({ async reconcile(receipts) { received.push(...receipts); } });
    expect(received[0]!.report.status).toBe("succeeded");
    expect((await restarted.complete(f.operation.id, { status: "failed" })).report.status).toBe("succeeded");
  });

  it("fails closed on corrupt state or missing release evidence", async () => {
    const f = fixture(); await f.outbox.remember(f.operation);
    f.journal({ status: "succeeded" });
    await expect(f.outbox.reconcile({ async reconcile() {} })).rejects.toThrow("no verified release");
    writeFileSync(join(f.root, "host-operation-receipts", `${f.operation.id}.json`), "{");
    await expect(f.outbox.reconcile({ async reconcile() {} })).rejects.toThrow();
  });

  it("keeps the external fence until API acknowledgement and retries finalization after a crash", async () => {
    const f = fixture(); await f.outbox.remember(f.operation);
    f.journal({ status: "succeeded", phase: "succeeded", resultRelease: f.release });
    mkdirSync(join(f.root, "host-control"));
    writeFileSync(join(f.root, "host-control", "write-fence.json"), JSON.stringify({ operationId: f.operation.id }));
    const finalized: string[] = [];
    await expect(f.outbox.reconcile({ async reconcile() { throw new Error("offline"); } }, async id => { finalized.push(id); })).rejects.toThrow("offline");
    expect(finalized).toEqual([]);
    const restarted = new LocalProfileOperationOutbox(f.root);
    await restarted.reconcile({ async reconcile() {} }, async id => { finalized.push(id); });
    expect(finalized).toEqual([f.operation.id]);
    // An old acknowledged receipt must never clear a new operation's fence.
    writeFileSync(join(f.root, "host-control", "write-fence.json"), JSON.stringify({ operationId: "pop_new" }));
    await restarted.reconcile({ async reconcile() {} }, async id => { finalized.push(id); });
    expect(finalized).toEqual([f.operation.id]);
  });

  it("uses the authenticated host protocol and supports an older restored API", async () => {
    const f = fixture(); await f.outbox.remember(f.operation);
    const receipt = await f.outbox.complete(f.operation.id, { status: "failed", error: "staging failed" });
    let legacy = false; let conflict = false; const requests: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      expect(req.headers.get("Authorization")).toBe("Bearer test-api");
      expect(req.headers.get("X-Multiremi-Updater-Token")).toBe("test-updater");
      const path = new URL(req.url).pathname; requests.push(path);
      if (path.endsWith("/reconcile")) return legacy ? new Response(null, { status: 404 })
        : Response.json({ reconciled: [f.operation.id] });
      return Response.json({ operation: { id: f.operation.id, status: conflict ? "succeeded" : "failed" } });
    } });
    try {
      const client = new PlatformUpdaterClient(`http://127.0.0.1:${server.port}`, "test-api", "test-updater");
      await client.reconcile([receipt]); legacy = true; await client.reconcile([receipt]);
      expect(requests).toEqual(["/api/platform-updater/operations/reconcile", "/api/platform-updater/operations/reconcile",
        `/api/platform-updater/operations/${f.operation.id}/report`]);
      conflict = true;
      await expect(client.reconcile([receipt])).rejects.toThrow("conflicting");
    } finally { server.stop(true); }
  });
});
