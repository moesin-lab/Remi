import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enRuntimes from "../locales/en/runtimes.json";
import { MagpieServiceSettings } from "./components/services-tab";
import { MagpiePage } from "./magpie-page";

const api = vi.hoisted(() => ({ listMembers: vi.fn(), getMagpieService: vi.fn(), updateMagpieService: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", () => ({ useWorkspacePaths: () => ({ settings: () => "/ws/settings" }) }));
vi.mock("../navigation", () => ({ AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  api.listMembers.mockResolvedValue([{ user_id: "local", role: "owner" }]);
  api.getMagpieService.mockResolvedValue({ url: null });
});
function show(canManage = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<I18nProvider locale="en" resources={{ en: { runtimes: enRuntimes } }}>
    <QueryClientProvider client={client}>{canManage && <MagpieServiceSettings />}<MagpiePage /></QueryClientProvider>
  </I18nProvider>);
}
it("saves the independent service and embeds the refreshed configuration", async () => {
  const user = userEvent.setup();
  show();
  await user.type(await screen.findByLabelText("Magpie service address"), "http://devbox:3430/");
  api.updateMagpieService.mockImplementation(async () => {
    api.getMagpieService.mockResolvedValue({ url: "http://devbox:3430/" });
    return { url: "http://devbox:3430/" };
  });
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.updateMagpieService).toHaveBeenCalledWith("ws-1", "http://devbox:3430/"));
  expect(await screen.findByTitle("Magpie")).toHaveAttribute("src", "http://devbox:3430/");
  expect(screen.getByRole("link", { name: "Open separately" })).toHaveAttribute("rel", "noopener noreferrer");
});
it("retains failed input and shows save errors", async () => {
  const user = userEvent.setup();
  api.updateMagpieService.mockRejectedValue(new Error("Permission denied"));
  show();
  await user.type(await screen.findByLabelText("Magpie service address"), "http://devbox:3430/");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
  expect(screen.getByLabelText("Magpie service address")).toHaveValue("http://devbox:3430/");
});
it("allows viewers to open Magpie without changing its service address", async () => {
  api.getMagpieService.mockResolvedValue({ url: "http://devbox:3430/" });
  show(false);
  expect(await screen.findByTitle("Magpie")).toHaveAttribute("src", "http://devbox:3430/");
  expect(screen.queryByLabelText("Magpie service address")).not.toBeInTheDocument();
});
