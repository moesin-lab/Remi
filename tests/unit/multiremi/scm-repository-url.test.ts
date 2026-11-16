import { describe, expect, it } from "bun:test";
import { scmRepositoryIdentityKey, resolveScmRepositoryRemote } from "@multiremi/scm/repository-url.js";

describe("SCM repository URL trust boundary", () => {
  it("accepts GitHub and Codebase HTTPS and SSH remotes on their connection hosts", () => {
    expect(resolveScmRepositoryRemote(
      "https://github.com:443/acme/widgets.git",
      "https://github.com",
    )).toEqual({
      cloneUrl: "https://github.com/acme/widgets.git",
      host: "github.com",
      transport: "https",
    });
    expect(resolveScmRepositoryRemote(
      "git@github.com:acme/widgets.git",
      "https://github.com",
    ).cloneUrl).toBe("https://github.com/acme/widgets.git");
    expect(resolveScmRepositoryRemote(
      "https://code.byted.org/acme/widgets.git",
      "https://code.byted.org",
    ).cloneUrl).toBe("https://code.byted.org/acme/widgets.git");
    expect(resolveScmRepositoryRemote(
      "ssh://git@code.byted.org:22/acme/widgets.git",
      "https://code.byted.org",
    ).cloneUrl).toBe("https://code.byted.org/acme/widgets.git");
  });

  it("supports enterprise origins while preserving custom HTTPS ports", () => {
    expect(resolveScmRepositoryRemote(
      "https://git.enterprise.example:8443/acme/widgets.git",
      "https://git.enterprise.example:8443",
    ).cloneUrl).toBe("https://git.enterprise.example:8443/acme/widgets.git");
    expect(resolveScmRepositoryRemote(
      "git@git.enterprise.example:acme/widgets.git",
      "https://git.enterprise.example:8443",
    ).cloneUrl).toBe("https://git.enterprise.example:8443/acme/widgets.git");
  });

  it("rejects cross-origin HTTPS, cross-host SSH, and custom SSH ports", () => {
    expect(() => resolveScmRepositoryRemote(
      "https://evil.example/acme/widgets.git",
      "https://github.com",
    )).toThrow("HTTPS origin does not match");
    expect(() => resolveScmRepositoryRemote(
      "ssh://git@evil.example/acme/widgets.git",
      "https://github.com",
    )).toThrow("SSH host does not match");
    expect(() => resolveScmRepositoryRemote(
      "ssh://git@github.com:2222/acme/widgets.git",
      "https://github.com",
    )).toThrow("must not use a custom port");
    expect(() => resolveScmRepositoryRemote(
      "https://git.enterprise.example/acme/widgets.git",
      "https://git.enterprise.example:8443",
    )).toThrow("HTTPS origin does not match");
  });
});

it("uses one security identity for HTTPS, SSH, user, port and case variants", () => {
  for (const url of ['https://github.com/Acme/Widgets.git/', 'git@github.com:acme/widgets.git',
    'ssh://another@GITHUB.com:2222/ACME/Widgets', 'https://user@github.com:8443/acme/widgets/']) {
    expect(scmRepositoryIdentityKey(url)).toBe('github.com/acme/widgets');
  }
  expect(scmRepositoryIdentityKey('https://github.com/acme/other.git')).not.toBe('github.com/acme/widgets');
});
