// Invoked only inside the isolated Docker test network by the opt-in test.
import assert from "node:assert/strict";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { PlatformOperationsRepo } from "@multiremi/store/repos/platform-operations-repo.js";
import { PlatformMaintenanceRepo } from "@multiremi/store/repos/platform-maintenance-repo.js";

const db = new PostgresSyncDatabase("postgresql://multiremi@127.0.0.1:5432/multiremi");
try {
  const operations = new PlatformOperationsRepo(db);
  const maintenance = new PlatformMaintenanceRepo(db);
  const resurrected = operations.get("pop_current")!;
  assert.equal(resurrected.status, "rolling_back");
  assert.equal(maintenance.get().expiresAt, "9999-12-31T23:59:59.999Z");
  const completedAt = "2026-09-30T12:00:00.000Z";
  const receipt = { operation: resurrected, report: { status: "rolled_back" as const }, completedAt };
  operations.reconcile([receipt]);
  operations.reconcile([receipt]);
  assert.equal(operations.active(), null);
  assert.equal(maintenance.get().mode, "normal");
  assert.equal(operations.get(resurrected.id)?.finishedAt, completedAt);

  const current = operations.create({ kind: "update", targetVersion: "9.0.0" }, "local");
  maintenance.beginDrain({ operationId: current.id });
  const lost = { ...resurrected, id: "pop_lost", requestId: "lost-receipt" };
  const invalid = { ...current, targetVersion: "wrong-identity" };
  assert.throws(() => operations.reconcile([
    { operation: lost, report: { status: "rolled_back" }, completedAt },
    { operation: invalid, report: { status: "failed" }, completedAt: new Date(Date.now() + 1000).toISOString() },
  ]), /identity/);
  assert.equal(operations.get(lost.id), null, "PostgreSQL must roll back earlier inserts in the same receipt batch");
  assert.equal(operations.active()?.id, current.id);
  assert.equal(maintenance.get().operationId, current.id);

  operations.reconcile([{ operation: lost, report: { status: "rolled_back" }, completedAt }]);
  assert.equal(operations.get(lost.id)?.status, "rolled_back");
  assert.equal(operations.active()?.id, current.id);
  assert.equal(maintenance.get().operationId, current.id);
  console.log("PASS PostgreSQL reconciliation: replay, lost row restore, transaction rollback, unrelated gate preserved");
} finally {
  db.close();
}
