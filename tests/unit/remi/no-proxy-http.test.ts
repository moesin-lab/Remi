import { expect, it } from "bun:test";

it("routes API, uploads and downloads directly for CIDR and preserves unmatched HTTP proxy routing", async () => {
  const direct = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: (request) =>
    new URL(request.url).pathname === "/denied"
      ? Response.json({ error: "denied" }, { status: 401 })
      : Response.json({ source: "direct" }) });
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ source: "proxy" }) });
  try {
    for (const [server, expected] of [
      [`http://127.0.0.2:${direct.port}`, "direct"],
      ["http://outside.invalid", "proxy"],
    ]) {
      const child = Bun.spawn([process.execPath, "--eval", `
        import { multiremiApiRequest, multiremiApiUploadFile, multiremiApiDownloadFile } from "./apps/remi/cli/multiremi/http.ts";
        import { CliApiClient } from "./apps/remi/cli/core/api-client.ts";
        const client = new CliApiClient({ serverUrl: ${JSON.stringify(server)} });
        const modern = await client.request({ method: "GET", path: "/api/cli/capabilities" });
        const options = { server: ${JSON.stringify(server)} };
        const api = await multiremiApiRequest("GET", "/api/test", undefined, options);
        const upload = await multiremiApiUploadFile({ path: "test.txt", filename: "test.txt", contentType: "text/plain", data: new Uint8Array([65]) }, "", options);
        const download = JSON.parse((await multiremiApiDownloadFile("/file", options)).toString());
        console.log(JSON.stringify([modern.data.source, api.source, upload.source, download.source]));
      `], {
        cwd: process.cwd(),
        env: { ...process.env, HTTP_PROXY: proxy.url.href, HTTPS_PROXY: proxy.url.href,
          ALL_PROXY: "socks5h://127.0.0.1:1", NO_PROXY: "127.0.0.0/8", no_proxy: "127.0.0.0/8",
          http_proxy: proxy.url.href, https_proxy: proxy.url.href },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual([expected, expected, expected, expected]);
    }
  } finally {
    direct.stop(true);
    proxy.stop(true);
  }
}, 15000);

it("isolates simultaneous bypassed and proxied requests, preserves port restrictions and HTTP errors", async () => {
  const direct = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: (request) =>
    new URL(request.url).pathname === "/denied"
      ? Response.json({ error: "denied" }, { status: 401 })
      : Response.json({ source: "direct" }) });
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ source: "proxy" }) });
  try {
    const child = Bun.spawn([process.execPath, "--eval", `
      import { cliFetch } from "./apps/remi/cli/core/proxy-fetch.ts";
      import { CliApiClient } from "./apps/remi/cli/core/api-client.ts";
      import { strict as assert } from "node:assert";
      const before = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
      const directUrl = "http://127.0.0.2:${direct.port}";
      const urls = [directUrl, "http://outside.invalid", "http://127.0.0.2:1"];
      const pending = Array.from({ length: 30 }, (_, i) => cliFetch(urls[i % 3]).then(r => r.json()));
      assert.deepEqual({ NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }, before);
      const responses = await Promise.all(pending);
      for (let i = 0; i < responses.length; i++) assert.equal(responses[i].source, i % 3 === 0 ? "direct" : "proxy");
      const client = new CliApiClient({ serverUrl: directUrl });
      await assert.rejects(client.request({ method: "GET", path: "/denied" }), error => error.status === 401);
      console.log("ok");
    `], {
      cwd: process.cwd(),
      env: { ...process.env, HTTP_PROXY: proxy.url.href, http_proxy: proxy.url.href,
        NO_PROXY: "unrelated.test", no_proxy: `127.0.0.2:${direct.port}` },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, stderr, stdout: stdout.trim() }).toEqual({ code: 0, stderr: "", stdout: "ok" });
  } finally {
    direct.stop(true);
    proxy.stop(true);
  }
}, 15000);
