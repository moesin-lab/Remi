import { expect, it } from "bun:test";
import { mockFetch, resetMultiremiTestEnv, useUploadDir } from "./helpers.js";

it("restores native HTTP after replacing a fetch fixture more than once", async () => {
  const original = globalThis.fetch;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => new Response("real HTTP"),
  });
  try {
    mockFetch(() => new Response("first fixture"));
    expect(await (await fetch("https://fixture.invalid")).text()).toBe("first fixture");
    mockFetch(() => new Response("second fixture"));
    expect(await (await fetch("https://fixture.invalid")).text()).toBe("second fixture");
    resetMultiremiTestEnv();
    expect(globalThis.fetch).toBe(original);
    expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe("real HTTP");
    resetMultiremiTestEnv();
    expect(globalThis.fetch).toBe(original);
  } finally {
    resetMultiremiTestEnv();
    server.stop(true);
  }
});

it("restores the preload upload root and preserves it across repeated cleanup", () => {
  const initial = process.env.MULTIREMI_UPLOAD_DIR;
  expect(initial).toBeDefined();
  try {
    expect(useUploadDir()).not.toBe(initial);
    resetMultiremiTestEnv();
    expect(process.env.MULTIREMI_UPLOAD_DIR).toBe(initial);
    resetMultiremiTestEnv();
    expect(process.env.MULTIREMI_UPLOAD_DIR).toBe(initial);
  } finally { resetMultiremiTestEnv(); }
});
