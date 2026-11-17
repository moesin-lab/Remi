import { describe, expect, it } from "bun:test";
import { DEFAULT_CO_AUTHORED_BY, formatCoAuthoredByTrailer, resolveCoAuthoredByIdentity, validateCoAuthoredByEmail, validateCoAuthoredByName } from "@multiremi/contracts/co-authored-by";

describe("co-authored-by contracts", () => {
  it("trims valid identities and formats trailers", () => {
    expect(validateCoAuthoredByName("  张三 😀  ")).toEqual({ ok: true, value: "张三 😀" });
    expect(validateCoAuthoredByEmail("  a+b@example.test  ")).toEqual({ ok: true, value: "a+b@example.test" });
    expect(formatCoAuthoredByTrailer(DEFAULT_CO_AUTHORED_BY)).toBe(`Co-authored-by: ${DEFAULT_CO_AUTHORED_BY.name} <${DEFAULT_CO_AUTHORED_BY.email}>`);
    expect(validateCoAuthoredByName("😀".repeat(100)).ok).toBe(true);
    expect(validateCoAuthoredByEmail("a".repeat(249) + "@a.co").ok).toBe(true);
  });
  it.each(["", "   ", "a\nb", "a\tb", "a\rb", "a\x7fb", "a\x00b", "<name>", "😀".repeat(101)])("rejects invalid name %j", value => {
    expect(validateCoAuthoredByName(value).ok).toBe(false);
  });
  it.each(["", " ", "a\nb@example.test", "a\tb@example.test", "<a@example.test>", "a".repeat(250) + "@a.co", "abc", "a@localhost", "a b@example.test", "a@-a.test", "a@a-.test", "a@a..test", 'a"b@example.test'])("rejects invalid email %j", value => {
    expect(validateCoAuthoredByEmail(value).ok).toBe(false);
  });
  it("resolves defaults independently for absent, null, and invalid legacy fields", () => {
    for (const value of [undefined, null, 123, "", "bad\nvalue"]) {
      expect(resolveCoAuthoredByIdentity({ co_authored_by_name: value, co_authored_by_email: value })).toEqual(DEFAULT_CO_AUTHORED_BY);
    }
    expect(resolveCoAuthoredByIdentity({ co_authored_by_name: " Custom " })).toEqual({ ...DEFAULT_CO_AUTHORED_BY, name: "Custom" });
    expect(resolveCoAuthoredByIdentity({ co_authored_by_email: " custom@example.test " })).toEqual({ ...DEFAULT_CO_AUTHORED_BY, email: "custom@example.test" });
    expect(resolveCoAuthoredByIdentity({})).toEqual(DEFAULT_CO_AUTHORED_BY);
  });
});
