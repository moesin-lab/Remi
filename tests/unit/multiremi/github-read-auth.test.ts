import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createGitHubReadHeaders } from "@multiremi/scm/github-read-auth.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { fetchSkillImportResponse, withSkillImportDeadline } from "@daemon/agent-runtime/skills/skill-import-network.js";
import { createStore, db, jsonResponse, mockFetch, resetMultiremiTestEnv } from "./helpers.js";

const env = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, MULTIREMI_SCM_ENCRYPTION_KEY: process.env.MULTIREMI_SCM_ENCRYPTION_KEY };
afterEach(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetMultiremiTestEnv();
});
const api = "https://api.github.com/repos/example/skills";
const raw = "https://raw.githubusercontent.com/example/skills/main/demo/SKILL.md";
function setup() {
  process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  delete process.env.GITHUB_TOKEN;
  const store = createStore();
  store.ensureLocalWorkspace();
  store.updateWorkspace("local", { repos: [
    { id: "repo_skills", name: "skills", url: "git@github.com:example/skills.git", defaultBranch: "main" },
    { id: "repo_other", name: "other", url: "https://github.com/example/other", defaultBranch: "main" },
  ] });
  store.createScmConnection({ id: "selected", name: "Selected", provider: "github", accessToken: "connection-secret", repositoryScope: "selected", repositoryIds: ["repo_skills"] });
  return store;
}
const auth = (provider: ReturnType<typeof createGitHubReadHeaders>, url = api) => new Headers(provider(new URL(url))).get("authorization");

describe("server GitHub read credentials", () => {
  it("matches repository across API/raw/web URLs, with selected > all > environment > anonymous", () => {
    const store = setup();
    process.env.GITHUB_TOKEN = "env-secret";
    store.createScmConnection({ id: "default", name: "All", provider: "github", accessToken: "default-secret", repositoryScope: "all" });
    const headers = createGitHubReadHeaders(store, "local");
    for (const url of [api, raw, "https://github.com/EXAMPLE/SKILLS/tree/main/demo"]) expect(auth(headers, url)).toBe("Bearer connection-secret");
    expect(auth(headers, "https://api.github.com/repos/example/other")).toBe("Bearer default-secret");
    store.updateScmConnection("default", { enabled: false });
    expect(auth(headers, "https://api.github.com/repos/example/other")).toBe("Bearer env-secret");
    store.updateScmConnection("selected", { enabled: false });
    expect(auth(headers)).toBe("Bearer env-secret");
    delete process.env.GITHUB_TOKEN;
    expect(auth(headers)).toBeNull();
  });

  it("isolates workspace, repository, provider and official HTTPS origins", () => {
    const store = setup();
    const headers = createGitHubReadHeaders(store, "local");
    expect(auth(headers, "https://api.github.com/repos/example/unbound")).toBeNull();
    expect(auth(createGitHubReadHeaders(store, "elsewhere"))).toBeNull();
    process.env.GITHUB_TOKEN = "env-secret";
    for (const url of ["https://evil.example/example/skills", "http://github.com/example/skills", "https://api.github.com.evil.example/repos/example/skills", "https://api.github.com:444/repos/example/skills", "https://user@github.com/example/skills", "https://api.github.com/user"]) expect(auth(headers, url)).toBeNull();
  });

  it("falls back after decryption failure without logging secret exceptions", () => {
    const store = setup();
    process.env.GITHUB_TOKEN = "env-secret";
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      db!.run("UPDATE multiremi_scm_connections SET access_token_encrypted = ? WHERE id = ?", ["broken-connection-secret", "selected"]);
      expect(auth(createGitHubReadHeaders(store, "local"))).toBe("Bearer env-secret");
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it("falls back for malformed tokens without exposing invalid header values", async () => {
    const store = setup();
    store.updateScmConnection("selected", { accessToken: "invalid-secret\nvalue" });
    process.env.GITHUB_TOKEN = "env-secret";
    expect(auth(createGitHubReadHeaders(store, "local"))).toBe("Bearer env-secret");
    process.env.GITHUB_TOKEN = "invalid-env\nvalue";
    expect(auth(createGitHubReadHeaders(store, "local"))).toBeNull();
    await expect(withSkillImportDeadline({ githubHeaders: () => ({ Authorization: "Bearer invalid-secret\nvalue" }) },
      () => fetchSkillImportResponse(api, {}, 100))).rejects.toThrow("Skill import authentication headers are invalid");
  });

  it("HTTP POST imports a directory with connection credentials on both API and raw requests", async () => {
    const store = setup();
    const hosts = new Set<string>();
    mockFetch((url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer connection-secret");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      hosts.add(new URL(url).hostname);
      if (url.includes("/commits/")) return new Response("sha", { status: url.endsWith("/main") ? 200 : 404 });
      if (url === api) return jsonResponse({ default_branch: "main" });
      if (url.includes("/git/trees/")) return jsonResponse({ tree: [{ type: "blob", path: "demo/SKILL.md" }] });
      if (url.includes("/contents/demo")) return jsonResponse([{ type: "file", path: "demo/notes.md", download_url: raw.replace("SKILL.md", "notes.md") }]);
      if (url.endsWith("/notes.md")) return new Response("Notes");
      return new Response("---\nname: demo\ndescription: demo\n---\n# Demo");
    });
    const response = await createMultiremiApp({ store }).request("/api/skills/import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/example/skills/tree/main/demo" }),
    });
    expect(response.status).toBe(201);
    expect(hosts).toEqual(new Set(["api.github.com", "raw.githubusercontent.com"]));
    expect(await response.text()).not.toContain("connection-secret");
  });

  it("strips credentials on cross-origin redirects, including redirects back to GitHub", async () => {
    const store = setup();
    const seen: Array<string | null> = [];
    mockFetch((url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      if (url === api) return new Response(null, { status: 302, headers: { location: "https://external.example/file" } });
      if (url.includes("external.example")) return new Response(null, { status: 302, headers: { location: raw } });
      return new Response("ok");
    });
    await withSkillImportDeadline({ githubHeaders: createGitHubReadHeaders(store, "local") }, () => fetchSkillImportResponse(api, {}, 100));
    expect(seen).toEqual(["Bearer connection-secret", null, null]);
  });

  it("keeps same-origin redirect auth and redacts credentials reflected in successful content", async () => {
    const store = setup();
    const seen: Array<string | null> = [];
    mockFetch((url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      if (url === api) return new Response(null, { status: 307, headers: { location: "/repos/example/skills/contents" } });
      return new Response("reflected connection-secret");
    });
    const response = await withSkillImportDeadline({ githubHeaders: createGitHubReadHeaders(store, "local") }, () => fetchSkillImportResponse(api, {}, 100));
    expect(seen).toEqual(["Bearer connection-secret", "Bearer connection-secret"]);
    expect(await response.text()).toBe("reflected [REDACTED]");
  });

  it("isolates concurrent import credential providers", async () => {
    const seen: Array<string | null> = [];
    mockFetch(async (_url, init) => {
      await new Promise(resolve => setTimeout(resolve, 1));
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response("ok");
    });
    await Promise.all(["first", "second"].map(token => withSkillImportDeadline({
      githubHeaders: () => ({ Authorization: `Bearer ${token}` }),
    }, () => fetchSkillImportResponse(api, {}, 100))));
    expect(seen.sort()).toEqual(["Bearer first", "Bearer second"]);
  });

  it("uses environment auth for API and raw but never for non-GitHub URLs", async () => {
    process.env.GITHUB_TOKEN = "env-secret";
    const seen: Array<string | null> = [];
    mockFetch((_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response("ok");
    });
    await withSkillImportDeadline({}, async () => {
      for (const url of [api, raw, "https://external.example/file"]) await fetchSkillImportResponse(url, {}, 100);
    });
    expect(seen).toEqual(["Bearer env-secret", "Bearer env-secret", null]);
  });

  it("does not leak transport errors, response bodies or arbitrary Retry-After headers", async () => {
    const store = setup();
    const app = createMultiremiApp({ store });
    let mode = "throw";
    mockFetch(() => {
      if (mode === "throw") throw new Error("Authorization: Bearer connection-secret");
      return new Response("connection-secret", { status: 429, headers: { "retry-after": "connection-secret" } });
    });
    for (mode of ["throw", "response"]) {
      const log = spyOn(console, "error").mockImplementation(() => {});
      try {
        const response = await app.request("/api/skills/import", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://github.com/example/skills/tree/main/demo" }),
        });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(await response.text()).not.toContain("connection-secret");
        expect(JSON.stringify(log.mock.calls)).not.toContain("connection-secret");
      } finally { log.mockRestore(); }
    }
  });
});
