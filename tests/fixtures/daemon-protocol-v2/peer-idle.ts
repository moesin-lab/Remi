import type { PeerChannel } from "../../../packages/server/src/api/peer/peer-channel.js";

/** Setup is settled only after every queued or frozen batch has an HTTP ACK. */
export async function waitForPeerIdle(peer: PeerChannel, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (peer.stats().queued || peer.stats().inflight) {
    if (Date.now() >= deadline) throw new Error(`${label}: ${JSON.stringify(peer.stats())}`);
    await Bun.sleep(5);
  }
}
