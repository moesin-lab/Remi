import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiScheduler } from "@daemon/scheduler.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { ScmRepo } from "@multiremi/store/repos/scm-repo.js";
import { scmOwnershipReady } from "@multiremi/store/scm-ownership.js";

let directory: string;
let filename: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "remi-scm-maintenance-"));
  filename = join(directory, "server.sqlite");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function cli(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "apps/remi/main.ts", ...args], {
    env: { ...process.env, HOME: directory, MULTIREMI_DATABASE_URL: "" }, stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, output: `${result.stdout}${result.stderr}` };
}

function classify(...args: string[]) {
  return cli("db", "classify-scm-links", "--sqlite-file", filename, ...args);
}

it("shows the internal Issue ID in both delivery commands", () => {
  for (const command of ["bind", "list"]) {
    const help = cli("scm", "change-request", command, "--help");
    expect(help.code).toBe(0);
    expect(help.output).toContain(`${command} <issue-id>`);
    expect(help.output).toContain("internal iss_... Issue ID from the task context");
  }
});

for (const journal of ["wal", "delete"]) {
  it(`classifies an empty SQLite Server through the CLI after exclusive access (${journal})`, () => {
    const initialized = Bun.spawnSync([process.execPath, "-e", `
      import { MultiremiStore } from '@multiremi/store.js';
      import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
      const db = openSqliteDatabase(process.argv[1], { create: true });
      if (new MultiremiStore(db).scmOwnershipReady()) throw new Error('Unexpected completed cutover');
      db.exec('PRAGMA journal_mode=${journal}');
      db.close();`, filename]);
    expect(initialized.exitCode).toBe(0);
    const db = openSqliteDatabase(filename);
    try {
      db.exec("BEGIN");
      db.query("SELECT * FROM multiremi_scm_ownership_cutover").all();
      const refused = classify();
      expect(refused.code).toBe(1);
      expect(refused.output).toContain("Retry remi db classify-scm-links");
      expect(db.query("SELECT * FROM multiremi_scm_rollback_review").all()).toEqual([]);
      expect(db.query("SELECT * FROM multiremi_scm_ownership_cutover").all()).toEqual([]);
      db.exec("ROLLBACK");
    } finally { db.close(); }
    expect(classify()).toMatchObject({ code: 0, output: expect.stringContaining('"complete":true') });
    const reopened = openSqliteDatabase(filename);
    try { expect(scmOwnershipReady(reopened)).toBe(true); } finally { reopened.close(); }
  }, 30_000);
}

it("keeps ordinary scheduling and repository reads available across offline classification", async () => {
  const db = openSqliteDatabase(filename, { create: true });
  try {
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", { repos: [{ id: "widgets", name: "Widgets", url: "https://github.com/acme/widgets", default_branch: "main" }] });
    db.exec(`INSERT INTO multiremi_scm_connections(id,name,provider,base_url,api_base_url,created_at,updated_at)
      VALUES ('connection','fixture','github','https://github.com','https://api.github.com','now','now')`);
    const app = createMultiremiApp({ store });
    const cron = spyOn(store, "listAutopilots");
    const reconcile = spyOn(store, "reconcileScmRepositoryBindings");
    const claim = spyOn(ScmRepo.prototype, "claimPendingEvents");
    try {
      const scheduler = new MultiremiScheduler({ store });
      scheduler.sync();
      expect(cron).toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(() => store.createScmConnection({ workspaceId: "local", name: "another", provider: "github" })).toThrow("cutover incomplete");
      const repos = () => app.request("/api/workspaces/local/repos");
      const response = await repos();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ repositories: [{ id: "widgets", default_branch: "main" }] });
      expect(reconcile).not.toHaveBeenCalled();
      db.close();
      expect(classify().code).toBe(0);
      const ready = openSqliteDatabase(filename);
      try {
        const restored = new MultiremiStore(ready);
        const resumed = spyOn(restored, "reconcileScmRepositoryBindings");
        new MultiremiScheduler({ store: restored }).sync();
        expect(claim).toHaveBeenCalled();
        expect((await createMultiremiApp({ store: restored }).request("/api/workspaces/local/repos")).status).toBe(200);
        expect(resumed).toHaveBeenCalled();
      } finally { ready.close(); }
    } finally { claim.mockRestore(); }
  } finally { db.close(); }
});

it("upgrades historical links, then audits old-writer additions without reclassifying frozen evidence", () => {
  const db = openSqliteDatabase(filename, { create: true });
  const addLink = `INSERT INTO multiremi_scm_issue_links(id,workspace_id,change_request_id,issue_id,source,active,linked_at,created_at,updated_at)
    VALUES (?, 'local','pr',?,?,?,'then','then','then')`;
  let addedIssue: string;
  try {
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    const [strong, weak, inactive, added] = ["Strong", "Weak", "Inactive", "Added"].map(title => store.createIssue({ title, workspaceId: "local" }));
    addedIssue = added.id;
    db.exec(`INSERT INTO multiremi_scm_connections(id,name,provider,base_url,api_base_url,created_at,updated_at)
      VALUES ('connection','fixture','github','https://github.com','https://api.github.com','now','now')`);
    db.run(`INSERT INTO multiremi_scm_change_requests(id,workspace_id,connection_id,repository_id,provider,external_id,title,body,state,created_at,updated_at)
      VALUES ('pr','local','connection','repo','github','123',?,?,'open','then','then')`, [strong.key, `Mentions ${weak.key}`]);
    db.run(addLink, ["s", strong.id, "legacy", 1]);
    db.run(addLink, ["w", weak.id, "auto", 1]);
    db.run(addLink, ["i", inactive.id, "auto", 0]);
    db.exec(`DROP TABLE multiremi_scm_rollback_review; DROP TABLE multiremi_scm_link_ownership; DROP TABLE multiremi_scm_ownership_cutover;
      DELETE FROM multiremi_schema_steps WHERE level>=4; UPDATE multiremi_schema_meta SET expand_level=3`);
    expect(new MultiremiStore(db).scmOwnershipReady()).toBe(false);
  } finally { db.close(); }
  expect(classify().code).toBe(0);
  expect(classify("--hold-for-rollback").code).toBe(0);
  const writer = openSqliteDatabase(filename);
  try {
    expect(new MultiremiStore(writer).scmOwnershipReady()).toBe(false);
    writer.exec("UPDATE multiremi_scm_change_requests SET title='rewritten',body=NULL");
    writer.run(addLink, ["a", addedIssue, "auto", 1]);
  } finally { writer.close(); }
  const audit = classify();
  expect(audit.code).toBe(1);
  expect(audit.output).toContain(addedIssue);
  const path = join(directory, "review.json");
  const record = { id: "a", issue_id: addedIssue, workspace_id: "local", change_request_id: "pr", source: "auto", active: 1, proof: "archived-at-bind:fixture", attribution: ["body"] };
  writeFileSync(path, JSON.stringify([{ ...record, active: 0 }]));
  expect(classify("--restore-reviewed", path).code).toBe(1);
  const held = openSqliteDatabase(filename);
  try {
    expect(new MultiremiStore(held).scmOwnershipReady()).toBe(false);
    expect(held.query("SELECT attribution FROM multiremi_scm_link_ownership WHERE link_id='a'").get()).toBeNull();
  } finally { held.close(); }
  writeFileSync(path, JSON.stringify([record]));
  expect(classify("--restore-reviewed", path).code).toBe(0);
  const verified = openSqliteDatabase(filename);
  try {
    const store = new MultiremiStore(verified);
    expect(store.scmOwnershipReady()).toBe(true);
    expect(verified.query("SELECT link_id,attribution FROM multiremi_scm_link_ownership ORDER BY link_id").values()).toEqual([
      ["a", '["body"]'], ["i", "[]"], ["s", '["title"]'], ["w", "[]"],
    ]);
    expect(verified.query("SELECT active,source FROM multiremi_scm_issue_links WHERE id='i'").get()).toEqual({ active: 0, source: "auto" });
    expect(store.listIssueActivity(addedIssue).filter(activity => activity.type === "scm_merge_completed")).toEqual([]);
  } finally { verified.close(); }
}, 30_000);
