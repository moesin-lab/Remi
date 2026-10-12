import { afterEach, describe, expect, it } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp } from "@multiremi/api/server.js";

const handles: ReturnType<typeof openSqliteDatabase>[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); });

async function fixture() {
  const db = openSqliteDatabase(":memory:"); handles.push(db);
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const accounts = ["first", "second"].map(name => store.getOrCreateUser({ name, email: `${name}@example.test` }));
  const headers = await Promise.all(accounts.map(async account => ({
    Authorization: `Bearer ${(await store.createAccessToken({ type: "pat", purpose: "session", name: "Shared operator test", workspaceId: "local", userId: account.id })).token}`,
    "Content-Type": "application/json",
  })));
  return { db, store, headers, app: createMultiremiApp({ store, authToken: "test-master" }) };
}

describe("workspace operator preferences", () => {
  it("shares legacy pins without duplicating targets or accepting identity partitions", async () => {
    const { db, store, headers, app } = await fixture();
    const project = store.createProject({ workspaceId: "local", title: "Shared project" });
    const second = store.createProject({ workspaceId: "local", title: "Another project" });
    const otherWorkspace = store.createWorkspace({ name: "Separate data", slug: "separate-data" });
    const foreign = store.createProject({ workspaceId: otherWorkspace.id, title: "Foreign project" });
    const seed = (id: string, owner: string, workspaceId: string, target: string, position: number) => db.run(
      "INSERT INTO multiremi_pinned_items (id, workspace_id, user_id, item_type, item_id, position, created_at) VALUES (?, ?, ?, 'project', ?, ?, ?)",
      [id, workspaceId, owner, target, position, "2026-01-01T00:00:00Z"],
    );
    seed("old-first", "first-account", "local", project.id, 1);
    seed("old-duplicate", "second-account", "local", project.id, 2);
    seed("old-second", "second-account", "local", second.id, 3);
    seed("foreign", "first-account", otherWorkspace.id, foreign.id, 1);
    for (const auth of headers) {
      const response = await app.request("/api/pins?workspace_id=local&user_id=ignored", { headers: auth });
      expect(response.status).toBe(200);
      expect((await response.json()).map((pin: any) => [pin.item_id, pin.user_id])).toEqual([[project.id, "local"], [second.id, "local"]]);
    }
    // Reading preserves all provenance rows, including duplicates.
    expect(db.query("SELECT COUNT(*) AS n FROM multiremi_pinned_items").get()).toMatchObject({ n: 4 });
    const reordered = await app.request("/api/pins/reorder", {
      method: "PUT", headers: headers[1], body: JSON.stringify({ workspace_id: "local", user_id: "ignored", items: [{ id: "old-first", position: 5 }, { id: "foreign", position: 99 }] }),
    });
    expect(reordered.status).toBe(200);
    expect((await reordered.json()).map((pin: any) => pin.item_id)).toEqual([second.id, project.id]);
    expect(store.getPinnedItem("old-duplicate")?.position).toBe(5);
    expect(store.getPinnedItem("foreign")?.position).toBe(1);
    const removed = await app.request(`/api/pins/project/${project.id}?workspace_id=local`, { method: "DELETE", headers: headers[0] });
    expect(removed.status).toBe(204);
    expect(store.listPinnedItems("local").map(pin => pin.itemId)).toEqual([second.id]);
    expect(store.getPinnedItem("foreign")).not.toBeNull();
  });

  it("keeps historical settings and shares a saved preference across login accounts", async () => {
    const { db, store, headers, app } = await fixture();
    db.run("INSERT INTO multiremi_notification_preferences (workspace_id, member_id, preferences, updated_at) VALUES (?, ?, ?, ?)",
      ["local", "old-member", JSON.stringify({ comments: "muted" }), "2026-01-01T00:00:00Z"]);
    const before = await app.request("/api/notification-preferences?workspace_id=local", { headers: headers[0] });
    expect((await before.json()).preferences).toEqual({ comments: "muted" });
    const save = await app.request("/api/notification-preferences", {
      method: "PUT", headers: headers[1], body: JSON.stringify({ workspace_id: "local", member_id: "another-member", preferences: { comments: "all", assignments: "muted" } }),
    });
    expect(save.status).toBe(200);
    expect((await save.json()).memberId).toBe(store.getWorkspaceOperator("local")?.id);
    const after = await app.request("/api/notification-preferences?workspace_id=local&member_id=old-member", { headers: headers[0] });
    expect((await after.json()).preferences).toEqual({ comments: "all", assignments: "muted" });
    expect(db.query("SELECT preferences FROM multiremi_notification_preferences WHERE member_id = 'old-member'").get()).toMatchObject({ preferences: JSON.stringify({ comments: "muted" }) });
    expect(db.query("SELECT COUNT(*) AS n FROM multiremi_notification_preferences WHERE member_id = 'another-member'").get()).toMatchObject({ n: 0 });
  });
});
