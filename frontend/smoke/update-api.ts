/** Child API process for update-continuity.ts; all state is disposable. */
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { openSqliteDatabase } from "../../packages/server/src/store/db/sqlite.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { startMultiremiServer } from "../../packages/server/src/api.js";
const root = process.argv[2]!;
for (const key of Object.keys(process.env)) if (/^(MULTIREMI_|REMI_|FEISHU_)/.test(key)) delete process.env[key];
process.env.NODE_ENV = "test";
process.env.MULTIREMI_STATE_DIR = join(root, "state");
process.env.MULTIREMI_UPLOAD_DIR = join(root, "uploads");
process.env.MULTIREMI_SESSION_ARCHIVE_ROOT = join(root, "archives");
const db = openSqliteDatabase(join(root, "smoke.sqlite"));
const store = new MultiremiStore(db);
const configPath = join(root, "fixture.json");
let fixture: { token: string; slug: string; sessionId: string; port: number };
try { fixture = JSON.parse(readFileSync(configPath, "utf8")); }
catch {
  store.ensureLocalWorkspace();
  const owner = store.getOrCreateUser({ name: "Update smoke", email: "update@example.test" });
  const workspace = store.createWorkspace({ name: "Update smoke", slug: "update-smoke" }, owner.id);
  store.ensureWorkspaceOperator(workspace.id);
  const agent = store.createAgent({ workspaceId: workspace.id, ownerId: owner.id, name: "Smoke Agent", provider: "codex" });
  const chat = store.createChatSession({ workspaceId: workspace.id, agentId: agent.id, creatorId: owner.id, title: "Update continuity" });
  const { token } = await store.createAccessToken({ workspaceId: workspace.id, userId: owner.id, name: "Isolated browser", type: "pat" });
  fixture = { token, slug: workspace.slug, sessionId: chat.id, port: Number(process.argv[3] ?? 14341) };
}
const server = startMultiremiServer({ store, authToken: randomUUID(), hostname: "127.0.0.1", port: fixture.port, backgroundJobs: false, scheduler: null, scmPolling: null, messaging: null, controlPlaneSshMesh: null });
fixture.port = server.port;
writeFileSync(configPath, JSON.stringify(fixture), { mode: 0o600 });
console.log("SMOKE_READY");
createInterface({ input: process.stdin }).on("line", line => {
  if (line === "gate") {
    const operation = store.createPlatformOperation({ kind: "update" }, "smoke");
    store.beginPlatformDrain({ operationId: operation.id });
    store.reportPlatformOperation(operation.id, { status: "switching" });
    console.log("SMOKE_GATED");
  } else if (line === "release") {
    const operation = store.getActivePlatformOperation();
    if (operation) { store.reportPlatformOperation(operation.id, { status: "succeeded" }); store.releasePlatformDrain(operation.id); }
    console.log("SMOKE_RELEASED");
  }
});
