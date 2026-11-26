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
    const initScript = join(directory, `init-${journal}.ts`);
    writeFileSync(initScript, `
      import { MultiremiStore } from ${JSON.stringify(import.meta.resolve("../../../packages/server/src/store/store.ts"))};
      import { openSqliteDatabase } from ${JSON.stringify(import.meta.resolve("../../../packages/server/src/store/db/sqlite.ts"))};
      const db = openSqliteDatabase(process.argv[2], { create: true });
      if (new MultiremiStore(db).scmOwnershipReady()) throw new Error('Unexpected completed cutover');
      db.exec('PRAGMA journal_mode=${journal}');
      db.close();
    `);
    const initialized = Bun.spawnSync([process.execPath, initScript, filename], {
      env: { ...process.env, HOME: directory, MULTIREMI_DATABASE_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(initialized.exitCode, `${initialized.stdout}${initialized.stderr}`).toBe(0);
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

it('keeps a valid new CLI baseline held when only the provider identity changes', () => {
  const db = openSqliteDatabase(filename, { create: true });
  try {
    new MultiremiStore(db).ensureLocalWorkspace();
    db.exec(`INSERT INTO multiremi_scm_connections(id,name,provider,base_url,api_base_url,created_at,updated_at)
      VALUES ('fixture','fixture','github','https://github.com','https://api.github.com','then','then');
      INSERT INTO multiremi_scm_change_requests(id,workspace_id,connection_id,repository_id,provider,external_id,number,title,state,created_at,updated_at)
      VALUES ('pr','local','fixture','repo','github','123',1,'clean','open','then','then')`);
  } finally { db.close(); }
  expect(classify().code).toBe(0);
  expect(classify('--hold-for-rollback').code).toBe(0);
  const oldWriter = openSqliteDatabase(filename);
  try { oldWriter.run("UPDATE multiremi_scm_change_requests SET external_id='456' WHERE id='pr'"); }
  finally { oldWriter.close(); }
  const result = classify();
  expect(result.code, result.output).toBe(0);
  const observed = JSON.parse(result.output);
  expect(observed).toMatchObject({ writersHeld: true, pending: 1, entries: [{ entry_key: 'projection:pr', kind: 'identity' }] });
  const receipt = join(directory, 'generation.json');
  writeFileSync(receipt, JSON.stringify(observed.receipt));
  expect(classify('--finalize', receipt)).toMatchObject({ code: 1, output: expect.stringContaining('Unresolved') });
  const verified = openSqliteDatabase(filename);
  try { expect(scmOwnershipReady(verified)).toBe(false); } finally { verified.close(); }
}, 30_000);

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
    db.exec(`DROP TABLE multiremi_scm_audit_state; DROP TABLE multiremi_scm_rollback_review; DROP TABLE multiremi_scm_link_ownership; DROP TABLE multiremi_scm_ownership_cutover;
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
  expect(audit.code, audit.output).toBe(0);
  const report = JSON.parse(audit.output);
  expect(report).toMatchObject({ writersHeld: true, entries: expect.arrayContaining([expect.objectContaining({ entry_key: 'link:a', kind: 'added' })]) });
  const path = join(directory, "review.json");
  writeFileSync(path, JSON.stringify([{ id: 'a', proof: 'unverified', attribution: ['title'] }]));
  expect(classify("--restore-reviewed", path).code).toBe(1);
  writeFileSync(path, JSON.stringify(report.receipt));
  expect(classify("--finalize", path).code).toBe(1);
  const verified = openSqliteDatabase(filename);
  try {
    const store = new MultiremiStore(verified);
    expect(store.scmOwnershipReady()).toBe(false);
    expect(verified.query("SELECT link_id,attribution FROM multiremi_scm_link_ownership ORDER BY link_id").values()).toEqual([
      ["i", "[]"], ["s", '["title"]'], ["w", "[]"],
    ]);
    expect(verified.query("SELECT active,source FROM multiremi_scm_issue_links WHERE id='i'").get()).toEqual({ active: 0, source: "auto" });
    expect(store.listIssueActivity(addedIssue).filter(activity => activity.type === "scm_merge_completed")).toEqual([]);
  } finally { verified.close(); }
}, 30_000);
