import { beforeEach, expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
vi.mock("@multiremi/views/chat", () => ({ ChatPage: () => null }));
vi.mock("../../../../features/chat/server-log", () => ({ readChatLogBootstrap: read }));
import ChatRoute from "./page";
beforeEach(() => read.mockReset());

it.each(["external", ["external", "other"]])("does not bootstrap a Remi log when the native route also contains a session query", async kind => {
  const element = await ChatRoute({ params: Promise.resolve({ workspaceSlug: "ws" }), searchParams: Promise.resolve({ kind, session: "remi-must-not-read" }) });
  expect(read).not.toHaveBeenCalled();
  expect(element.props.initialSessionId).toBeUndefined();
  expect(element.props.initialLog).toBeUndefined();
});

it("keeps the existing Remi session bootstrap", async () => {
  read.mockResolvedValue({ sessionId: "remi", window: { entries: [] } });
  const element = await ChatRoute({ params: Promise.resolve({ workspaceSlug: "ws" }), searchParams: Promise.resolve({ session: "remi" }) });
  expect(read).toHaveBeenCalledWith("ws", "remi");
  expect(element.props.initialSessionId).toBe("remi");
});
