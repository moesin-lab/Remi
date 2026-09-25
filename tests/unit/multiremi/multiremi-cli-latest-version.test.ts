import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { parseLatestReleaseVersion } from "@multiremi/api/routers/cli-latest-version.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, mockFetch, resetMultiremiTestEnv } from "./helpers.js";

let previousReleaseRepository: string | undefined;
let previousRepository: string | undefined;

beforeEach(() => {
  previousReleaseRepository = process.env.MULTIREMI_RELEASE_REPO;
  previousRepository = process.env.MULTIREMI_REPO;
  process.env.MULTIREMI_RELEASE_REPO = "Grassgod/Remi";
  delete process.env.MULTIREMI_REPO;
});

afterEach(() => {
  resetMultiremiTestEnv();
  if (previousReleaseRepository === undefined) delete process.env.MULTIREMI_RELEASE_REPO;
  else process.env.MULTIREMI_RELEASE_REPO = previousReleaseRepository;
  if (previousRepository === undefined) delete process.env.MULTIREMI_REPO;
  else process.env.MULTIREMI_REPO = previousRepository;
});

describe("Multiremi API - latest CLI version", () => {
  it("parses GitHub latest-release redirects", () => {
    expect(parseLatestReleaseVersion(
      "https://github.com/Grassgod/Remi/releases/tag/v0.2.47",
    )).toBe("v0.2.47");
    expect(parseLatestReleaseVersion(
      "/Grassgod/Remi/releases/tag/v12.34.56/",
    )).toBe("v12.34.56");
    expect(parseLatestReleaseVersion(null)).toBeNull();
    expect(parseLatestReleaseVersion("https://github.com/Grassgod/Remi/releases/latest")).toBeNull();
    expect(parseLatestReleaseVersion("not a valid URL")).toBeNull();
    expect(parseLatestReleaseVersion(
      "https://github.com/Grassgod/Remi/releases/tag/latest",
    )).toBeNull();
  });

  it("returns and caches the version discovered from a manual redirect", async () => {
    let fetchCalls = 0;
    mockFetch((url, init) => {
      fetchCalls += 1;
      expect(url).toBe("https://github.com/Grassgod/Remi/releases/latest");
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://github.com/Grassgod/Remi/releases/tag/v0.2.47" },
      });
    });
    const app = createMultiremiApp({
      store: createStore(),
      authToken: "latest-version-secret",
      backgroundJobs: false,
      controlPlaneSshMesh: null,
      scmPolling: null,
    });
    const headers = { Authorization: "Bearer latest-version-secret" };

    const first = await app.request("/api/cli/latest-version", { headers });
    const second = await app.request("/api/cli/latest-version", { headers });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ version: "v0.2.47" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ version: "v0.2.47" });
    expect(fetchCalls).toBe(1);
  });

  it("requires default API authentication", async () => {
    mockFetch(() => new Response(null, {
      status: 302,
      headers: { location: "/Grassgod/Remi/releases/tag/v0.2.47" },
    }));
    const app = createMultiremiApp({
      store: createStore(),
      authToken: "latest-version-secret",
      backgroundJobs: false,
      controlPlaneSshMesh: null,
      scmPolling: null,
    });

    const response = await app.request("/api/cli/latest-version");

    expect(response.status).toBe(401);
  });

  it("explains how to recover when the self-hosted release catalog is empty", async () => {
    const releaseDir = mkdtempSync(join(tmpdir(), "multiremi-empty-releases-"));
    const previousReleaseDir = process.env.MULTIREMI_RELEASE_DIR;
    process.env.MULTIREMI_RELEASE_DIR = releaseDir;
    try {
      const app = createMultiremiApp({
        store: createStore(),
        authToken: "latest-version-secret",
        backgroundJobs: false,
        controlPlaneSshMesh: null,
        scmPolling: null,
      });

      const response = await app.request("/api/remi/releases/latest/version", {
        headers: { Authorization: "Bearer latest-version-secret" },
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        code: "release_catalog_empty",
        error: "no CLI releases are configured on this server; configure MULTIREMI_RELEASE_DIR or use the GitHub release installer",
      });
    } finally {
      if (previousReleaseDir === undefined) delete process.env.MULTIREMI_RELEASE_DIR;
      else process.env.MULTIREMI_RELEASE_DIR = previousReleaseDir;
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });

  it("returns null when GitHub discovery fails", async () => {
    mockFetch(() => {
      throw new Error("GitHub unavailable");
    });
    const app = createMultiremiApp({
      store: createStore(),
      authToken: "latest-version-secret",
      backgroundJobs: false,
      controlPlaneSshMesh: null,
      scmPolling: null,
    });

    const response = await app.request("/api/cli/latest-version", {
      headers: { Authorization: "Bearer latest-version-secret" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: null });
  });
});
