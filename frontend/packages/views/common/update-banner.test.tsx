import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpdateBanner } from "./update-banner";
import en from "../locales/en/common.json";
vi.mock("../i18n", () => ({ useT: () => ({ t: (select: (data: typeof en) => string) => select(en) }) }));
describe("global update banner", () => {
  it("covers draining, switching, ready and pending-write states", () => {
    const refresh = vi.fn();
    const { rerender } = render(<UpdateBanner state="draining" />);
    expect(screen.getByRole("status")).toHaveTextContent("Preparing an update");
    rerender(<UpdateBanner state="switching" />);
    expect(screen.getByRole("status")).toHaveTextContent("Messages will send");
    rerender(<UpdateBanner state="updated" busy onRefresh={refresh} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for pending messages");
    rerender(<UpdateBanner state="updated" onRefresh={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledOnce();
    rerender(<UpdateBanner state={null} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
