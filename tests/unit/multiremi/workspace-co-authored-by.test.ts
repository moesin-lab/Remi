import { afterEach, describe, expect, it } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp } from "@multiremi/api/server.js";
import { DEFAULT_CO_AUTHORED_BY, resolveCoAuthoredByIdentity } from "@multiremi/contracts/co-authored-by";

const handles: ReturnType<typeof openSqliteDatabase>[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); });
function fixture() {
  const db = openSqliteDatabase(":memory:"); handles.push(db);
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const app = createMultiremiApp({ store, authToken: "test-master" });
  const request = (method: string, body?: unknown, path = "/api/workspaces/local") => app.request(path, {
    method, headers: { Authorization: "Bearer test-master", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { store, request };
}
describe("workspace co-author API", () => {
  it.each(["PATCH", "PUT"])("%s persists trimmed settings and null removes existing identity", async method => {
    const { store, request } = fixture();
    const response = await request(method, { settings: { co_authored_by_name: " Custom ", co_authored_by_email: " custom@example.test ", retained: true } });
    expect(response.status).toBe(200);
    expect(store.getWorkspace("local")!.settings).toMatchObject({ co_authored_by_name: "Custom", co_authored_by_email: "custom@example.test", retained: true });
    const reset = await request(method, { settings: { ...store.getWorkspace("local")!.settings, co_authored_by_name: null, co_authored_by_email: null } });
    expect(reset.status).toBe(200);
    const read = await request("GET");
    expect(read.status).toBe(200);
    const { settings } = await read.json();
    expect(settings).toEqual({ retained: true });
    expect(resolveCoAuthoredByIdentity(settings)).toEqual(DEFAULT_CO_AUTHORED_BY);
    expect(store.getWorkspace("local")!.settings).toEqual(settings);
  });
  it.each(["PATCH", "PUT", "POST"])("%s rejects invalid identity atomically", async method => {
    const { store, request } = fixture();
    for (const [field, values] of Object.entries({ co_authored_by_name: [false, 42, {}, "", "Bad\nName", "Bad\tName", "<Bad>", "x".repeat(101)], co_authored_by_email: [[], 42, "", "invalid", "a@localhost", "a b@example.test", "a\n@example.test", "<a@example.test>", "a".repeat(255)] })) {
      for (const value of values) {
        const before = store.getWorkspace("local");
        const response = await request(method, { name: "Must not persist", slug: "must-not-persist", settings: { co_authored_by_name: "Valid", [field]: value } }, method === "POST" ? "/api/workspaces" : undefined);
        expect(response.status).toBe(400);
        expect((await response.json()).error).toStartWith(`${field}:`);
        expect(store.getWorkspace("local")).toEqual(before);
        expect(store.listWorkspaces()).toHaveLength(1);
      }
    }
  });
  it("POST normalizes strings and omits null fields", async () => {
    const { store, request } = fixture();
    const response = await request("POST", { name: "Created", slug: "created", settings: { co_authored_by_name: " Custom ", co_authored_by_email: null } }, "/api/workspaces");
    expect(response.status).toBe(201);
    const workspace = await response.json();
    expect(store.getWorkspace(workspace.id)!.settings).toEqual({ co_authored_by_name: "Custom" });
  });
});
