import { afterEach, describe, expect, it } from "bun:test";
import { buildImportedSkillInput, SkillImportError } from "@daemon/agent-runtime/skills/skill-import.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, mockFetch, resetMultiremiTestEnv } from "./helpers.js";

import { request as httpRequest } from "node:http";
const source = "https://github.com/example/skills";
const repo = "https://api.github.com/repos/example/skills";
const raw = "https://raw.githubusercontent.com/example/skills/main";
const contents = `${repo}/contents?ref=main`;
const options = { requestTimeoutMs: 40, totalTimeoutMs: 1_000 };
afterEach(resetMultiremiTestEnv);

function bundle(url: string): Response {
  if (url === repo) return Response.json({ default_branch: "main" });
  if (url === `${raw}/SKILL.md`) return new Response("---\nname: demo\n---\nNew content");
  if (url === contents) return Response.json([
    { name: "first.md", path: "first.md", type: "file", download_url: `${raw}/first.md` },
    { name: "last.md", path: "last.md", type: "file", download_url: `${raw}/last.md` },
  ]);
  if (url === `${raw}/first.md` || url === `${raw}/last.md`) return new Response("New file");
  throw new Error(`Unexpected fetch ${url}`);
}

async function failure(run: Promise<unknown>, status: number, ...details: string[]) {
  try {
    await run;
    throw new Error("Expected import failure");
  } catch (error) {
    expect(error).toBeInstanceOf(SkillImportError);
    expect((error as SkillImportError).status).toBe(status);
    for (const detail of details) expect((error as Error).message).toContain(detail);
  }
}

describe("skill import deadlines and cancellation (mock upstream)", () => {
  for (const [url, target, operation] of [
    [source, repo, "resolve ref"],
    [source, contents, "list contents"],
    [source, `${raw}/last.md`, "download /example/skills/main/last.md"],
    ["https://skills.sh/example/skills/demo", repo, "resolve ref"],
    ["https://clawhub.ai/demo", "https://clawhub.ai/api/v1/skills/demo", "resolve skill metadata"],
  ]) {
    for (const phase of ["connect", "read body"]) {
      it(`bounds ${operation} ${phase} for ${url}`, async () => {
        let signal: AbortSignal | undefined;
        let cancelledBody = false;
        let seenTarget = false;
        const afterTarget: string[] = [];
        mockFetch((requested, init) => {
          if (seenTarget) afterTarget.push(requested);
          if (requested !== target) return bundle(requested);
          seenTarget = true;
          signal = init?.signal ?? undefined;
          if (phase === "connect") return new Promise<Response>(() => {});
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
            cancel() { cancelledBody = true; },
          }));
        });
        await failure(buildImportedSkillInput({ url }, options), 504,
          new URL(target).hostname, operation, phase, "40 ms");
        expect(signal?.aborted).toBe(true);
        expect(afterTarget).toEqual([]);
        if (phase === "read body") expect(cancelledBody).toBe(true);
      });
    }
  }

  it("applies one total deadline across multiple individually fast requests", async () => {
    const requested: string[] = [];
    let finalSignal: AbortSignal | undefined;
    mockFetch(async (url, init) => {
      requested.push(url);
      finalSignal = init?.signal ?? undefined;
      await new Promise((resolve) => setTimeout(resolve, 35));
      return bundle(url);
    });
    await failure(buildImportedSkillInput({ url: source }, { requestTimeoutMs: 500, totalTimeoutMs: 90 }),
      504, "total deadline", "90 ms", "api.github.com", "list contents");
    expect(requested).toEqual([repo, `${raw}/SKILL.md`, contents]);
    expect(finalSignal?.aborted).toBe(true);
  });

  it("cancels a late response from a transport that ignores abort", async () => {
    let release!: (response: Response) => void;
    let cancelled = false;
    mockFetch(() => new Promise<Response>((resolve) => { release = resolve; }));
    await failure(buildImportedSkillInput({ url: source }, options), 504, "connect");
    release(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  it("isolates the deadlines of concurrent imports", async () => {
    mockFetch((url) => url === "https://clawhub.ai/api/v1/skills/stuck" ? new Promise<Response>(() => {}) : bundle(url));
    const stuck = failure(buildImportedSkillInput({ url: "https://clawhub.ai/stuck" }, options), 504, "clawhub.ai");
    const normal = await buildImportedSkillInput({ url: source });
    expect(normal.skillInput.files).toHaveLength(2);
    await stuck;
  });

  it("does not issue requests when already cancelled", async () => {
    let count = 0;
    mockFetch(() => { count++; return bundle(repo); });
    const abort = new AbortController();
    abort.abort();
    await failure(buildImportedSkillInput({ url: source }, { signal: abort.signal }), 408, "cancelled");
    expect(count).toBe(0);
  });

  for (const route of ["/api/skills/import", "/api/multiremi/skills/import"]) {
    it(`cancels upstream work and preserves an existing skill: ${route}`, async () => {
      const store = createStore();
      const app = createMultiremiApp({ store });
      const existing = store.createSkill({ name: "demo", content: "Old content", files: [{ path: "old.md", content: "Keep" }],
        config: { origin: { type: "github", source_url: source } } });
      const before = store.getSkill(existing.id!);
      const abort = new AbortController();
      let upstreamSignal: AbortSignal | undefined;
      const requested: string[] = [];
      mockFetch((url, init) => {
        requested.push(url);
        if (url !== `${raw}/first.md`) return bundle(url);
        upstreamSignal = init?.signal ?? undefined;
        queueMicrotask(() => abort.abort());
        return new Promise<Response>(() => {});
      });
      const response = await app.request(route, { method: "POST", signal: abort.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: source }) });
      expect(response.status).toBe(408);
      expect((await response.json()).error).toContain("cancelled");
      expect(upstreamSignal?.aborted).toBe(true);
      expect(requested).not.toContain(`${raw}/last.md`);
      expect(store.getSkill(existing.id!)).toEqual(before);
    });
  }

  it("aborts upstream work when a real HTTP client disconnects", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    let started!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => { started = resolve; });
    let stopped!: () => void;
    const upstreamStopped = new Promise<void>((resolve) => { stopped = resolve; });
    const requested: string[] = [];
    mockFetch((url, init) => {
      requested.push(url);
      if (url !== contents) return bundle(url);
      init?.signal?.addEventListener("abort", () => stopped(), { once: true });
      started();
      return new Promise<Response>(() => {});
    });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) });
    const client = httpRequest(`http://127.0.0.1:${server.port}/api/skills/import`, {
      method: "POST", headers: { "Content-Type": "application/json" },
    });
    client.on("error", () => {});
    try {
      client.end(JSON.stringify({ url: source }));
      await upstreamStarted;
      client.destroy();
      await upstreamStopped;
      expect(requested).toEqual([repo, `${raw}/SKILL.md`, contents]);
      expect(store.listSkills()).toEqual([]);
    } finally {
      client.destroy();
      await server.stop(true);
    }
  }, 2_000);

  it("preserves rate-limit errors even when the error body never finishes", async () => {
    let cancelled = false;
    mockFetch(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" },
    }));
    await failure(buildImportedSkillInput({ url: source }, options), 429, "2027-01-15T08:00:00.000Z");
    expect(cancelled).toBe(true);
  });

  it("fails a ClawHub supporting-file timeout instead of silently omitting it", async () => {
    const requested: string[] = [];
    mockFetch((url) => {
      requested.push(url);
      if (url.endsWith("/skills/demo")) return Response.json({ latestVersion: { version: "1" } });
      if (url.endsWith("/versions/1")) return Response.json({ version: { files: [{ path: "SKILL.md" }, { path: "notes.md" }, { path: "last.md" }] } });
      if (url.includes("path=SKILL.md")) return new Response("# Demo");
      if (url.includes("path=notes.md")) return new Promise<Response>(() => {});
      throw new Error(`Unexpected fetch ${url}`);
    });
    await failure(buildImportedSkillInput({ url: "https://clawhub.ai/demo" }, options), 504, "clawhub.ai", "download notes.md");
    expect(requested).toHaveLength(4);
  });

  it("returns the production 10s timeout through HTTP without changing existing data", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const existing = store.createSkill({ name: "demo", content: "Old content", files: [{ path: "old.md", content: "Keep" }],
      config: { origin: { type: "github", source_url: source } } });
    const before = store.getSkill(existing.id!);
    let cancelledBody = false;
    mockFetch((url) => url === `${raw}/last.md` ? new Response(new ReadableStream({
      cancel() { cancelledBody = true; },
    })) : bundle(url));
    const response = await app.request("/api/skills/import", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: source }) });
    expect(response.status).toBe(504);
    expect((await response.json()).error).toContain("10000 ms");
    expect(cancelledBody).toBe(true);
    expect(store.getSkill(existing.id!)).toEqual(before);
  }, 15_000);
});
