import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "../client";
import { ApiContractError } from "../schema";

afterEach(() => vi.unstubAllGlobals());

it("distinguishes an empty linked Session list from a malformed response", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json({ unexpected: true })));
  const client = new ApiClient("https://api.example.test");
  await expect(client.listIssueSessions("issue-1")).resolves.toEqual([]);
  await expect(client.listIssueSessions("issue-1")).rejects.toBeInstanceOf(ApiContractError);
});
