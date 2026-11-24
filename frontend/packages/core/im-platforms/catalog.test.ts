import { describe, expect, it } from "vitest";
import { getImPlatform, legacyImDestination, resolveImSection } from "./catalog";
import { paths } from "../paths/paths";

describe("IM platform navigation", () => {
  it("accepts only registered platforms and supported single-level sections", () => {
    const feishu = getImPlatform("feishu")!;
    expect(getImPlatform("discord")).toBeUndefined();
    expect(getImPlatform("__proto__")).toBeUndefined();
    expect(resolveImSection(feishu)).toBe("overview");
    expect(resolveImSection(feishu, ["bot"])).toBe("bot");
    expect(resolveImSection(feishu, ["unknown"])).toBeUndefined();
    expect(resolveImSection(feishu, ["bot", "extra"])).toBeUndefined();
  });

  it("keeps platform navigation within the selected workspace", () => {
    expect(paths.workspace("team / one").imPlatform("feishu", "messages")).toBe("/team%20%2F%20one/im/feishu/messages");
    expect(paths.workspace("acme").imPlatform("feishu")).toBe("/acme/im/feishu");
    expect(paths.workspace("other").imPlatforms()).toBe("/other/im");
  });

  it("migrates retired settings tabs without intercepting other settings", () => {
    expect(legacyImDestination("integrations")).toEqual({ platform: "feishu", section: "bot" });
    expect(legacyImDestination("lark")).toEqual({ platform: "feishu", section: "bot" });
    expect(legacyImDestination("feishu-messages")).toEqual({ platform: "feishu", section: "messages" });
    for (const value of [null, "platform", "workspace", "notifications", "unknown"]) expect(legacyImDestination(value)).toBeUndefined();
  });
});
