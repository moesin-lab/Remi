import type { ExternalChatOperation, ExternalChatRpcResult } from "@multiremi/contracts/external-chats.js";
import { EXTERNAL_CHAT_RPC_MAX_BYTES } from "@multiremi/contracts/external-chats.js";
import type { DaemonProtocolClient } from "./daemon-protocol-client.js";

export interface NativeExternalChatDriver {
  request(operation: ExternalChatOperation): Promise<ExternalChatRpcResult>;
  close(): Promise<void>;
}

/** One Codex lane owns native access; co-resident providers cannot answer its RPC. */
export function registerDaemonExternalChats(
  protocol: DaemonProtocolClient,
  runtimeId: () => string | undefined,
  createDriver: () => NativeExternalChatDriver,
): { close(): Promise<void> } {
  let driver: NativeExternalChatDriver | null = null;
  let stopped = false;

  const detach = protocol.onFrame(async frame => {
    if (stopped || frame.type !== "external_chat.request" || !frame.id || !frame.rt || frame.rt !== runtimeId()) return;

    let result: ExternalChatRpcResult;
    try {
      driver ??= createDriver();
      result = await driver.request(frame.payload as unknown as ExternalChatOperation);
      if (Buffer.byteLength(JSON.stringify(result)) > EXTERNAL_CHAT_RPC_MAX_BYTES) {
        result = { ok: false, code: "external_chat_response_too_large", message: "Native history page exceeds the transport budget; request a smaller page" };
      }
    } catch {
      // Native errors may contain source config or input. Only the driver's
      // deliberately normalized errors may cross the machine boundary.
      const write = ["send", "respond", "interrupt"].includes(String(frame.payload.operation));
      result = { ok: false, code: "external_chat_failed", message: "Native Codex request failed",
        ...(write ? { outcome: "unknown" as const } : {}) };
    }

    if (!stopped) protocol.send({ t: "res", re: frame.id, rt: frame.rt, p: result });
  });

  return {
    async close() {
      stopped = true;
      detach();
      await driver?.close();
      driver = null;
    },
  };
}
