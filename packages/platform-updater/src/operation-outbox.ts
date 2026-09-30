import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { MultiremiPlatformOperation, ReportPlatformOperationInput } from "@multiremi/contracts";

export interface PlatformOperationReceipt {
  operation: MultiremiPlatformOperation;
  report: ReportPlatformOperationInput;
  completedAt: string;
}

interface Entry {
  schemaVersion: 1;
  operation: MultiremiPlatformOperation;
  receipt: PlatformOperationReceipt | null;
}

/** Outside Docker volumes: restoring PostgreSQL must not erase this history. */
export class LocalProfileOperationOutbox {
  private readonly directory: string;
  constructor(private readonly profileRoot: string) {
    this.directory = join(profileRoot, "host-operation-receipts");
  }

  async remember(operation: MultiremiPlatformOperation): Promise<void> {
    const path = this.path(operation.id);
    const existing = await readOptional<Entry>(path);
    if (existing) {
      if (existing.operation.kind !== operation.kind || existing.operation.createdAt !== operation.createdAt
        || existing.operation.targetRef !== operation.targetRef || existing.operation.targetVersion !== operation.targetVersion) {
        throw new Error("Host operation identity changed");
      }
      return;
    }
    await this.save(path, { schemaVersion: 1, operation, receipt: null });
  }

  async complete(operationId: string, fallback: ReportPlatformOperationInput): Promise<PlatformOperationReceipt> {
    const entry = await this.entry(operationId);
    if (entry.receipt) return entry.receipt;
    const journal = await this.journal(operationId);
    if (journal?.status === "recovery_required" || journal?.phase === "rolling_back"
      || (journal?.status === "running" && ["switching", "backup_complete", "activating"].includes(journal.phase ?? ""))) {
      throw new Error("Host recovery is incomplete; keeping the operation and maintenance gate open");
    }
    const report = this.journalReport(entry.operation, journal) ?? fallback;
    if (!["succeeded", "failed", "cancelled", "rolled_back"].includes(report.status)) {
      throw new Error("Only terminal host outcomes can be persisted");
    }
    const receipt = { operation: entry.operation, report, completedAt: journal?.updatedAt ?? new Date().toISOString() };
    await this.save(this.path(operationId), { ...entry, receipt });
    return receipt;
  }

  /** Run after host recovery, before any API claim, including after every restart. */
  async reconcile(
    client: { reconcile(receipts: PlatformOperationReceipt[]): Promise<void> },
    finalize?: (operationId: string) => Promise<void>,
  ): Promise<void> {
    const receipts: PlatformOperationReceipt[] = [];
    for (const name of await this.names()) {
      const entry = await this.entry(name.slice(0, -5));
      if (entry.schemaVersion !== 1) throw new Error("Unsupported host receipt version");
      if (!entry.receipt) {
        const journal = await this.journal(entry.operation.id);
        const report = this.journalReport(entry.operation, journal);
        if (report) entry.receipt = await this.complete(entry.operation.id, report);
      }
      if (entry.receipt) receipts.push(entry.receipt);
    }
    // Keep acknowledged receipts: a later DB rollback can resurrect any old
    // active operation, or remove its terminal row entirely. ACK is not deletion.
    receipts.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
    for (let offset = 0; offset < receipts.length; offset += 100) {
      const batch = receipts.slice(offset, offset + 100);
      await client.reconcile(batch);
      // The host fence also protects old API images with no in-app gate. Only
      // a durable, acknowledged outcome can reopen writes after both services
      // have been verified (or the matching rollback has completed).
      const fence = await readOptional<{ operationId: string }>(join(this.profileRoot, "host-control", "write-fence.json"));
      if (finalize && fence && batch.some(receipt => receipt.operation.id === fence.operationId)) {
        await finalize(fence.operationId);
      }
    }
  }

  private journalReport(operation: MultiremiPlatformOperation, journal: Journal | null): ReportPlatformOperationInput | null {
    if (!journal || !["succeeded", "rolled_back", "failed"].includes(journal.status ?? "")) return null;
    const status = journal.status === "succeeded" ? (operation.kind === "rollback" ? "rolled_back" : "succeeded")
      : journal.status === "rolled_back" ? "rolled_back" : "failed";
    if (status !== "failed" && !journal.resultRelease) throw new Error("Completed host journal has no verified release");
    return { status, resultRelease: journal.resultRelease, error: journal.error ?? null,
      progress: { message: "Recovered durable host outcome for API and Web" } };
  }

  private path(id: string): string {
    if (!/^pop_[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid host operation ID");
    return join(this.directory, `${id}.json`);
  }
  private async entry(id: string): Promise<Entry> {
    const entry = await readOptional<Entry>(this.path(id));
    if (!entry || entry.operation.id !== id) throw new Error("Host operation receipt is missing or corrupt");
    return entry;
  }
  private journal(id: string): Promise<Journal | null> {
    this.path(id);
    return readOptional<Journal>(join(this.profileRoot, "host-operations", id, "operation.json"));
  }
  private async names(): Promise<string[]> {
    try { return (await readdir(this.directory)).filter(name => name.endsWith(".json")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private async save(path: string, entry: Entry): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try { await file.writeFile(`${JSON.stringify(entry, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  }
}

interface Journal {
  status?: string;
  phase?: string;
  updatedAt?: string;
  error?: string | null;
  resultRelease?: ReportPlatformOperationInput["resultRelease"];
}

async function readOptional<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
