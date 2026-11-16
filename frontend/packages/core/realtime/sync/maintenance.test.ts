import { expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createPrefixRefresh } from "./prefix-refresh";
import type { SyncContext } from "./types";
import { platformLifecycleKeys } from "../../platform-lifecycle/queries";
it("invalidates global maintenance immediately without the daemon aggregate refresh", () => {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const refresh = createPrefixRefresh({ qc } as SyncContext);
  refresh.onAny({ type: "daemon:maintenance_changed", payload: {} });
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: platformLifecycleKeys.status() });
  refresh.dispose();
});
