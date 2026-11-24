import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
// 200 KB of UTF-8, with multibyte characters across pipe/chunk boundaries.
const body = "😀正文".repeat(20_000);
const entry = { seq: 1, id: "msg_1", author_type: "agent", author_id: "agt_1", body_md: body };
let directory: string;
let binary: string;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "remi-stdio-"));
  binary = join(directory, process.platform === "win32" ? "remi.exe" : "remi");
  const build = Bun.spawn([process.execPath, "build", "--compile", "apps/remi/main.ts", "--outfile", binary], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [code, , stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (code !== 0) throw new Error(`CLI build failed: ${stderr}`);
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/cli/capabilities") return Response.json({ commands: [{ id: "message.list", allowed: true }] });
      if (path.includes("ises_error")) return Response.json({ error: body }, { status: 400 });
      return Response.json({ entries: [{ ...entry, body_md: path.includes("ises_close") ? body.repeat(20) : body }], next_cursor: null });
    },
  });
}, 60_000);

afterAll(async () => {
  server?.stop(true);
  if (directory) await rm(directory, { recursive: true, force: true });
});

function command(compiled: boolean, mode: string, conversation = "ises_fixture") {
  return [...(compiled ? [binary] : [process.execPath, "apps/remi/main.ts"]),
    "message", "list", conversation, "--from", "0", "--to", "1", "--output", mode];
}
// Use Node for the reader: Bun's node:child_process compatibility layer can
// eagerly consume a pipe even while its exposed Readable is paused.
const reader = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [cmd, mode, file] = JSON.parse(process.argv[1]);
const fd = mode === "file" ? fs.openSync(file, "w") : undefined;
const child = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", fd ?? "pipe", "pipe"] });
const output = [], errors = [];
function consume(stream, chunks, slow) {
  if (!stream) return;
  if (slow) {
    stream.once("readable", () => setTimeout(() => {
      stream.on("data", chunk => chunks.push(chunk));
      stream.resume();
    }, 250));
  } else stream.on("data", chunk => chunks.push(chunk));
}
if (mode === "close") child.stdout.once("data", () => child.stdout.destroy());
else consume(child.stdout, output, mode === "slow");
consume(child.stderr, errors, mode === "error");
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("close", code => {
  if (fd !== undefined) fs.closeSync(fd);
  console.log(JSON.stringify({ code, out: Buffer.concat(output).toString("base64"), err: Buffer.concat(errors).toString("base64") }));
});
`;
async function run(cmd: string[], mode: string, file?: string) {
  const child = Bun.spawn(["node", "-e", reader, JSON.stringify([cmd, mode, file])], {
    cwd: root,
    env: { ...process.env, MULTIREMI_SERVER_URL: server.url.toString(), MULTIREMI_TOKEN: "fixture", MULTIREMI_WORKSPACE_ID: "local" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`reader failed: ${stderr}`);
  const result = JSON.parse(stdout);
  return { code: result.code, out: Buffer.from(result.out, "base64"), err: Buffer.from(result.err, "base64") };
}

for (const compiled of [false, true]) describe(compiled ? "compiled CLI stdio" : "source CLI stdio", () => {
  for (const mode of ["json", "jsonl", "table"]) it(`drains 200 KB ${mode} into a delayed reader, matching file redirection`, async () => {
    const file = join(directory, `${compiled}-${mode}.txt`);
    const redirected = await run(command(compiled, mode), "file", file);
    expect(redirected.code).toBe(0);
    expect(redirected.err.length).toBe(0);
    const expected = await readFile(file);
    expect(expected.length).toBeGreaterThanOrEqual(200_000);

    const piped = await run(command(compiled, mode), "slow");
    expect(piped.code).toBe(0);
    expect(piped.err.length).toBe(0);
    expect(piped.out.length).toBe(expected.length);
    expect(piped.out.equals(expected)).toBe(true);
    if (mode === "json") expect(JSON.parse(piped.out.toString())).toEqual([entry]);
    if (mode === "jsonl") expect(JSON.parse(piped.out.toString().trim())).toEqual(entry);
    if (mode === "table") expect(piped.out.toString()).toContain(body);
    console.log(`${compiled ? "compiled" : "source"} ${mode}: file=${expected.length}, delayed pipe=${piped.out.length}`);
  }, 15_000);

  it("drains a large fatal diagnostic and preserves exit code 1", async () => {
    const result = await run(command(compiled, "json", "ises_error"), "error");
    expect(result.code).toBe(1);
    expect(result.out.length).toBe(0);
    expect(result.err.toString().includes(body)).toBe(true);
    expect(result.err.toString()).toStartWith("Fatal:");
  }, 15_000);

  it("quietly handles a consumer closing stdout after the first chunk", async () => {
    const result = await run(command(compiled, "json", "ises_close"), "close");
    expect(result.code).toBe(0);
    expect(result.err.toString()).toBe("");
  }, 15_000);

  it("keeps unknown-command and removed-command errors at exit code 1", async () => {
    for (const args of [["no-such-command"], ["task", "create"]]) {
      const result = await run([...(compiled ? [binary] : [process.execPath, "apps/remi/main.ts"]), ...args], "fast");
      expect(result.code).toBe(1);
      expect(result.err.length).toBeGreaterThan(0);
    }
  }, 15_000);

  it("rejects unknown group subcommands on stderr and prints bare group help with exit 0", async () => {
    const prefix = compiled ? [binary] : [process.execPath, "apps/remi/main.ts"];
    for (const path of [["scm"], ["scm", "change-request"], ["scm", "connection"],
      ["platform"], ["platform", "operation"], ["runtime"]]) {
      const args = [...path, "bogus", "extra"];
      const unknown = await run([...prefix, ...args], "fast");
      expect(unknown.code).toBe(1);
      expect(unknown.out.length).toBe(0);
      expect(unknown.err.toString()).toStartWith(`Unknown command: remi ${args.join(" ")}\n`);
      expect(unknown.err.toString()).toContain(`Usage: remi ${path.join(" ")}`);
      const bare = await run([...prefix, ...path], "fast");
      expect(bare.code).toBe(0);
      expect(bare.err.length).toBe(0);
      expect(bare.out.toString()).toContain(`Usage: remi ${path.join(" ")}`);
    }
  }, 15_000);
});
