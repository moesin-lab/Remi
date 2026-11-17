import { describe, expect, it } from "bun:test";
import { cliCommandHelp, cliCommandInventory, dispatch } from "../../../apps/remi/cli/index.js";
import { RETIRED_CLI_COMMANDS } from "../../../apps/remi/cli/core/retired-commands.js";

const inventory = cliCommandInventory();
// Derive every namespace from the shipped registry, including implicit nested
// groups and hidden paths. Commands accepting positionals can also have children
// (runtime usage, issue workspace); an arbitrary token is valid input there.
const groups = [...new Map(inventory.flatMap((entry) =>
  entry.path.slice(0, -1).map((_, index) => {
    const path = entry.path.slice(0, index + 1);
    return [path.join(" "), path] as const;
  })
)).values()].filter((path) => {
  const entry = inventory.find((item) => item.path.join(" ") === path.join(" "));
  return !entry?.positionals.length && !Object.keys(RETIRED_CLI_COMMANDS).some((retired) =>
    path.join(" ") === retired || path.join(" ").startsWith(`${retired} `)
  );
});

async function capture(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  const exitCode = process.exitCode;
  console.log = (...parts) => { stdout.push(parts.map(String).join(" ")); };
  console.error = (...parts) => { stderr.push(parts.map(String).join(" ")); };
  process.exitCode = 0;
  try {
    await dispatch(args);
    return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), code: Number(process.exitCode) };
  } finally {
    console.log = log;
    console.error = error;
    // Bun 1.3.14 ignores assigning undefined after a numeric exit code.
    // Restore the original successful state explicitly for later suites.
    process.exitCode = exitCode ?? 0;
  }
}

describe("shipped CLI command groups", () => {
  it("rejects unknown subcommands at every registry group with full path and group help", async () => {
    expect(groups.length).toBeGreaterThan(100);
    for (const path of groups) {
      const args = [...path, "__unknown_subcommand__", "extra"];
      const result = await capture(args);
      expect(result.code, path.join(" ")).toBe(1);
      expect(result.stdout, path.join(" ")).toBe("");
      expect(result.stderr, path.join(" ")).toBe(
        `Unknown command: remi ${args.join(" ")}\n${cliCommandHelp(path)}`,
      );
    }
  });

  it("prints group help with exit 0 for bare namespaces and preserves both help forms", async () => {
    for (const path of groups) {
      const entry = inventory.find((item) => item.path.join(" ") === path.join(" "));
      // Executable parents such as context retain their own bare invocation.
      if (entry && (entry.parse !== "passthrough" || entry.capability || entry.id.startsWith("legacy."))) continue;
      const expected = { stdout: cliCommandHelp(path), stderr: "", code: 0 };
      expect(await capture(path), path.join(" ")).toEqual(expected);
      expect(await capture([...path, "--help"]), path.join(" ")).toEqual(expected);
      expect(await capture([...path, "-h"]), path.join(" ")).toEqual(expected);
      expect(await capture(["help", ...path]), path.join(" ")).toEqual(expected);
    }
  });
});
