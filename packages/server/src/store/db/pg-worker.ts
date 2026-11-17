import { DatabaseUnavailableError, isDatabaseConnectionError } from "@shared/db/recovery.js";
/**
 * Postgres bridge worker.
 *
 * Holds a single Postgres connection (Bun.SQL, max:1 so transaction statements
 * share one connection) and answers synchronous requests from the main thread:
 * the main thread posts a query then blocks on Atomics.wait; this worker runs
 * the async query and writes the JSON result into the shared data buffer, then
 * Atomics.notify wakes the main thread. See postgres.ts (PostgresSyncDatabase).
 */
// In a Bun Worker, the global `self` is the Worker scope. tsc's default DOM lib
// types `self` as `Window`, so reference it through a locally-typed alias rather
// than redeclaring the global (which would conflict with the lib declaration).
const workerSelf = self as unknown as Worker;

let sql: any = null;
let databaseUrl = "";
let backend: { pid: number; started: string; generation: number } | null = null;
const STATUS_DONE = 1;
const STATUS_ERROR = 2;

// Bun.SQL transparently reconnects after the server drops the connection (PG
// restart, pg_terminate_backend). That is what lets the API heal after a
// restart, but inside BEGIN…COMMIT it would run the rest of the transaction in
// autocommit on a fresh session and turn COMMIT into a no-op warning, silently
// committing only the tail of the transaction. The server has already rolled
// the transaction back when the connection died, so once that happens every
// further statement is refused until the caller's ROLLBACK closes it out.
let connectionGeneration = 0;
let transactionGeneration: number | null = null;
let transactionConnectionLost = false;
const TRANSACTION_CONNECTION_LOST =
  "connection lost during transaction; the server rolled the transaction back";

function transactionVerb(query: string | undefined): "BEGIN" | "COMMIT" | "ROLLBACK" | null {
  if (!query || query.length > 16) return null;
  const verb = query.trim().toUpperCase();
  return verb === "BEGIN" || verb === "COMMIT" || verb === "ROLLBACK" ? verb : null;
}

function connect(url: string, track = true): any {
  const client = new Bun.SQL(url, {
    max: 1,
    connectionTimeout: 2,
    onconnect: () => { if (track) connectionGeneration += 1; },
    onclose: () => {
      if (sql === client && transactionGeneration !== null) transactionConnectionLost = true;
    },
  });
  return client;
}

workerSelf.onmessage = async (event: MessageEvent) => {
  const { control, data, init, sql: query, params, timeoutMs } = event.data as {
    control: SharedArrayBuffer;
    data: SharedArrayBuffer;
    init?: string;
    sql?: string;
    params?: unknown[];
    timeoutMs?: number;
  };
  const ctl = new Int32Array(control);
  const buf = new Uint8Array(data);

  const respond = (status: number, payload: string): void => {
    const encoder = new TextEncoder();
    let bytes = encoder.encode(payload);
    if (bytes.length > buf.length) {
      if (status === STATUS_ERROR) {
        let original: { error?: unknown; source?: unknown; connectionError?: boolean } = {};
        try { original = JSON.parse(payload); } catch { /* Unknown error replies fail closed. */ }
        const error = typeof original.error === "string" ? original.error : "postgres bridge error result too large";
        const source = typeof original.source === "string" ? original.source : "unknown";
        const suffix = `…(truncated, ${encoder.encode(error).length} bytes)`;
        let low = 0;
        let high = error.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          const candidate = encoder.encode(JSON.stringify({ error: error.slice(0, mid) + suffix, source, connectionError: original.connectionError }));
          if (candidate.length <= buf.length) low = mid;
          else high = mid - 1;
        }
        bytes = encoder.encode(JSON.stringify({ error: error.slice(0, low) + suffix, source, connectionError: original.connectionError }));
        if (bytes.length > buf.length) bytes = encoder.encode(JSON.stringify({ error: "postgres bridge error too large", source, connectionError: original.connectionError }));
      } else {
        bytes = encoder.encode(
          JSON.stringify({ error: `postgres bridge result too large (${bytes.length} > ${buf.length} bytes)`, source: "reply" }),
        );
      }
      status = STATUS_ERROR;
    }
    buf.set(bytes, 0);
    Atomics.store(ctl, 1, bytes.length);
    Atomics.store(ctl, 0, status);
    Atomics.notify(ctl, 0);
  };

  const verb = transactionVerb(query);
  let queryCompleted = false;
  try {
    if (init) {
      databaseUrl = init;
      sql = connect(init);
      const rows = await sql`SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()`;
      backend = { pid: Number(rows[0].pid), started: rows[0].started, generation: connectionGeneration };
      respond(STATUS_DONE, JSON.stringify({ ok: true }));
      return;
    }
    if (transactionGeneration !== null && transactionGeneration !== connectionGeneration) {
      transactionConnectionLost = true;
    }
    if (transactionConnectionLost) {
      if (verb === "ROLLBACK") {
        respond(STATUS_DONE, JSON.stringify({ rows: [], count: 0 }));
      } else {
        respond(STATUS_ERROR, JSON.stringify({ error: TRANSACTION_CONNECTION_LOST, source: "connection" }));
      }
      return;
    }
    const client = sql;
    let timedOut = false;
    const execute = async () => {
      await client.connect();
      if (timedOut) return new Promise<never>(() => {});
      if (transactionGeneration !== null && transactionGeneration !== connectionGeneration) {
        transactionConnectionLost = true;
        throw new DatabaseUnavailableError(TRANSACTION_CONNECTION_LOST);
      }
      // Resolve once per physical connection, including Bun's transparent
      // reconnects. A busy backend cannot answer this after a query times out.
      if (!backend || backend.generation !== connectionGeneration) {
        const rows = await client.unsafe("SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()");
        if (timedOut) return new Promise<never>(() => {});
        backend = { pid: Number(rows[0].pid), started: rows[0].started, generation: connectionGeneration };
      }
      if (timedOut) return new Promise<never>(() => {});
      return await client.unsafe(query, params ?? []);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let res: any;
    try {
      res = timeoutMs ? await Promise.race([
        execute().then(
          value => timedOut ? new Promise<never>(() => {}) : value,
          error => { if (timedOut) return new Promise<never>(() => {}); throw error; },
        ),
        new Promise<never>((_, reject) => {
          // Reserve part of the same budget for server-side termination. A
          // socket close (and Bun Query.cancel) alone can leave a lock-waiting
          // backend alive indefinitely, retaining transaction and role locks.
          const terminationMs = Math.min(500, Math.max(1, Math.floor(timeoutMs / 5)));
          timer = setTimeout(async () => {
            timedOut = true;
            if (transactionGeneration !== null) transactionConnectionLost = true;
            const oldBackend = backend;
            backend = null;
            sql = connect(databaseUrl);
            const controlClient = connect(databaseUrl, false);
            let terminationTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              if (oldBackend) await Promise.race([
                controlClient.unsafe(
                  "SELECT pg_terminate_backend(pid, $3) FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz AND usename = current_user",
                  [oldBackend.pid, oldBackend.started, Math.max(1, terminationMs - 50)],
                ),
                new Promise<void>(resolve => { terminationTimer = setTimeout(resolve, terminationMs); }),
              ]);
            } catch { /* Database outage: transport teardown remains bounded. */ }
            finally {
              if (terminationTimer) clearTimeout(terminationTimer);
              void controlClient.close({ timeout: 0 }).catch(() => {});
              void client.close({ timeout: 0 }).catch(() => {});
              reject(new DatabaseUnavailableError());
            }
          }, Math.max(1, timeoutMs - terminationMs));
        }),
      ]) : await execute();
    } finally {
      if (timer) clearTimeout(timer);
    }
    queryCompleted = true;
    if (verb === "BEGIN") {
      transactionGeneration = connectionGeneration;
    } else if (transactionGeneration !== null && transactionGeneration !== connectionGeneration) {
      // Reconnected while this statement ran: it executed outside the transaction.
      transactionConnectionLost = true;
      respond(STATUS_ERROR, JSON.stringify({ error: TRANSACTION_CONNECTION_LOST, source: "connection" }));
      return;
    }
    const rows = Array.isArray(res) ? res : Array.from(res ?? []);
    const count = res && typeof (res as any).count === "number" ? (res as any).count : rows.length;
    const command = typeof (res as any)?.command === "string" ? (res as any).command : undefined;
    respond(STATUS_DONE, JSON.stringify({ rows, count, command }));
  } catch (err: any) {
    respond(STATUS_ERROR, JSON.stringify({ error: String(err?.message ?? err), source: queryCompleted ? "reply" : "query", connectionError: isDatabaseConnectionError(err) }));
  } finally {
    if (verb === "COMMIT" || verb === "ROLLBACK") {
      transactionGeneration = null;
      transactionConnectionLost = false;
    }
  }
};
