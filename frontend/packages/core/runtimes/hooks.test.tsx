/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { runtimeKeys } from "./queries";
import { useMyRuntimesNeedUpdate, useUpdatableRuntimeIds } from "./hooks";

describe("shared workspace Runtime updates", () => {
  it("includes Runtimes from different historical owners without offering desktop or cloud updates", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const runtime = (id: string, owner_id: string) => ({
      id, owner_id, runtime_mode: "local", metadata: { cli_version: "1.0.0" },
    });
    client.setQueryData(runtimeKeys.list("workspace"), [
      runtime("first", "account-a"), runtime("second", "account-b"),
      { ...runtime("desktop", "account-c"), metadata: { cli_version: "1.0.0", launched_by: "desktop" } },
      { ...runtime("cloud", "account-d"), runtime_mode: "cloud" },
      { ...runtime("current", "account-e"), metadata: { cli_version: "2.0.0" } },
    ]);
    client.setQueryData(runtimeKeys.latestVersion(), "2.0.0");
    const hook = renderHook(() => ({
      needed: useMyRuntimesNeedUpdate("workspace"), ids: useUpdatableRuntimeIds("workspace"),
    }), { wrapper: ({ children }: { children: ReactNode }) =>
      <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    expect(hook.result.current.needed).toBe(true);
    expect([...hook.result.current.ids]).toEqual(["first", "second"]);
    hook.unmount(); client.clear();
  });
});
