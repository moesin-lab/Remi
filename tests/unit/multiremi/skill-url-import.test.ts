import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, jsonResponse, mockFetch, resetMultiremiTestEnv } from "./helpers.js";

const sourceUrl = "https://github.com/example/skills/tree/main/demo";
const raw = "https://raw.githubusercontent.com/example/skills/main/demo";
const contents = "https://api.github.com/repos/example/skills/contents/demo";
const skillMd = "---\nname: demo\ndescription: Imported demo\n---\n# Demo";
const file = (path: string) => ({ name: path.split("/").at(-1), path: `demo/${path}`, type: "file", download_url: `${raw}/${path}` });
const directory = { name: "references", path: "demo/references", type: "dir", url: `${contents}/references?ref=main` };
const routes = ["/api/skills/import", "/api/multiremi/skills/import"];

afterEach(resetMultiremiTestEnv);

function mockBundle(override: (url: string) => Response | undefined = () => undefined) {
  mockFetch((url) => {
    const response = override(url);
    if (response) return response;
    if (url.includes("/commits/")) return new Response("sha", { status: url.endsWith("/main") ? 200 : 404 });
    if (url === "https://api.github.com/repos/example/skills") return jsonResponse({ default_branch: "main" });
    if (url.endsWith("/git/trees/main?recursive=1")) return jsonResponse({ tree: [{ type: "blob", path: "demo/SKILL.md" }] });
    if (url === `${raw}/SKILL.md`) return new Response(skillMd);
    if (url === `${contents}?ref=main`) return jsonResponse([file("SKILL.md"), file("notes.md"), directory, file("logo.png"), file("LICENSE")]);
    if (url === `${contents}/references?ref=main`) return jsonResponse([file("references/guide.md"), file("references/SKILL.md")]);
    if (url === `${raw}/notes.md`) return new Response("Notes");
    if (url === `${raw}/references/SKILL.md`) return new Response("Nested Skill");
    if (url === `${raw}/references/guide.md`) return new Response("Guide");
    if (url.startsWith("https://raw.githubusercontent.com/example/skills/main/") && url.endsWith("/SKILL.md")) return new Response("Not found", { status: 404 });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

async function post(app: ReturnType<typeof createMultiremiApp>, route: string, url = sourceUrl) {
  return app.request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
}

async function importedSkill(response: Response) {
  const body = await response.json();
  return body.skill ?? body;
}

describe("URL skill bundle import", () => {
  for (const route of routes) {
    it(`synchronizes additions, changes, deletions and an empty bundle with stable identity: ${route}`, async () => {
      const store = createStore();
      const app = createMultiremiApp({ store });
      mockBundle();
      const first = await post(app, route);
      expect(first.status).toBe(201);
      const initial = await importedSkill(first);
      expect(initial.files.map((f: { path: string }) => f.path).sort()).toEqual(["notes.md", "references/SKILL.md", "references/guide.md"]);
      const other = store.createSkill({ workspaceId: "elsewhere", name: "demo", content: "Unchanged", config: { origin: { type: "github", source_url: sourceUrl } } });
      store.updateSkill(initial.id, { createdBy: "original-creator", config: { ...initial.config, local_setting: true } });
      mockBundle((url) => {
        if (url === `${raw}/SKILL.md`) return new Response(skillMd.replace("name: demo", "name: renamed") + "\nNew version");
        if (url === `${contents}?ref=main`) return jsonResponse([file("notes.md"), file("new.yaml")]);
        if (url === `${raw}/notes.md`) return new Response("Modified notes");
        if (url === `${raw}/new.yaml`) return new Response("new: true");
      });
      const second = await post(app, route);
      expect(second.status).toBe(200);
      const updated = await importedSkill(second);
      expect(updated.id).toBe(initial.id);
      expect(updated.name).toBe("renamed");
      expect(updated.content).toContain("New version");
      expect(updated.created_by ?? updated.createdBy).toBe("original-creator");
      expect(updated.created_at ?? updated.createdAt).toBe(initial.created_at ?? initial.createdAt);
      expect(updated.config.local_setting).toBe(true);
      expect(updated.files.map((f: { path: string; content: string }) => [f.path, f.content]).sort()).toEqual([["new.yaml", "new: true"], ["notes.md", "Modified notes"]]);
      expect(store.getSkill(other.id!)?.content).toBe("Unchanged");
      mockBundle((url) => url === `${contents}?ref=main` ? jsonResponse([]) : undefined);
      expect((await post(app, route)).status).toBe(200);
      expect(store.getSkill(initial.id)?.files).toEqual([]);
    });

    it(`does not overwrite a same-name skill from another source: ${route}`, async () => {
      const store = createStore();
      const existing = store.createSkill({ name: "demo", content: "Keep me", config: { origin: { type: "github", source_url: "https://github.com/other/skills" } } });
      const app = createMultiremiApp({ store });
      mockBundle();
      expect((await post(app, route)).status).toBe(409);
      expect(store.getSkill(existing.id!)?.content).toBe("Keep me");
      expect(store.getSkill(existing.id!)?.files).toEqual([]);
    });
  }

  const failures = [
    { name: "rate-limited listing 403", url: `${contents}?ref=main`, response: () => new Response("Forbidden", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } }), status: 429, error: "2027-01-15T08:00:00.000Z" },
    { name: "rate-limited listing 429", url: `${contents}?ref=main`, response: () => new Response("Too many requests", { status: 429 }), status: 429, error: "GITHUB_TOKEN" },
    { name: "rate-limited subdirectory", url: `${contents}/references?ref=main`, response: () => new Response("Forbidden", { status: 403, headers: { "retry-after": "60" } }), status: 429, error: "Retry-After: 60" },
    { name: "rate-limited download", url: `${raw}/references/guide.md`, response: () => new Response("Too many requests", { status: 429 }), status: 429, error: "GITHUB_TOKEN" },
    { name: "forbidden listing", url: `${contents}?ref=main`, response: () => new Response("Forbidden", { status: 403 }), status: 502, error: "HTTP 403" },
    { name: "subdirectory failure", url: `${contents}/references?ref=main`, response: () => new Response("Failed", { status: 500 }), status: 502, error: "references" },
    { name: "download failure", url: `${raw}/references/guide.md`, response: () => new Response("Failed", { status: 404 }), status: 502, error: "references/guide.md" },
    { name: "malformed listing", url: `${contents}?ref=main`, response: () => new Response("not JSON"), status: 502, error: "failed to list" },
    { name: "non-array listing", url: `${contents}/references?ref=main`, response: () => jsonResponse({ message: "Invalid" }), status: 502, error: "expected a directory listing" },
    { name: "network failure", url: `${contents}/references?ref=main`, response: (): Response => { throw new Error("Connection reset"); }, status: 502, error: "Connection reset" },
    { name: "missing download URL", url: `${contents}?ref=main`, response: () => jsonResponse([{ name: "notes.md", path: "demo/notes.md", type: "file" }]), status: 502, error: "missing download URL" },
  ];
  for (const url of [sourceUrl, "https://skills.sh/example/skills/demo"]) {
    for (const failure of failures) {
      it(`rejects ${failure.name} without changing stored data: ${url}`, async () => {
        const store = createStore();
        const app = createMultiremiApp({ store });
        mockBundle((requested) => requested === failure.url ? failure.response() : undefined);
        const response = await post(app, routes[0], url);
        expect(response.status).toBe(failure.status);
        expect((await response.json()).error).toContain(failure.error);
        expect(store.listSkills()).toEqual([]);
        mockBundle();
        const good = await importedSkill(await post(app, routes[0], url));
        const before = store.getSkill(good.id);
        mockBundle((requested) => requested === failure.url ? failure.response() : undefined);
        expect((await post(app, routes[1], url)).status).toBe(failure.status);
        expect(store.getSkill(good.id)).toEqual(before);
      });
    }
  }

  const discoveryStages = [
    { name: "GitHub default branch", source: "https://github.com/example/skills", target: "https://api.github.com/repos/example/skills" },
    { name: "skills.sh default branch", source: "https://skills.sh/example/skills/demo", target: "https://api.github.com/repos/example/skills" },
    { name: "GitHub ref", source: sourceUrl, target: "https://api.github.com/repos/example/skills/commits/main/demo" },
    { name: "conventional candidate", source: "https://skills.sh/example/skills/demo", target: "https://raw.githubusercontent.com/example/skills/main/skills/demo/SKILL.md" },
    { name: "root candidate", source: "https://skills.sh/example/skills/demo", target: "https://raw.githubusercontent.com/example/skills/main/SKILL.md" },
    { name: "tree", source: "https://skills.sh/example/skills/demo", target: "https://api.github.com/repos/example/skills/git/trees/main?recursive=1" },
    { name: "tree candidate", source: "https://skills.sh/example/skills/demo", target: "https://raw.githubusercontent.com/example/skills/main/other/SKILL.md" },
    { name: "truncated tree prefix", source: "https://skills.sh/example/skills/demo", target: "https://api.github.com/repos/example/skills/contents/skills?ref=main", truncated: true },
    { name: "truncated tree subdirectory", source: "https://skills.sh/example/skills/demo", target: "https://api.github.com/repos/example/skills/contents/skills/nested?ref=main", truncated: true },
  ];
  for (const stage of discoveryStages) {
    for (const status of [403, 429, 500]) {
      for (const route of routes) {
        it(`preserves discovery failure ${status} at ${stage.name}: ${route}`, async () => {
          const store = createStore();
          const app = createMultiremiApp({ store });
          mockBundle((url) => {
            if (["root candidate", "tree", "tree candidate", "truncated tree prefix", "truncated tree subdirectory"].includes(stage.name)
              && url === `${raw}/SKILL.md`) return new Response("Not found", { status: 404 });
            if (stage.name === "tree candidate" && url.endsWith("/git/trees/main?recursive=1")) return jsonResponse({ tree: [{ type: "blob", path: "other/SKILL.md" }] });
            if (url === stage.target) return new Response("Failed", {
              status,
              headers: status === 403 ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } : {},
            });
            if (stage.truncated && url.endsWith("/git/trees/main?recursive=1")) return jsonResponse({ tree: [], truncated: true });
            if (stage.truncated && url.endsWith("/contents/skills?ref=main")) return jsonResponse([
              { name: "nested", type: "dir", path: "skills/nested", url: stage.target },
            ]);
          });
          const response = await post(app, route, stage.source);
          expect(response.status).toBe(status === 500 ? 502 : 429);
          const error = (await response.json()).error;
          expect(error).toContain(stage.target);
          expect(error).toContain(status === 500 ? "HTTP 500" : "GITHUB_TOKEN");
          if (status === 403) expect(error).toContain("2027-01-15T08:00:00.000Z");
          expect(store.listSkills()).toEqual([]);
        });
      }
    }
  }

  for (const cap of ["count", "file size", "total size"]) {
    it(`preserves ${cap} limits`, async () => {
      const store = createStore();
      const app = createMultiremiApp({ store });
      mockBundle((url) => {
        if (url === `${contents}?ref=main`) return jsonResponse(Array.from({ length: cap === "count" ? 129 : cap === "total size" ? 9 : 1 }, (_, i) => file(`${i}.txt`)));
        if (url.endsWith(".txt")) return new Response("x".repeat(cap === "file size" ? (1 << 20) + 1 : 1 << 20));
      });
      const response = await post(app, routes[0]);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("limit");
      expect(store.listSkills()).toEqual([]);
    });
  }
});
