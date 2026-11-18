import { describe, expect, it } from "bun:test";
import { DAEMON_PROTOCOL_CAPS } from "@multiremi/contracts/daemon-protocol.js";
import { DAEMON_CAPABILITY_REGISTRY, daemonCapabilityName, hasDaemonCapability } from "@multiremi/contracts/daemon-compatibility.js";
import { negotiateWelcomeCaps } from "@multiremi/api/daemon-protocol/handshake.js";

describe("named daemon capabilities", () => {
  it("registers every advertised bit and accepts every alias", () => {
    for (const cap of DAEMON_PROTOCOL_CAPS) expect(daemonCapabilityName(cap)).not.toBeNull();
    for (const [name, { aliases }] of Object.entries(DAEMON_CAPABILITY_REGISTRY)) {
      for (const alias of aliases) {
        expect(hasDaemonCapability([alias], name)).toBe(true);
        expect(hasDaemonCapability([name], alias)).toBe(true);
      }
    }
    expect(hasDaemonCapability([], "input.unread")).toBe(false);
    expect(hasDaemonCapability(["future"], "future")).toBe(false);
  });
  it("echoes the peer spelling, ignores unknown caps, and supports old server overrides", () => {
    expect(negotiateWelcomeCaps(["input.unread", "lane.background", "future"])).toEqual(["input.unread", "lane.background"]);
    expect(negotiateWelcomeCaps(["input_unread"], ["input.unread"])).toEqual(["input_unread"]);
    expect(negotiateWelcomeCaps(["lane.background"], [])).toEqual([]);
  });
});
