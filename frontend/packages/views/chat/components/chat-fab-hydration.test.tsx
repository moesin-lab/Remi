import { act } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enChat from "../../locales/en/chat.json";
import { ChatFab } from "./chat-fab";

const state = vi.hoisted(() => ({ isOpen: true, toggle: vi.fn() }));
vi.mock("@multiremi/core/chat", () => ({ useChatStore: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multiremi/core/platform/use-after-first-screen", () => ({ useAfterFirstScreen: () => false }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/acme/im/feishu" }) }));

it("hydrates a persisted closed chat when the server default is open", async () => {
  const client = new QueryClient();
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
    expect(container.querySelector("button")).not.toBeNull();
    expect(onRecoverableError).not.toHaveBeenCalled();
  } finally {
    await act(async () => root?.unmount());
    container.remove();
    client.clear();
  }
});
