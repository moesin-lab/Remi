import { afterEach, expect, test } from "bun:test";
import {
  acquireTransactionLock,
  invalidatingDatabase,
  memoizeRequestRead,
  markRequestReadCacheLockTaken,
  withSynchronousRequestReadCache,
} from "@multiremi/store/request-read-cache.js";
import {
  notifyTurnChanged,
  registerTurnChangeHook,
  withTurnChangeBatch,
} from "@multiremi/store/turn-execution-records.js";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function database() {
  const opened = await openHotspotDatabase();
  cleanups.push(opened.dispose);
  return invalidatingDatabase(opened.db);
}

test("reuses transaction locks, reacquires rolled-back savepoint locks and releases at commit", async () => {
  const db = await database();
  let acquisitions = 0;
  const lock = (key: string) => acquireTransactionLock(db, key, () => { acquisitions++; });
  db.transaction(() => {
    lock("outer");
    db.transaction(() => { lock("outer"); lock("committed-inner"); })();
    lock("committed-inner");
    expect(acquisitions).toBe(2);
    expect(() => db.savepoint!(() => {
      lock("outer"); lock("rolled-back"); throw new Error("rollback");
    })).toThrow("rollback");
    lock("outer"); lock("rolled-back");
    expect(acquisitions).toBe(4);
    expect(() => db.transaction(() => { lock("nested-rollback"); throw new Error("rollback"); })()).toThrow("rollback");
    lock("nested-rollback");
    expect(acquisitions).toBe(6);
  })();
  db.transaction(() => { lock("outer"); })();
  expect(acquisitions).toBe(7);
});

test("joined read reuse invalidates on either source, first lock and rollback", async () => {
  const db = await database();
  db.exec("CREATE TABLE multiremi_reuse_a(id INTEGER PRIMARY KEY, value TEXT)");
  db.exec("CREATE TABLE multiremi_reuse_b(id INTEGER PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO multiremi_reuse_a VALUES(1,'a')");
  db.run("INSERT INTO multiremi_reuse_b VALUES(1,'b')");
  let reads = 0;
  const read = () => memoizeRequestRead(db, ["multiremi_reuse_a", "multiremi_reuse_b"], "joined", () => {
    reads++;
    return db.query("SELECT a.value AS a,b.value AS b FROM multiremi_reuse_a a JOIN multiremi_reuse_b b ON a.id=b.id").get();
  });
  withSynchronousRequestReadCache(() => {
    expect(read()).toEqual({ a: "a", b: "b" });
    read(); expect(reads).toBe(1);
    db.transaction(() => {
      read();
      markRequestReadCacheLockTaken();
      read();
      expect(reads).toBe(3);
    })();
    db.run("UPDATE multiremi_reuse_b SET value='new' WHERE id=1");
    expect(read()).toEqual({ a: "a", b: "new" });
    expect(reads).toBe(4);
    expect(() => db.transaction(() => {
      db.run("UPDATE multiremi_reuse_a SET value='rolled-back' WHERE id=1");
      expect(read()).toEqual({ a: "rolled-back", b: "new" });
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(read()).toEqual({ a: "a", b: "new" });
  });
  read(); expect(reads).toBe(7);
});

test("terminal card batch keeps every revision and discards failed transaction notifications", async () => {
  const db = await database();
  const changes: Array<[string, boolean, number]> = [];
  registerTurnChangeHook(db, (...change) => changes.push(change));
  db.transaction(() => withTurnChangeBatch(db, () => {
    notifyTurnChanged(db, "turn");
    notifyTurnChanged(db, "other", true);
    notifyTurnChanged(db, "turn");
    expect(changes).toHaveLength(0);
    expect(() => db.savepoint!(() => withTurnChangeBatch(db, () => {
      notifyTurnChanged(db, "turn");
      notifyTurnChanged(db, "rolled-back-inner");
      throw new Error("rollback");
    }))).toThrow("rollback");
  }))();
  expect(changes).toEqual([["turn", false, 2], ["other", true, 1]]);
  expect(() => db.transaction(() => withTurnChangeBatch(db, () => {
    notifyTurnChanged(db, "discarded"); throw new Error("rollback");
  }))()).toThrow("rollback");
  notifyTurnChanged(db, "next");
  expect(changes).toEqual([["turn", false, 2], ["other", true, 1], ["next", false, 1]]);
});
