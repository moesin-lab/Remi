import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ApiClient, ApiError, WSClient, setApiInstance } from "@multiremi/core/api";
import { deliveryTargetsOptions } from "@multiremi/core/autopilots/queries";
import { defaultStorage, setCurrentWorkspace } from "@multiremi/core/platform";
import { createAuthStore, registerAuthStore } from "@multiremi/core/auth";
import { useRealtimeSync } from "@multiremi/core/realtime";
import { renderWithI18n } from "../../test/i18n";
import { DeliveryTarget } from "./delivery-target";

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace" }));

it.each(["archive", "delete", "access"])("revalidates the open picker after %s without changing focus", async change => {
  const client = new ApiClient("/api");
  const targets = [{ id: "chat", title: "Private report", channel: "web_chat" as const }];
  const read = vi.spyOn(client, "listAutopilotDeliveryTargets").mockResolvedValue({ targets });
  setApiInstance(client);
  const qc = new QueryClient();
  const otherKey = deliveryTargetsOptions("other").queryKey;
  qc.setQueryData(otherKey, { targets });
  setCurrentWorkspace("slug", "workspace");
  const authStore = createAuthStore({ api: client, storage: defaultStorage });
  registerAuthStore(authStore);
  const socket = new WSClient("ws://localhost");
  const subscriptions = vi.spyOn(socket, "on");
  function Editor() {
    useRealtimeSync(socket, { authStore });
    return <DeliveryTarget value="chat" onChange={() => {}} />;
  }
  const view = renderWithI18n(<QueryClientProvider client={qc}><Editor /></QueryClientProvider>);
  try {
    fireEvent.click(screen.getByRole("button", { name: "Choose delivery Chat" }));
    await screen.findByRole("button", { name: /Private report/ });
    let respond!: (response: { targets: typeof targets }) => void;
    let deny!: (reason: Error) => void;
    read.mockImplementationOnce(() => new Promise((resolve, reject) => { respond = resolve; deny = reject; }));
    act(() => {
      const event = change === "access" ? "member:updated" : change === "archive" ? "chat:session_updated" : "chat:session_deleted";
      const handler = subscriptions.mock.calls.find(([name]) => name === event)?.[1];
      if (!handler) throw new Error(`Missing subscription for ${event}`);
      handler(change === "access" ? { member: { workspace_id: "workspace" } } : { chat_session_id: "chat", status: "archived" });
    });
    await waitFor(() => expect(screen.queryAllByText(/Private report/)).toHaveLength(0));
    expect(screen.getByRole("textbox")).toBeVisible();
    if (change === "access") {
      act(() => deny(new ApiError("Forbidden", 403, "Forbidden")));
      await screen.findByText(/permission.*chat/i);
    } else {
      act(() => respond({ targets: [] }));
      await screen.findByText("Target unavailable · chat");
    }
    expect(screen.queryByRole("button", { name: /Private report/ })).toBeNull();
    expect(qc.getQueryState(otherKey)?.isInvalidated).toBe(false);
  } finally {
    view.unmount();
    qc.clear();
    setCurrentWorkspace(null, null);
  }
});
