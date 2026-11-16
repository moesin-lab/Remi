import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as testingRender, screen, waitFor } from "@testing-library/react";
import { useNavigation } from "@multiremi/views/navigation";

const build = vi.hoisted(() => ({ changed: false, idle: true }));
vi.mock("./build-continuity", () => ({ checkBuild: async () => build.changed, canRefresh: () => build.idle }));
const render = (element: React.ReactNode) => testingRender(<QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>);
const router = vi.hoisted(() => ({
  push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/acme/chat",
  useSearchParams: () => new URLSearchParams("session=s1"),
}));

import { WebNavigationProvider } from "./navigation";

function ReplaceUrlButton({ path }: { path: string }) {
  const navigation = useNavigation();
  return <button onClick={() => navigation.replaceUrl?.(path)}>replace url</button>;
}

afterEach(() => {
  vi.restoreAllMocks();
  router.replace.mockReset(); router.push.mockReset(); vi.unstubAllGlobals(); build.changed = false; build.idle = true;
});

describe("WebNavigationProvider replaceUrl", () => {
  it("replaces the history entry without a router navigation", () => {
    window.history.replaceState({ __NA: true }, "", "/acme/chat?session=s1");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const length = window.history.length;
    render(
      <WebNavigationProvider>
        <ReplaceUrlButton path="/acme/chat?session=s2" />
      </WebNavigationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "replace url" }));

    // Null state: the App Router's patched replaceState only syncs
    // usePathname/useSearchParams for entries without its own marker.
    expect(replaceState).toHaveBeenCalledWith(null, "", "/acme/chat?session=s2");
    expect(window.location.search).toBe("?session=s2");
    expect(window.history.length).toBe(length);
    expect(router.replace).not.toHaveBeenCalled();
  });
});

function NavigateButton() {
  const nav = useNavigation();
  return <button onClick={() => nav.push("/acme/issues")}>navigate</button>;
}
it("performs a document navigation to the requested target on build drift", async () => {
  build.changed = true;
  const assign = vi.fn(); vi.stubGlobal("window", { document: window.document, location: { assign }, addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window) });
  render(<WebNavigationProvider><NavigateButton /></WebNavigationProvider>);
  fireEvent.click(screen.getByText("navigate"));
  await waitFor(() => expect(assign).toHaveBeenCalledWith("/acme/issues"));
  expect(router.push).not.toHaveBeenCalled();
});
it("keeps the current document while a write is unconfirmed", async () => {
  build.changed = true; build.idle = false;
  render(<WebNavigationProvider><NavigateButton /></WebNavigationProvider>);
  fireEvent.click(screen.getByText("navigate"));
  await waitFor(() => expect(router.push).toHaveBeenCalledWith("/acme/issues", undefined));
});
