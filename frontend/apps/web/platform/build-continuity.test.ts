import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createChatStore, registerChatStore } from "@multiremi/core/chat";
import { useContinuityStore } from "@multiremi/core/platform-lifecycle";
import { canRefresh, checkBuild, recoverChunk, CURRENT_BUILD } from "./build-continuity";
beforeEach(() => {
  const memory = new Map<string, string>();
  registerChatStore(createChatStore({ storage: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); }, removeItem: k => { memory.delete(k); } } }));
  useContinuityStore.setState({ pendingWrites: 0, heldSends: 0 }); sessionStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("web build continuity", () => {
  it("leaves development updates to HMR without compiling the build route", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await checkBuild()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks the Web-owned no-store identity, tolerating missing and malformed responses", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ build_id: "different" }))
      .mockResolvedValueOnce(Response.json({ build_id: 3 })).mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetch);
    expect(await checkBuild()).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/health/build", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
    expect(await checkBuild()).toBe(false); expect(await checkBuild()).toBe(false);
  });
  it("never reloads unconfirmed writes or drafts", () => {
    expect(canRefresh()).toBe(true);
    useContinuityStore.setState({ heldSends: 1 }); expect(canRefresh()).toBe(false);
    useContinuityStore.setState({ heldSends: 0, pendingWrites: 1 }); expect(canRefresh()).toBe(false);
    expect(recoverChunk(new Error("ChunkLoadError"))).toBe(false);
  });
  it("recovers at most once per tab/build and ignores unrelated errors", () => {
    const reload = vi.fn(); vi.stubGlobal("window", { location: { reload } });
    expect(recoverChunk(new Error("ordinary"))).toBe(false);
    expect(recoverChunk(new Error("ChunkLoadError"))).toBe(true);
    expect(sessionStorage.getItem(`remi:chunk-recovery:${CURRENT_BUILD}`)).toBe("1");
    expect(recoverChunk(new Error("ChunkLoadError"))).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });
});
