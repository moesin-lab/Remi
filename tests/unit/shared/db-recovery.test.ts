import { describe, expect, test } from "bun:test";
import { DatabaseRetryLoop, DatabaseUnavailableError, isDatabaseConnectionError } from "@shared/db/recovery.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("retry loop did not progress");
    await Bun.sleep(2);
  }
}

describe("database recovery boundaries", () => {
  test("only connection errors qualify for retry", () => {
    for (const code of ["08006", "57P01", "57P03", "ECONNREFUSED", "ERR_POSTGRES_CONNECTION_CLOSED"]) {
      expect(isDatabaseConnectionError(Object.assign(new Error("opaque"), { code }))).toBe(true);
    }
    for (const error of [new TypeError("bug"), new Error("connection text alone"), { code: "23505" }, { code: "42601" }]) {
      expect(isDatabaseConnectionError(error)).toBe(false);
    }
  });

  test("backs off to a cap, resets after recovery, and cancels retries on stop", async () => {
    const calls: number[] = [];
    let available = false;
    const loop = new DatabaseRetryLoop("test", () => {
      calls.push(performance.now());
      if (!available) throw new DatabaseUnavailableError();
    }, 8, 15, 40);
    try {
      loop.start();
      await until(() => calls.length >= 5);
      const gaps = calls.slice(1).map((at, i) => at - calls[i]!);
      expect(gaps[0]).toBeGreaterThanOrEqual(12);
      expect(gaps[1]).toBeGreaterThanOrEqual(26);
      expect(gaps[2]).toBeGreaterThanOrEqual(35);
      expect(gaps[3]).toBeLessThan(100);
      available = true;
      await until(() => calls.length >= 8);
      expect(calls.at(-1)! - calls.at(-2)!).toBeLessThan(30);
    } finally { loop.stop(); }
    const stoppedAt = calls.length;
    await Bun.sleep(60);
    expect(calls.length).toBe(stoppedAt);
  });

  test("a stopped in-flight tick cannot rearm the loop", async () => {
    let release!: () => void;
    let count = 0;
    const loop = new DatabaseRetryLoop("test", async () => {
      count++;
      await new Promise<void>(resolve => { release = resolve; });
    }, 1);
    loop.start();
    loop.stop();
    release();
    await Bun.sleep(20);
    expect(count).toBe(1);
  });

  test("the real PG worker preserves connection-refused classification", () => {
    // Reserve then release a port, guaranteeing no intentional database dependency.
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop(true);
    expect(() => new PostgresSyncDatabase(`postgres://test:test@127.0.0.1:${port}/test`)).toThrow(DatabaseUnavailableError);
  });
  test("timer programming errors remain fatal instead of becoming retries", async () => {
    const child = Bun.spawn([process.execPath, "-e", `
      import { DatabaseRetryLoop } from "./packages/shared/src/db/recovery.ts";
      new DatabaseRetryLoop("bug", () => { throw new TypeError("programming-error-sentinel"); }, 1).start();
      setTimeout(() => process.exit(0), 1000);
    `], { stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(await stderr).toContain("programming-error-sentinel");
  });

});
