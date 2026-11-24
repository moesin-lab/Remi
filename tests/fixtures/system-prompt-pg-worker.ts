/** Independent writer process for the optional real-PostgreSQL policy suite. */
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { DEFAULT_SYSTEM_PROMPT_CONTENT } from "@multiremi/contracts/system-prompt-policy.js";
import type { PolicyOfferIdentity } from '@multiremi/contracts/system-prompt-policy.js';

export type SystemPromptPgWrite = { requestId: string } & (
  { operation?: "edit"; common: string } | { operation: "reset" } | { operation: "restore"; versionId: string }
  | { operation:'adopt'|'revoke'; identity:PolicyOfferIdentity }
);

export type SystemPromptPgJob = SystemPromptPgWrite & {
  workspaceId: string;
  batch: string;
  participant: string;
  expectedRevision: number;
};

if (import.meta.main) {
  const url = process.env.SYSTEM_PROMPT_TEST_URL;
  const encodedJob = process.env.SYSTEM_PROMPT_TEST_JOB;
  const sqliteFile = process.env.SYSTEM_PROMPT_TEST_SQLITE_FILE;
  if ((!url && !sqliteFile) || !encodedJob) throw new Error("Missing isolated worker configuration");
  if (url && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Requires local PostgreSQL");
  const job = JSON.parse(encodedJob) as SystemPromptPgJob;
  const db = sqliteFile ? openSqliteDatabase(sqliteFile) : new PostgresSyncDatabase(url!);
  try {
    if (sqliteFile) db.exec('PRAGMA busy_timeout=10000');
    else { db.exec("SET lock_timeout = '10s'"); db.exec("SET statement_timeout = '15s'"); }
    const store = new MultiremiStore(db);
    const app = createMultiremiApp({ store, authToken: "SYSTEM_PROMPT_TEST_MASTER" });
    db.run("INSERT INTO system_prompt_test_barrier(batch,participant) VALUES(?,?)", [job.batch, job.participant]);
    let ready = false;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const count = db.query("SELECT count(*) AS n FROM system_prompt_test_barrier WHERE batch=?").get(job.batch) as { n: string | number };
      if (Number(count.n) === 2) { ready = true; break; }
      await Bun.sleep(10);
    }
    if (!ready) throw new Error("System Prompt PostgreSQL process barrier timed out");
    if (job.operation === 'adopt' || job.operation === 'revoke') {
      const identity = job.identity;
      const won = job.operation === 'adopt' ? store.systemPromptsRepo().adoptOffer(identity)
        : store.requeueTaskOffer(identity.attempt_id,identity.runtime_id,'unknown',identity.offer_generation);
      console.log(`SYSTEM_PROMPT_TEST_RESULT:${JSON.stringify({participant:job.participant,status:won ? 200 : 409,body:{won}})}`);
    } else {
    const path = `/api/workspaces/${job.workspaceId}/system-prompt`;
    const edit = job.operation === undefined || job.operation === "edit";
    const body = { expectedRevision: job.expectedRevision, requestId: job.requestId,
      ...(edit ? { content: { ...DEFAULT_SYSTEM_PROMPT_CONTENT, common: job.common } } : {}),
      ...(job.operation === "restore" ? { versionId: job.versionId } : {}) };
    const response = await app.request(edit ? path : `${path}/${job.operation}`, {
      method: edit ? "PUT" : "POST", headers: { Authorization: "Bearer SYSTEM_PROMPT_TEST_MASTER", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = { participant: job.participant, status: response.status, body: await response.json() };
    console.log(`SYSTEM_PROMPT_TEST_RESULT:${JSON.stringify(result)}`);
    }
  } finally { db.close(); }
}
