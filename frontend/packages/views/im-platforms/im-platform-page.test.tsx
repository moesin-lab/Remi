import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { IM_SECTIONS } from "@multiremi/core/im-platforms";
import { paths } from "@multiremi/core/paths";
import enCommon from "../locales/en/common.json";
import enIm from "../locales/en/im-platforms.json";
import { NavigationProvider } from "../navigation";
import { ImPlatformPage } from "./im-platform-page";

vi.mock("@multiremi/core/paths", async importOriginal => ({
  ...await importOriginal<typeof import("@multiremi/core/paths")>(),
  useWorkspacePaths: () => paths.workspace("acme"),
  useCurrentWorkspace: () => ({ id: "workspace-1" }),
}));
vi.mock("./feishu/overview", () => ({ FeishuOverview: () => <div data-testid="overview" /> }));
vi.mock("./feishu/bot-panels", () => ({ FeishuBotPanel: () => <div data-testid="bot" />, FeishuAccessPanel: () => <div data-testid="access" />, FeishuConversationsPanel: () => <div data-testid="conversations" /> }));
vi.mock("./feishu/message-panels", () => ({ FeishuIngestionPanel: () => <div data-testid="ingestion" />, FeishuMessagesPanel: () => <div data-testid="messages" /> }));

describe("IM platform page", () => {
  it.each(IM_SECTIONS)("mounts only the %s capability and gives every section a deep link", section => {
    render(<I18nProvider locale="en" resources={{ en: { common: enCommon, "im-platforms": enIm } }}>
      <NavigationProvider value={{ pathname: paths.workspace("acme").imPlatform("feishu", section), searchParams: new URLSearchParams(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), getShareableUrl: path => path }}>
        <ImPlatformPage platformId="feishu" section={section} />
      </NavigationProvider>
    </I18nProvider>);
    for (const item of IM_SECTIONS) {
      const link = screen.getByRole("link", { name: enIm.sections[item].title });
      expect(link).toHaveAttribute("href", paths.workspace("acme").imPlatform("feishu", item));
      if (item === section) {
        expect(link).toHaveAttribute("aria-current", "page");
        expect(screen.getByTestId(item)).toBeInTheDocument();
      } else {
        expect(link).not.toHaveAttribute("aria-current");
        expect(screen.queryByTestId(item)).not.toBeInTheDocument();
      }
    }
    expect(screen.getByRole("link", { name: "IM platforms" })).toHaveAttribute("href", "/acme/im");
  });
});
