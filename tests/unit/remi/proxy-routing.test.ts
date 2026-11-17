import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, connect } from "node:net";

async function child(code: string, proxy: string, noProxy = "127.0.0.0/8") {
  const proc = Bun.spawn([process.execPath, "--eval", code], {
    cwd: process.cwd(),
    env: { ...process.env, HTTP_PROXY: proxy, http_proxy: proxy, HTTPS_PROXY: proxy, https_proxy: proxy,
      NO_PROXY: noProxy, no_proxy: noProxy, ALL_PROXY: "", all_proxy: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  return stdout.trim();
}

it("guards Bun's synchronous NO_PROXY snapshot before Promise settlement", async () => {
  const direct = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("direct") });
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("proxy") });
  try {
    expect(await child(`
      import { strict as assert } from "node:assert";
      // Deliberately call native fetch: this guards the runtime assumption itself.
      const before = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
      process.env.NO_PROXY = process.env.no_proxy = "127.0.0.2";
      const direct = fetch("http://127.0.0.2:${direct.port}");
      Object.assign(process.env, before);
      const proxied = fetch("http://outside.invalid");
      assert.equal(await (await direct).text(), "direct");
      assert.equal(await (await proxied).text(), "proxy");
      console.log("ok");
    `, proxy.url.href)).toBe("ok");
  } finally { direct.stop(true); proxy.stop(true); }
}, 15000);

it("routes every redirect hop and preserves redirect methods, bodies, credentials and controls", async () => {
  const seen: string[] = [];
  const direct = Bun.serve({ hostname: "0.0.0.0", port: 0, async fetch(req) {
    const url = new URL(req.url);
    seen.push(url.pathname);
    if (url.pathname === "/loop") return Response.redirect(new URL("/loop", req.url), 302);
    if (url.pathname === "/same") return Response.redirect(new URL("/final", req.url), 302);
    if (url.pathname === "/request-chain") return Response.redirect(new URL("/307", req.url), 307);
    if (url.pathname === "/relative") return Response.redirect(new URL("/302", req.url), 302);
    if (/^\/\d+$/.test(url.pathname)) return Response.redirect("http://outside.invalid/final", Number(url.pathname.slice(1)));
    return Response.json({ method: req.method, body: await req.text(), auth: req.headers.get("authorization") });
  }});
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/back") return Response.redirect(`http://127.0.0.2:${direct.port}/final`, 302);
    return Response.json({ method: req.method, body: await req.text(), auth: req.headers.get("authorization"), cookie: req.headers.get("cookie") });
  }});
  try {
    expect(await child(`
      import { proxyFetch } from "./packages/shared/src/proxy-fetch.ts";
      import { strict as assert } from "node:assert";
      const base = "http://127.0.0.2:${direct.port}";
      for (const status of [301, 302, 303, 307, 308]) {
        const response = await proxyFetch(base + "/" + status, { method: "POST", body: "payload", headers: { authorization: "secret", cookie: "secret" } });
        const result = await response.json();
        assert.deepEqual(result, { method: status < 307 ? "GET" : "POST", body: status < 307 ? "" : "payload", auth: null, cookie: null });
      }
      const request = new Request(base + "/request-chain", { method: "PUT", body: "request-body" });
      assert.equal((await (await proxyFetch(request)).json()).body, "request-body");
      const same = await (await proxyFetch(base + "/same", { headers: { authorization: "same-origin" } })).json();
      assert.equal(same.auth, "same-origin");
      const { multiremiApiDownloadFile } = await import("./apps/remi/cli/multiremi/http.ts");
      const download = JSON.parse((await multiremiApiDownloadFile("/302", { server: base })).toString());
      assert.equal(download.method, "GET");
      assert.equal(download.cookie, null);
      const relative = await proxyFetch(base + "/relative");
      assert.equal(relative.status, 200);
      assert.equal(relative.redirected, true);
      assert.equal(relative.url, "http://outside.invalid/final");
      const aborted = new AbortController(); aborted.abort();
      await assert.rejects(proxyFetch(base + "/302", { signal: aborted.signal }), error => error.name === "AbortError");
      assert.equal((await proxyFetch(base + "/302", { redirect: "manual" })).status, 302);
      await assert.rejects(proxyFetch(base + "/302", { redirect: "error" }), TypeError);
      await assert.rejects(proxyFetch(base + "/loop"), /Too many redirects/);
      assert.equal((await (await proxyFetch("http://outside.invalid/back")).json()).method, "GET");
      console.log("ok");
    `, proxy.url.href)).toBe("ok");
    expect(seen.filter(path => path === "/loop")).toHaveLength(21);
    expect(seen).toContain("/final");
  } finally { direct.stop(true); proxy.stop(true); }
}, 15000);

it("routes daemon helper and worker JSON and attachment calls through the shared matcher", async () => {
  const direct = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => Response.json({ source: "direct" }) });
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ source: "proxy" }) });
  try {
    expect(await child(`
      import { fetchWithTimeout } from "./apps/remi/cli/multiremi/daemon-health.ts";
      import { MultiremiDaemonClient } from "./packages/server/src/worker/client.ts";
      import { strict as assert } from "node:assert";
      for (const [base, source] of [["http://127.0.0.2:${direct.port}", "direct"], ["http://outside.invalid", "proxy"]]) {
        assert.equal((await (await fetchWithTimeout(base + "/health", {}, 2000)).json()).source, source);
        const client = new MultiremiDaemonClient(base, "test");
        assert.equal((await client.registerRuntime({})).source, source);
        assert.equal((await (await client.fetchFeishuBotOutboundAttachment("rt", "delivery", "claim", "attachment")).json()).source, source);
        assert.equal(JSON.parse((await client.downloadTaskAttachment("attachment", "task")).toString()).source, source);
      }
      console.log("ok");
    `, proxy.url.href)).toBe("ok");
  } finally { direct.stop(true); proxy.stop(true); }
}, 15000);

it("keeps all daemon helper entry points on the shared transport", () => {
  for (const path of ["apps/remi/cli/commands/repo.ts", "apps/remi/cli/multiremi/commands/repo.ts", "apps/remi/cli/multiremi/commands/issue.ts"]) {
    const source = readFileSync(path, "utf8");
    expect(source).toContain('import { proxyFetch } from "@shared/proxy-fetch.js"');
    expect(source).not.toMatch(/\bfetch\(/);
  }
});

it("inspects daemon upgrade rejections directly for CIDR NO_PROXY and proxies outside hosts", async () => {
  let proxyHits = 0;
  let directHits = 0;
  const direct = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch(req) {
    directHits++;
    expect(req.headers.get("upgrade")).toBe("websocket");
    expect(req.headers.get("authorization")).toBe("Bearer test");
    const status = Number(new URL(req.url).pathname.slice(1));
    return Response.json({ code: status === 426 ? "cli_upgrade_required" : "rejected", min_version: 3 }, { status });
  }});
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    proxyHits++;
    return new Response("proxy", { status: 502 });
  }});
  try {
    expect(await child(`
      import { inspectDaemonUpgradeRejection } from "./packages/server/src/worker/daemon-protocol-client.ts";
      import { strict as assert } from "node:assert";
      const before = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
      for (const status of [426, 401, 403, 410]) {
        const pending = inspectDaemonUpgradeRejection("ws://127.0.0.2:${direct.port}/" + status,
          { authorization: "Bearer test" }, AbortSignal.timeout(3000));
        assert.deepEqual({ NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }, before);
        assert.deepEqual(await pending, { status, code: status === 426 ? "cli_upgrade_required" : "rejected", minProtocol: 3 });
      }
      assert.deepEqual(await inspectDaemonUpgradeRejection("ws://outside.invalid/426", {}, AbortSignal.timeout(3000)),
        { status: 502, code: null, minProtocol: undefined });
      console.log("ok");
    `, proxy.url.href)).toBe("ok");
    expect(directHits).toBe(4);
    expect(proxyHits).toBe(1);
  } finally { direct.stop(true); proxy.stop(true); }
}, 15000);

it("routes real daemon WebSockets directly for CIDR and through HTTP CONNECT otherwise", async () => {
  let tunnels = 0;
  const server = Bun.serve({ hostname: "0.0.0.0", port: 0,
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response("upgrade required", { status: 400 }); },
    websocket: { message(ws, data) {
      if (JSON.parse(String(data)).t === "hello") ws.send(JSON.stringify({ v: 2, ts: 1, t: "welcome", p: { protocol: 2, session_id: "test", min_cli_version: "0.2.95" } }));
    } },
  });
  const sockets = new Set<import("node:net").Socket>();
  const proxy = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let header = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", read);
      if (!header.toString().startsWith("CONNECT ")) { socket.destroy(); return; }
      tunnels++;
      const upstream = connect(server.port!, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(header.subarray(end + 4));
        socket.pipe(upstream); upstream.pipe(socket);
      });
      sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream));
      socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
    };
    socket.on("data", read);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const address = proxy.address() as import("node:net").AddressInfo;
    expect(await child(`
      import { DaemonProtocolClient } from "./packages/server/src/worker/daemon-protocol-client.ts";
      for (const base of ["http://127.0.0.2:${server.port}", "http://outside.invalid:${server.port}"]) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { client.close(); reject(new Error("WS timeout")); }, 3000);
          const client = new DaemonProtocolClient({ serverUrl: base, daemonId: "test", cliVersion: "0.2.95",
            onWelcome: () => { clearTimeout(timer); client.close(); resolve(); }, onError: reject });
          const lane = { runtime: () => ({ runtime_id: "rt", provider: "codex", max_concurrency: 1, active_task_ids: [] }), heartbeat: () => ({ active_task_count: 0 }),
            onHeartbeatAck: async () => {}, probeUpgrade: async () => {}, onTerminal: async () => {} };
          client.addLane(lane); client.startLane(lane);
        });
      }
      console.log("ok");
    `, `http://127.0.0.1:${address.port}`)).toBe("ok");
    expect(tunnels).toBe(1);
  } finally {
    for (const socket of sockets) socket.destroy();
    proxy.close(); server.stop(true);
  }
}, 15000);
