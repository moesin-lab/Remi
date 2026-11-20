import { expect, it } from "bun:test";
import { createPeerChannel } from "../../../packages/server/src/api/peer/peer-channel.js";
import { waitForPeerIdle } from "../../fixtures/daemon-protocol-v2/peer-idle.js";

it("keeps the setup barrier closed through a frozen retry until the peer acknowledges it", async () => {
  const first = Promise.withResolvers<Response>();
  const retry = Promise.withResolvers<Response>();
  const firstStarted = Promise.withResolvers<void>();
  const retryStarted = Promise.withResolvers<void>();
  let calls = 0;
  const peer = createPeerChannel({ url: "http://fixture-peer", secret: "fixture", minBackoffMs: 1,
    fetchImpl: () => {
      if (++calls === 1) { firstStarted.resolve(); return first.promise; }
      retryStarted.resolve(); return retry.promise;
    } });
  let settled = false;
  let barrier: Promise<void> | undefined;
  try {
    peer.publish("setup", { ready: true });
    await firstStarted.promise;
    // An empty queue is insufficient: its batch is still awaiting an ACK.
    expect(peer.stats()).toMatchObject({ queued: 0, inflight: 1 });
    barrier = waitForPeerIdle(peer, "setup peer").then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    first.reject(new Error("controlled setup transport failure"));
    await retryStarted.promise;
    expect(peer.stats()).toMatchObject({ queued: 0, inflight: 1, failed: 1 });
    expect(settled).toBe(false);
    retry.resolve(Response.json({ accepted: 1 }));
    await barrier;
    expect(settled).toBe(true);
    expect(peer.stats()).toMatchObject({ queued: 0, inflight: 0, sent: 1, dropped: 0 });
  } finally {
    first.resolve(Response.json({ accepted: 1 }));
    retry.resolve(Response.json({ accepted: 1 }));
    peer.close();
    await barrier;
  }
});
