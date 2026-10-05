import { expect, it } from "bun:test";
import { resolveAcpProcessLaunch } from "@acp/launch.js";

it("launches the Claude Node wrapper with literal arguments on Windows", () => {
  const wrapper = "C:/Program Files/Remi/remi-claude-agent-acp";
  const launch = resolveAcpProcessLaunch(wrapper, ["--verify-patch"], "win32");
  expect(launch.executable).toBe(Bun.which("node") ?? "node");
  expect(launch.args).toEqual([wrapper, "--verify-patch"]);
  expect(resolveAcpProcessLaunch("codex.exe", ["--help"], "win32")).toEqual({ executable: "codex.exe", args: ["--help"] });
  expect(resolveAcpProcessLaunch(wrapper, [], "linux")).toEqual({ executable: wrapper, args: [] });
});

it("launches JavaScript ACP entries through Node on Windows without changing literal arguments", () => {
  for (const extension of ["js", "cjs", "mjs"]) {
    const script = `C:/Program Files/Remi/codex-acp/index.${extension}`;
    const args = ["--config", "name with spaces & symbols"];
    expect(resolveAcpProcessLaunch(script, args, "win32")).toEqual({ executable: Bun.which("node") ?? "node", args: [script, ...args] });
    expect(resolveAcpProcessLaunch(script, args, "linux")).toEqual({ executable: script, args });
  }
});
