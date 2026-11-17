import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { DatabaseUnavailableError } from "@shared/db/recovery.js";
import { MultiremiStore } from "@multiremi/store.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";

let closeDatabase: (() => void) | undefined;
afterEach(() => { mock.restore(); closeDatabase?.(); closeDatabase = undefined; });

it("charges one readiness query on cold/expired requests and bypasses the cache for readiness and outages", async () => {
  const db = openSqliteDatabase(":memory:");
  closeDatabase = () => db.close();
  const store = new MultiremiStore(db);
  const app = createMultiremiApp({ store, authToken: "readiness-test" });
  let now = Date.now();
  spyOn(Date, "now").mockImplementation(() => now);
  const query = db.query.bind(db);
  let probes = 0;
  let unavailable = false;
  Object.defineProperty(db, "connectionUnavailable", { configurable: true, get: () => unavailable });
  spyOn(db, "query").mockImplementation(sql => {
    if (sql === "SELECT 1 AS ready") {
      probes++;
      if (unavailable) throw new DatabaseUnavailableError();
    }
    return query(sql);
  });
  const request = (path = "/favicon.ico") => app.request(path);
  expect((await request()).status).toBe(204);
  expect(probes).toBe(1);
  expect((await request()).status).toBe(204);
  expect(probes).toBe(1);
  now += 999;
  expect((await request()).status).toBe(204);
  expect(probes).toBe(1);
  now++;
  expect((await request()).status).toBe(204);
  expect(probes).toBe(2);
  expect((await request("/readyz")).status).toBe(200);
  expect(probes).toBe(3);
  unavailable = true;
  const failure = await request();
  expect(failure.status).toBe(503);
  expect(failure.headers.get("Retry-After")).toBe("1");
  expect(probes).toBe(4);
  // A failed probe must invalidate the previous successful TTL.
  unavailable = false;
  expect((await request()).status).toBe(204);
  expect(probes).toBe(5);
  expect((await request()).status).toBe(204);
  expect(probes).toBe(5);
});
