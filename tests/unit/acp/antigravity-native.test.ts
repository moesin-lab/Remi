import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AcpProvider } from "@acp/provider.js";
import { buildNativeAntigravityEnv, nativeAntigravityLaunch } from "@acp/access/antigravity-native.js";
import { seedIssueSessionNativeAntigravityHome } from "@daemon/agent-runtime/workspace/session-home.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-agy-test-")); roots.push(root);
  const base = join(root, "base"); mkdirSync(join(base, "antigravity-cli"), { recursive: true });
  writeFileSync(join(base, "antigravity-cli", "antigravity-oauth-token"), "fake-native-login");
  writeFileSync(join(base, "antigravity-cli", "settings.json"), '{"untrusted":"settings"}');
  const home = { storageRoot: root, root, home: join(root, "isolated"), provider: "antigravity" as const, agentId: "a", sessionId: "s", generation: 1 };
  return { root, base, home };
}
it("copies only native credentials into private storage and fails closed without login", async () => {
  const { root, base, home } = fixture();
  await seedIssueSessionNativeAntigravityHome(home, base);
  const target = join(home.home, "antigravity-cli", "antigravity-oauth-token");
  expect(readFileSync(target, "utf8")).toBe("fake-native-login");
  expect(statSync(target).mode & 0o777).toBe(0o600);
  expect(() => readFileSync(join(home.home, "antigravity-cli", "settings.json"))).toThrow();
  await expect(seedIssueSessionNativeAntigravityHome(home, join(root, "missing"))).rejects.toThrow("antigravity_login_required");
  rmSync(target); symlinkSync(join(base, "antigravity-cli", "antigravity-oauth-token"), target);
  await expect(seedIssueSessionNativeAntigravityHome(home, base)).rejects.toThrow("regular file");
});
it("keeps gateway credentials out of native execution and uses explicit ACP launch arguments", () => {
  const env = buildNativeAntigravityEnv({ home: "/isolated", shimUrl: "", model: null, daemonEnv: { AGY_LLM_GATEWAY_API_KEY: "secret", GEMINI_API_KEY: "secret", AGY_ACP_CCPA_BASE_URL: "wrong" } });
  expect(JSON.stringify(env)).not.toContain("secret");
  expect(env.AGY_ACP_CCPA_BASE_URL).toBe("");
  expect(env.GEMINI_HOME).toBe("/isolated");
  expect(nativeAntigravityLaunch("/isolated", "bypassPermissions").args).toContain("--dangerously-skip-permissions");
  expect(nativeAntigravityLaunch("/isolated", "plan").args).not.toContain("--dangerously-skip-permissions");
  expect(() => nativeAntigravityLaunch()).toThrow("home_required");
});
it("discovers models and effort, executes and resumes without a gateway", async () => {
  const { root, base, home } = fixture();
  await seedIssueSessionNativeAntigravityHome(home, base);
  const options = { agentType: "antigravity", antigravityNative: true, providerHome: home.home, cwd: root,
    executable: resolve("tests/fixtures/antigravity-native-fake.mjs"), env: { AGY_LLM_GATEWAY_URL: "https://wrong.test", AGY_LLM_GATEWAY_API_KEY: "wrong" } };
  const p = new AcpProvider(options);
  try {
    const models = await p.discoverModelCapabilities();
    expect(models.map(m => m.id)).toEqual(["native-model", "other-model"]);
    expect(models[0]?.effort?.supportedLevels.map(l => l.value)).toEqual(["low", "medium", "high"]);
    for await (const _ of p.sendStream("test", { chatId: "native", model: "other-model", effort: "high" })) {}
    expect(p.getLastResponse()?.text).toContain("other-model:high:native-ok");
  } finally { await p.close(); }
  const resumed = new AcpProvider(options);
  try {
    for await (const _ of resumed.sendStream("again", { chatId: "native", sessionId: "native-session", model: "native-model", effort: "low" })) {}
    expect(resumed.getLastResponse()?.text).toContain("native-model:low:native-ok");
  } finally { await resumed.close(); }
});
