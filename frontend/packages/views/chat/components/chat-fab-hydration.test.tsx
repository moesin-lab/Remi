import { act, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { chatKeys } from "@multiremi/core/chat/queries";
import { markRouteContentReady, resetAfterFirstScreenForTest } from "@multiremi/core/platform/use-after-first-screen";
import enChat from "../../locales/en/chat.json";
import { ChatFab } from "./chat-fab";

const state = vi.hoisted(() => ({ isOpen: true, toggle: vi.fn() }));
vi.mock("@multiremi/core/chat", () => ({ useChatStore: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/acme/im/feishu" }) }));

it("hydrates a persisted closed chat when the server default is open", async () => {
  resetAfterFirstScreenForTest();
  const client = new QueryClient();
  client.setQueryData(chatKeys.sessions("workspace-1"), []);
  client.setQueryData(chatKeys.pendingTasks("workspace-1"), { tasks: [] });
  const view = <QueryClientProvider client={client}>
    <I18nProvider locale="en" resources={{ en: { chat: enChat } }}><ChatFab /></I18nProvider>
  </QueryClientProvider>;
  const container = document.createElement("div");
  document.body.append(container);
  state.isOpen = true;
  container.innerHTML = renderToString(view);
  state.isOpen = false;
  const onRecoverableError = vi.fn();
  let root: Root | undefined;
  try {
    await act(async () => { root = hydrateRoot(container, view, { onRecoverableError }); });
    expect(container.querySelector("button")).toBeNull();
    act(() => { markRouteContentReady("/acme/im/feishu"); });
    await waitFor(() => expect(container.querySelector("button")).not.toBeNull());
    expect(onRecoverableError).not.toHaveBeenCalled();
  } finally {
    await act(async () => root?.unmount());
    container.remove();
    client.clear();
    resetAfterFirstScreenForTest();
  }
});
