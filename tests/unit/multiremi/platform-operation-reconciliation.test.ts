import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiPlatformOperation } from "@multiremi/contracts";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const headers = {
  Authorization: "Bearer master-secret",
  "X-Multiremi-Updater-Token": "updater-secret",
  "Content-Type": "application/json",
};

function fixture() {
  const store = createLocalStore();
  const app = createMultiremiApp({ store, authToken: "master-secret", platformUpdaterToken: "updater-secret" });
  return {
    store,
    post(receipts: unknown, auth = headers) {
      return app.request("/api/platform-updater/operations/reconcile", {
        method: "POST", headers: auth, body: JSON.stringify({ receipts }),
      });
    },
  };
}

function receipt(operation: MultiremiPlatformOperation, status = "rolled_back") {
  return { operation, report: { status, progress: { message: "Both services restored" } }, completedAt: new Date(Date.now() + 1_000).toISOString() };
}

describe("host operation reconciliation", () => {
  it("restores a rollback operation erased by database restore without disturbing a new active operation", async () => {
    const { store, post } = fixture();
    const lost = store.createPlatformOperation({ kind: "rollback", requestId: "restore-1", targetRef: "a".repeat(40) }, "local");
    const claimed = store.claimPlatformOperation()!;
    db!.run("DELETE FROM multiremi_platform_operations WHERE id = ?", [lost.id]);
    const newer = store.createPlatformOperation({ kind: "update", targetVersion: "2.0.0" }, "local");
    store.beginPlatformDrain({ operationId: newer.id });
    const completed = receipt(claimed);

    let response = await post([completed]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reconciled: [lost.id] });
    expect(store.getPlatformOperation(lost.id)).toMatchObject({
      id: lost.id, requestId: lost.requestId, requestedBy: "local", createdAt: lost.createdAt,
      startedAt: claimed.startedAt, finishedAt: completed.completedAt, status: "rolled_back",
    });
    expect(store.getActivePlatformOperation()?.id).toBe(newer.id);
    expect(store.getPlatformMaintenance()).toMatchObject({ mode: "draining", operationId: newer.id });

    response = await post([completed]);
    expect(response.status).toBe(200);
    expect(store.listPlatformOperations()).toHaveLength(2);
    expect(store.getPlatformOperation(lost.id)?.finishedAt).toBe(completed.completedAt);
  });

  it("replays an acknowledged receipt after a later restore resurrects its switching row", async () => {
    const { store, post } = fixture();
    store.createPlatformOperation({ kind: "update", targetVersion: "1.0.0" }, "local");
    const claimed = store.claimPlatformOperation()!;
    store.beginPlatformDrain({ operationId: claimed.id });
    store.reportPlatformOperation(claimed.id, { status: "switching" });
    const completed = receipt(claimed);
    expect((await post([completed])).status).toBe(200);
    expect(store.getActivePlatformOperation()).toBeNull();
    expect(store.getPlatformMaintenance().mode).toBe("normal");

    // An older pre-switch backup brings the operation and maintenance back.
    db!.run("UPDATE multiremi_platform_operations SET status = 'switching', active_slot = 1, finished_at = NULL WHERE id = ?", [claimed.id]);
    store.beginPlatformDrain({ operationId: claimed.id });
    expect((await post([completed])).status).toBe(200);
    expect(store.getPlatformOperation(claimed.id)?.status).toBe("rolled_back");
    expect(store.getActivePlatformOperation()).toBeNull();
    expect(store.getPlatformMaintenance().mode).toBe("normal");
  });

  it("rejects mismatched identities atomically and never cancels an unrelated active operation", async () => {
    const { store, post } = fixture();
    const operation = store.createPlatformOperation({ kind: "update", requestId: "original", targetVersion: "1.0.0" }, "local");
    store.beginPlatformDrain({ operationId: operation.id });
    const missing = { ...operation, id: "pop_lost", requestId: "lost" };
    const conflict = { ...operation, targetVersion: "9.0.0" };
    const response = await post([receipt(missing), receipt(conflict)]);
    expect(response.status).toBe(409);
    expect(store.getPlatformOperation(missing.id)).toBeNull();
    expect(store.getActivePlatformOperation()?.id).toBe(operation.id);
    expect(store.getPlatformMaintenance().mode).toBe("draining");

    const keyCollision = await post([receipt({ ...operation, id: "pop_duplicate" })]);
    expect(keyCollision.status).toBe(409);
    expect(store.listPlatformOperations()).toHaveLength(1);
  });

  it("fails closed when a receipt conflicts with an existing terminal result", async () => {
    const { store, post } = fixture();
    const operation = store.createPlatformOperation({ kind: "update", targetVersion: "1.0.0" }, "local");
    store.reportPlatformOperation(operation.id, { status: "succeeded" });
    expect((await post([receipt(operation)])).status).toBe(409);
    expect(store.getPlatformOperation(operation.id)?.status).toBe("succeeded");
  });

  it("records an automatic update outcome without letting historical replay overwrite the latest scheduler result", async () => {
    const { store, post } = fixture();
    const operation = store.createPlatformOperation({ kind: "update", targetVersion: "1.0.0" }, "system:auto-update");
    const completed = receipt(operation, "succeeded");
    expect((await post([completed])).status).toBe(200);
    expect(store.getPlatformState().autoUpdateLastResult).toBe("updated");
    store.setPlatformAutoUpdateResult("no_update");
    expect((await post([completed])).status).toBe(200);
    expect(store.getPlatformState().autoUpdateLastResult).toBe("no_update");
  });

  it("refuses to acknowledge the same terminal status for a different release while preserving identical replays", async () => {
    const { store, post } = fixture();
    const operation = store.createPlatformOperation({ kind: "update", targetVersion: "1.0.0" }, "local");
    const resultRelease = {
      version: "1.0.0", ref: "a".repeat(40), publishedAt: null, releaseUrl: null, manifestUrl: null,
      apiImage: "api@sha256:aaa", webImage: "web@sha256:bbb",
    };
    const completed = { ...receipt(operation, "succeeded"), report: { status: "succeeded", resultRelease } };
    expect((await post([completed])).status).toBe(200);
    expect((await post([completed])).status).toBe(200);
    const conflicting = { ...completed, report: { ...completed.report, resultRelease: { ...resultRelease, ref: "b".repeat(40) } } };
    expect((await post([conflicting])).status).toBe(409);
    expect((await post([receipt(operation, "succeeded")])).status).toBe(409);
    expect(store.getPlatformOperation(operation.id)?.resultRelease?.ref).toBe(resultRelease.ref);
    expect(store.getPlatformOperation(operation.id)?.finishedAt).toBe(completed.completedAt);
  });

  it("requires both updater credentials and accepts only bounded terminal update or rollback receipts", async () => {
    const { store, post } = fixture();
    const operation = store.createPlatformOperation({ kind: "update", targetVersion: "1.0.0" }, "local");
    expect((await post([receipt(operation)], { ...headers, "X-Multiremi-Updater-Token": "" })).status).toBe(401);
    expect((await post([receipt(operation)], { ...headers, Authorization: "" })).status).toBe(401);
    for (const invalid of [null, {}, [null], [receipt(operation, "switching")], [receipt({ ...operation, kind: "restart" })], Array(101).fill(receipt(operation))]) {
      expect((await post(invalid)).status).toBe(400);
    }
    expect(store.getActivePlatformOperation()?.id).toBe(operation.id);
  });
});
