import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ApiError } from "@multiremi/core/api";
import { renderWithI18n } from "../../test/i18n";
import { DeliveryTarget } from "./delivery-target";

const result = vi.hoisted(() => vi.fn());
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@tanstack/react-query", () => ({ queryOptions: (options: unknown) => options, useQuery: result }));
const targets = [{ id: "first", title: "Daily", channel: "web_chat" }, { id: "second", title: "Daily", channel: "feishu" }];
function Editor() {
  const [value, setValue] = useState<string | null>("first");
  return <DeliveryTarget value={value} onChange={setValue} />;
}

describe("report delivery", () => {
  it("distinguishes a legacy missing field, an explicit null and an unavailable target", () => {
    result.mockReturnValue({ isSuccess: true, data: { targets: [] } });
    const view = renderWithI18n(<DeliveryTarget value={undefined} />);
    expect(screen.getByText("Delivery configuration unknown")).toBeVisible();
    view.rerender(<DeliveryTarget value={null} />);
    expect(screen.getByText(/No report is sent/)).toBeVisible();
    view.rerender(<DeliveryTarget value="archived" />);
    expect(screen.getByText("Target unavailable · archived")).toBeVisible();
  });

  it("hides cached titles on permission loss and retains the ID", () => {
    result.mockReturnValue({ isError: true, data: { targets }, error: new ApiError("Denied", 403, "Forbidden") });
    renderWithI18n(<DeliveryTarget value="first" />);
    expect(screen.getByText(/permission.*first/)).toBeVisible();
    expect(screen.queryByText(/Daily/)).toBeNull();
  });

  it("filters duplicate names by channel, selects by keyboard and clears explicitly", () => {
    result.mockReturnValue({ isSuccess: true, data: { targets } });
    renderWithI18n(<Editor />);
    expect(screen.getByText("Daily · Web Chat · first")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Choose delivery Chat" }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Feishu" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("Daily · Feishu · second")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear delivery target" }));
    expect(screen.getByText(/No report is sent/)).toBeVisible();
  });
});
