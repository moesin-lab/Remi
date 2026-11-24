/** Independent writer process for the optional real-PostgreSQL policy suite. */
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { DEFAULT_SYSTEM_PROMPT_CONTENT } from "@multiremi/contracts/system-prompt-policy.js";

export interface SystemPromptPgJob {
  workspaceId: string;
  batch: string;
  participant: string;
  expectedRevision: number;
  requestId: string;
  common: string;
}

if (import.meta.main) {
  const url = process.env.SYSTEM_PROMPT_TEST_URL;
  const encodedJob = process.env.SYSTEM_PROMPT_TEST_JOB;
  if (!url || !encodedJob) throw new Error("Missing isolated PostgreSQL worker configuration");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Requires local PostgreSQL");
  const job = JSON.parse(encodedJob) as SystemPromptPgJob;
  const db = new PostgresSyncDatabase(url);
  try {
    db.exec("SET lock_timeout = '10s'");
    db.exec("SET statement_timeout = '15s'");
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
    const response = await app.request(`/api/workspaces/${job.workspaceId}/system-prompt`, {
      method: "PUT", headers: { Authorization: "Bearer SYSTEM_PROMPT_TEST_MASTER", "content-type": "application/json" },
      body: JSON.stringify({ content: { ...DEFAULT_SYSTEM_PROMPT_CONTENT, common: job.common },
        expectedRevision: job.expectedRevision, requestId: job.requestId }),
    });
    const result = { participant: job.participant, status: response.status, body: await response.json() };
    console.log(`SYSTEM_PROMPT_TEST_RESULT:${JSON.stringify(result)}`);
  } finally { db.close(); }
}
