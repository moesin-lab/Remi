import { describe, expect, spyOn, test } from "bun:test";
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
  test("timer TypeError rejections are visible and later ticks run without an unhandled rejection", async () => {
    const child = Bun.spawn([process.execPath, "-e", `
      import { DatabaseRetryLoop } from "./packages/shared/src/db/recovery.ts";
      let calls = 0;
      const loop = new DatabaseRetryLoop("bug", async () => {
        if (++calls === 1) throw new TypeError("programming-error-sentinel");
        loop.stop();
      }, 1, 5, 15);
      loop.start(1);
      setTimeout(() => process.exit(calls === 2 ? 0 : 1), 200);
    `], { stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    const output = await stderr;
    expect(output).toContain("ERROR");
    expect(output).toContain("bug: unexpected maintenance error");
    expect(output).toContain("TypeError: programming-error-sentinel");
    expect(output).not.toContain("database unavailable");
  });

  test("unexpected errors preserve database backoff until a successful tick resets it", async () => {
    const bug = new TypeError("bug");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const timers = spyOn(globalThis, "setTimeout");
    let calls = 0;
    const loop = new DatabaseRetryLoop("mixed", () => {
      calls++;
      if ([1, 3, 5].includes(calls)) throw new DatabaseUnavailableError();
      if (calls === 2) throw bug;
      if (calls === 6) loop.stop();
    }, 7, 11, 55);
    try {
      loop.start();
      await until(() => calls === 6);
      // Ignore until()'s 2ms polling timer. The bug neither increments nor
      // resets the outage counter; success on tick 4 resets it for tick 5.
      expect(timers.mock.calls.map(call => call[1]).filter(delay => delay !== 2)).toEqual([11, 55, 22, 7, 11]);
      expect(errors.mock.calls).toHaveLength(1);
      expect(errors.mock.calls[0]![0]).toContain("mixed: unexpected maintenance error");
      expect(errors.mock.calls[0]![1]).toBe(bug);
    } finally { loop.stop(); timers.mockRestore(); errors.mockRestore(); }
  });

  test("a broken interval callback is reported and retried without consulting it again", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const timers = spyOn(globalThis, "setTimeout");
    let calls = 0;
    let intervalCalls = 0;
    const bug = new TypeError("interval bug");
    const loop = new DatabaseRetryLoop("interval", () => {
      if (++calls === 2) loop.stop();
    }, () => { intervalCalls++; throw bug; }, 5, 25);
    try {
      loop.start();
      await until(() => calls === 2);
      expect(intervalCalls).toBe(1);
      expect(timers.mock.calls.map(call => call[1]).filter(delay => delay !== 2)).toEqual([25]);
      expect(errors.mock.calls[0]![1]).toBe(bug);
    } finally { loop.stop(); timers.mockRestore(); errors.mockRestore(); }
  });

  for (const restart of [false, true]) {
    test(`a late TypeError after stop${restart ? "/restart" : ""} is reported without rearming`, async () => {
      const errors = spyOn(console, "error").mockImplementation(() => {});
      let reject!: (reason: unknown) => void;
      let calls = 0;
      const bug = new TypeError("late bug");
      const loop = new DatabaseRetryLoop("late", () => {
        calls++;
        return new Promise<void>((_resolve, fail) => { reject = fail; });
      }, 1, 5, 15);
      try {
        loop.start();
        loop.stop();
        if (restart) loop.start(100);
        reject(bug);
        await Bun.sleep(40);
        expect(calls).toBe(1);
        expect(errors.mock.calls).toHaveLength(1);
        expect(errors.mock.calls[0]![1]).toBe(bug);
        if (restart) {
          await until(() => calls === 2);
          loop.stop();
          reject(bug);
          await Bun.sleep(25);
          expect(calls).toBe(2);
        }
      } finally { loop.stop(); errors.mockRestore(); }
    });
  }

});
