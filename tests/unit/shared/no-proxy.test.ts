import { describe, expect, it } from "bun:test";
import { matchesNoProxy, shouldBypassProxy } from "@shared/no-proxy.js";

describe("NO_PROXY matching", () => {
  const cases: [string, string, boolean][] = [
    ["http://10.36.0.223:16120", "10.0.0.0/8", true],
    ["https://github.com", "10.0.0.0/8", false],
    ["http://11.0.0.1", "10.0.0.0/8", false],
    ["http://10.255.255.255", "10.0.0.0/8", true],
    ["http://[fd12:3456::1]:6120", "fd00::/8", true],
    ["http://[fe80::1]", "fd00::/8", false],
    ["http://[2001:db8::1]", "2001:db8::/32", true],
    ["http://[::1]:6120", "[::1]:6120", true],
    ["http://[::1]:6121", "[::1]:6120", false],
    ["http://[0:0:0:0:0:0:0:1]", "::1", true],
    ["https://api.example.com", ".EXAMPLE.com", true],
    ["https://example.com", ".example.com", true],
    ["https://badexample.com", ".example.com", false],
    ["https://example.com.evil.test", "example.com", false],
    ["https://example.com", "example.com:443", true],
    ["http://example.com", "example.com:443", false],
    ["https://github.com", "*", true],
    ["http://10.36.0.223", " , invalid/8,10.0.0.0/33,::/129,10.0.0.0/-1,", false],
    ["http://10.36.0.223", "0.0.0.0/0", true],
    ["http://localhost", "127.0.0.0/8", false],
  ];
  for (const [url, list, expected] of cases) {
    it(`${url} against ${list}`, () => expect(matchesNoProxy(url, list)).toBe(expected));
  }
  it("uses lowercase precedence, including an explicitly empty value", () => {
    expect(shouldBypassProxy("http://10.36.0.223", { no_proxy: "10.0.0.0/8" })).toBe(true);
    expect(shouldBypassProxy("https://github.com", { NO_PROXY: "10.0.0.0/8" })).toBe(false);
    expect(shouldBypassProxy("http://10.36.0.223", { no_proxy: "", NO_PROXY: "*" })).toBe(false);
  });
});

// WebSocket default ports must use the same port-qualified matching as HTTP.
it("matches default WebSocket ports", () => {
  expect(matchesNoProxy("wss://api.example", "api.example:443")).toBe(true);
  expect(matchesNoProxy("ws://api.example", "api.example:80")).toBe(true);
  expect(matchesNoProxy("wss://api.example", "api.example:80")).toBe(false);
});
