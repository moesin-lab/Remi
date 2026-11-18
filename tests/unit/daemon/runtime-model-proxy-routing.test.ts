import { expect, it } from "bun:test";

it("routes worker model discovery and Codex catalogs directly for CIDR and via proxy outside CIDR", async () => {
  const directRequests: string[] = [];
  const proxyRequests: string[] = [];
  function respond(request: Request, source: string, requests: string[]) {
    const url = new URL(request.url);
    requests.push(url.pathname + url.search);
    expect(request.headers.get("authorization")).toBe("Bearer routing-test-key");
    expect(request.headers.get("x-routing-test")).toBe("preserved");
    if (url.pathname.includes("/claude/")) {
      expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
      return Response.json(url.searchParams.has("after_id")
        ? { data: [{ id: `${source}-second` }], has_more: false }
        : { data: [{ id: source }], has_more: true, last_id: source });
    }
    return Response.json({ data: [{ id: source }],
      ...(request.headers.has("x-catalog") ? { models: [{ slug: source }] } : {}) });
  }
  // A loopback subnet exercises real CIDR transport routing without a LAN dependency.
  const direct = Bun.serve({ hostname: "0.0.0.0", port: 0,
    fetch: request => respond(request, "direct", directRequests) });
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: request => respond(request, "proxy", proxyRequests) });
  try {
    const child = Bun.spawn([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { discoverRuntimeProfileModels } from "./packages/server/src/worker/runtime-profile-models.ts";
      import { prepareRuntimeCodexModelCatalog } from "./packages/server/src/worker/runtime-codex-model-catalog.ts";
      const before = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
      for (const [base, source] of [
        ["http://127.0.0.2:${direct.port}", "direct"],
        ["http://outside.invalid", "proxy"],
      ]) {
        for (const override of [false, true]) {
          const profile = {
            name: "routing", base_url: override ? "http://unused.invalid" : base + "/claude",
            model: source, env_key: "REMI_CODEX_KEY",
            endpoint_options: { headers: { "X-Routing-Test": "preserved" },
              ...(override ? { models_url: base + "/override/claude/models" } : {}) },
          };
          const signal = new AbortController().signal;
          const models = await discoverRuntimeProfileModels("claude", profile, "routing-test-key", signal);
          assert.deepEqual(models.map(model => model.id), [source, source + "-second"]);
          profile.base_url = override ? "http://unused.invalid" : base + "/codex";
          if (override) profile.endpoint_options.models_url = base + "/override/codex/models";
          const codexModels = await discoverRuntimeProfileModels("codex", profile, "routing-test-key", signal);
          assert.deepEqual(codexModels.map(model => model.id), [source]);
          const home = await mkdtemp(join(tmpdir(), "remi-model-route-"));
          try {
            await writeFile(join(home, "config.toml"), 'model = "' + source + '"\\n');
            let validations = 0;
            await prepareRuntimeCodexModelCatalog({ ...profile, endpoint_options: { ...profile.endpoint_options,
              headers: { ...profile.endpoint_options.headers, "X-Catalog": "true" } } }, "routing-test-key", home, signal, async path => {
              validations++;
              assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { models: [{ slug: source }] });
            });
            assert.equal(validations, 1);
            assert.deepEqual(JSON.parse(await readFile(join(home, "remi-model-catalog.json"), "utf8")),
              { models: [{ slug: source }] });
          } finally { await rm(home, { recursive: true, force: true }); }
          assert.deepEqual({ NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }, before);
        }
      }
      console.log("ok");
    `], {
      cwd: process.cwd(),
      env: { ...process.env, HTTP_PROXY: proxy.url.href, http_proxy: proxy.url.href,
        HTTPS_PROXY: proxy.url.href, https_proxy: proxy.url.href, ALL_PROXY: "", all_proxy: "",
        NO_PROXY: "127.0.0.0/8", no_proxy: "127.0.0.0/8" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, stderr, stdout: stdout.trim() }).toEqual({ code: 0, stderr: "", stdout: "ok" });
    for (const [requests, source] of [[directRequests, "direct"], [proxyRequests, "proxy"]] as const) {
      expect(requests).toEqual([
        "/claude/v1/models", `/claude/v1/models?after_id=${source}`,
        "/codex/models", "/codex/models",
        "/override/claude/models", `/override/claude/models?after_id=${source}`,
        "/override/codex/models", "/override/codex/models",
      ]);
    }
  } finally { direct.stop(true); proxy.stop(true); }
}, 15000);
