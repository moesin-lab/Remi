import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { memberRemovedPayload } from "@multiremi/api/wire/workspaces.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("workspace member response identity", () => {
  it("matches a password owner's member identity to /api/me for permission checks", async () => {
    const store = createStore();
    const email = "member-identity@example.test";
    const password = `test-only-${crypto.randomUUID()}`;
    const { user } = await store.configurePasswordAccount({ email, password });
    const session = await store.loginWithPassword(email, password);
    const app = createMultiremiApp({ store, authToken: "test-member-identity-master" });
    const headers = { Authorization: `Bearer ${session!.token}` };
    const storedMember = store.findWorkspaceMemberForUser(user.id, "local")!;
    expect(storedMember.id).not.toBe(`mem_local_${user.id}`);

    const meResponse = await app.request("/api/me", { headers });
    expect(meResponse.status).toBe(200);
    const me = await meResponse.json();
    expect(me.id).toBe(user.id);
    const membersResponse = await app.request("/api/workspaces/local/members", { headers });
    expect(membersResponse.status).toBe(200);
    const members = await membersResponse.json() as Array<{ id: string; user_id: string; role: string }>;
    expect(members.find((member) => member.user_id === me.id)).toMatchObject({
      id: storedMember.id,
      user_id: user.id,
      role: "owner",
    });
    expect(memberRemovedPayload(storedMember)).toMatchObject({
      member_id: storedMember.id,
      user_id: user.id,
    });
  });

  it("prefers an explicit user link while preserving legacy member identities", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const explicit = store.createWorkspaceMember({
      id: "mem_local_usr_old",
      userId: "usr_current",
      name: "Explicit identity",
    });
    const legacy = store.createWorkspaceMember({ id: "mem_local_usr_legacy", name: "Legacy identity" });
    const unlinked = store.createWorkspaceMember({ id: "mem_unlinked", name: "Unlinked member" });
    const app = createMultiremiApp({ store });
    const response = await app.request("/api/workspaces/local/members");
    expect(response.status).toBe(200);
    const members = await response.json() as Array<{ id: string; user_id: string }>;
    const identities = new Map(members.map((member) => [member.id, member.user_id]));
    expect(identities.get(explicit.id)).toBe("usr_current");
    expect(identities.get(legacy.id)).toBe("usr_legacy");
    expect(identities.get(unlinked.id)).toBe(unlinked.id);
    expect(identities.get("mem_local_local")).toBe("local");
    expect(memberRemovedPayload(legacy)).toMatchObject({ user_id: "usr_legacy" });
  });
});
