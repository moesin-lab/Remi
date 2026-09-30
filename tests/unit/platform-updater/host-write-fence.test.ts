import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const preload = fileURLToPath(new URL("../../../deploy/docker/host-write-fence.ts", import.meta.url));
const dualHeaders = { Authorization: "Bearer master", "X-Multiremi-Updater-Token": "updater" };

function legacyFixture() {
  const root = mkdtempSync(join(tmpdir(), "remi-host-fence-"));
  roots.push(root);
  const marker = join(root, "write-fence.json");
  const entrypoint = join(root, "old-api.ts");
  // This old-style API knows nothing about maintenance, the host, or its DB.
  // Tests launch it through the same explicit run --preload command as Docker.
  writeFileSync(entrypoint, `
let mutations = 0;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (["/ws", "/api/realtime/ws", "/api/daemon/ws"].includes(path) && server.upgrade(request)) return;
    if (path.startsWith("/api/platform-updater/")) {
      if (request.headers.get("Authorization") !== "Bearer master"
        || request.headers.get("X-Multiremi-Updater-Token") !== "updater") return new Response("Unauthorized", { status: 401 });
      return Response.json({ reconciled: ["pop_legacy"] });
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    if (!["GET", "HEAD"].includes(request.method)) mutations++;
    return Response.json({ mutations, thisIsServer: this === server, args: process.argv.slice(2) });
  },
  websocket: {
    message(ws) { mutations++; ws.send(JSON.stringify({ mutations })); },
  },
});
console.log(JSON.stringify({ port: server.port }));
`);
  return { marker, entrypoint };
}

async function startLegacyApi(fixture: ReturnType<typeof legacyFixture>) {
  const child = Bun.spawn([process.execPath, "run", "--preload", preload, fixture.entrypoint, "serve"], {
    env: { ...process.env, MULTIREMI_HOST_WRITE_FENCE_FILE: fixture.marker },
    stdout: "pipe", stderr: "pipe",
  });
  children.push(child);
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("legacy API did not start")), 5_000); }),
    ]);
    if (ready.done) throw new Error(`legacy API exited: ${await new Response(child.stderr).text()}`);
    const { port } = JSON.parse(new TextDecoder().decode(ready.value).trim()) as { port: number };
    return { child, url: `http://127.0.0.1:${port}` };
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}

async function mutateOverWebSocket(url: string): Promise<{ mutations: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.replace(/^http:/, "ws:"));
    const timeout = setTimeout(() => { socket.close(); reject(new Error("WebSocket request timed out")); }, 3_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "daemon:heartbeat" }));
    socket.onmessage = (event) => {
      clearTimeout(timeout);
      socket.close();
      resolve(JSON.parse(String(event.data)) as { mutations: number });
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error("WebSocket upgrade rejected"));
    };
  });
}

describe("host-injected legacy API write fence", () => {
  it("enforces a durable marker across real HTTP requests and API process restarts", async () => {
    const originalServe = Bun.serve;
    const fixture = legacyFixture();
    let running = await startLegacyApi(fixture);
    const request = (method: string, path = "/api/issues", headers?: Record<string, string>) =>
      fetch(`${running.url}${path}`, { method, headers });
    expect(await (await request("POST")).json()).toMatchObject({ mutations: 1, thisIsServer: true, args: ["serve"] });

    writeFileSync(fixture.marker, JSON.stringify({ operationId: "pop_legacy", phase: "verifying" }));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const blocked = await request(method);
      expect(blocked.status).toBe(503);
      expect(blocked.headers.get("Retry-After")).toBe("5");
      expect(blocked.headers.get("Cache-Control")).toBe("no-store");
      expect(blocked.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(await blocked.json()).toMatchObject({ code: "platform_update_in_progress", operation_id: "pop_legacy" });
    }
    expect(await (await request("GET")).json()).toMatchObject({ mutations: 1, thisIsServer: true });
    expect((await request("GET", "/readyz")).status).toBe(200);
    expect((await request("HEAD", "/health")).status).toBe(200);
    expect((await request("OPTIONS")).status).toBe(204);
    expect((await request("POST", "/api/platform-updater/operations/reconcile")).status).toBe(401);
    expect((await request("POST", "/api/platform-updater/operations/reconcile", { Authorization: "Bearer master" })).status).toBe(401);
    expect((await request("POST", "/api/platform-updater/operations/reconcile", dualHeaders)).status).toBe(200);
    expect((await request("POST", "/api/platform-updater-other", dualHeaders)).status).toBe(503);

    running.child.kill();
    await running.child.exited;
    children.splice(children.indexOf(running.child), 1);
    running = await startLegacyApi(fixture);
    expect((await request("POST")).status).toBe(503);
    expect(await (await request("GET")).json()).toMatchObject({ mutations: 0 });
    expect(JSON.parse(readFileSync(fixture.marker, "utf8")).operationId).toBe("pop_legacy");
    unlinkSync(fixture.marker);
    expect(await (await request("POST")).json()).toMatchObject({ mutations: 1 });
    // The test process did not import the preload or replace its own Bun API.
    expect(Bun.serve).toBe(originalServe);
  }, 15_000);

  it("fails closed on partial and malformed markers without blocking authenticated host recovery", async () => {
    const fixture = legacyFixture();
    writeFileSync(fixture.marker, "{");
    const running = await startLegacyApi(fixture);
    for (const contents of ["{", "", "null", JSON.stringify({ wrong: "shape" })]) {
      writeFileSync(fixture.marker, contents);
      const blocked = await fetch(`${running.url}/api/issues`, { method: "POST" });
      expect(blocked.status).toBe(503);
      expect(await blocked.json()).toMatchObject({ code: "platform_update_in_progress", operation_id: null });
    }
    const recover = await fetch(`${running.url}/api/platform-updater/operations/reconcile`, { method: "POST", headers: dualHeaders });
    expect(recover.status).toBe(200);
    expect(await (await fetch(`${running.url}/api/issues`)).json()).toMatchObject({ mutations: 0 });
  });

  it("blocks WebSocket upgrades that would otherwise bypass the HTTP write fence", async () => {
    const fixture = legacyFixture();
    const running = await startLegacyApi(fixture);
    expect(await mutateOverWebSocket(`${running.url}/api/daemon/ws`)).toEqual({ mutations: 1 });
    writeFileSync(fixture.marker, JSON.stringify({ operationId: "pop_legacy" }));

    for (const path of ["/ws", "/api/realtime/ws", "/api/daemon/ws", "/api/platform-updater/operations/reconcile"]) {
      const handshake = await fetch(`${running.url}${path}`, {
        headers: { ...dualHeaders, Upgrade: "WebSocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
      });
      expect(handshake.status).toBe(503);
      expect(await handshake.json()).toMatchObject({ code: "platform_update_in_progress" });
    }
    await expect(mutateOverWebSocket(`${running.url}/api/daemon/ws`)).rejects.toThrow("upgrade rejected");
    expect(await (await fetch(`${running.url}/api/issues`)).json()).toMatchObject({ mutations: 1 });
    expect((await fetch(`${running.url}/readyz`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/platform-updater/operations/reconcile`, { method: "POST", headers: dualHeaders })).status).toBe(200);
    unlinkSync(fixture.marker);
    expect(await mutateOverWebSocket(`${running.url}/ws`)).toEqual({ mutations: 2 });
  }, 15_000);
});
