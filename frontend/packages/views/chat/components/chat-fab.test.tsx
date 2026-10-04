import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { fireEvent, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChatFab } from "./chat-fab";

const chat = vi.hoisted(() => ({ isOpen: true, toggle: vi.fn() }));
vi.mock("@multiremi/core/chat", () => ({ useChatStore: (selector: (state: typeof chat) => unknown) => selector(chat) }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({}) }));
vi.mock("@multiremi/core/chat/queries", () => ({ chatSessionsOptions: () => ({}), pendingChatTasksOptions: () => ({}) }));
vi.mock("@multiremi/core/platform/use-after-first-screen", () => ({ useAfterFirstScreen: () => false }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/execution-groups" }) }));
vi.mock("../../i18n", () => ({ useT: () => ({ t: () => "Open chat" }) }));
vi.mock("@multiremi/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, ...props }: React.ComponentProps<"button">) => <button {...props}>{children}</button>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

it("hydrates a saved minimized preference without replacing the server-rendered shell", async () => {
  chat.isOpen = true; // Server cannot read the browser's saved preference.
  const container = document.createElement("div");
  container.innerHTML = renderToString(<ChatFab />);
  document.body.append(container);
  chat.isOpen = false;
  const errors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => { root = hydrateRoot(container, <ChatFab />, { onRecoverableError: error => errors.push(error) }); });
    expect(errors).toEqual([]);
    fireEvent.click(within(container).getByRole("button"));
    expect(chat.toggle).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root?.unmount());
    container.remove();
    chat.isOpen = true;
  }
});
