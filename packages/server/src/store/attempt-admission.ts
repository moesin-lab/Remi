import type { SqlDatabase } from './db/postgres.js';
import type { AdmissionTicket, AuthorityKernel, FinalExecution, InputManifest } from './root-authority-contract.js';
import { withSecurityTarget, withSecurityWrite, type SecurityLockPlan, type SecurityTx } from './security-write.js';

type AttemptRow = Readonly<Record<string, unknown>>;
type AdmissionKernel = Pick<AuthorityKernel, 'admitAttempt' | 'consumeAdmission'>;
type AdmissionArgs = Parameters<AdmissionKernel['admitAttempt']>;

export interface AttemptWrite {
  readonly attemptId: string;
  readonly kernel: AdmissionKernel;
  resolveInvocation(tx: SecurityTx): { subject: AdmissionArgs[1]; invocation: AdmissionArgs[2] };
  resolveExecution(tx: SecurityTx, row: AttemptRow): { execution: FinalExecution; manifest: InputManifest };
}

const activeInsert = new WeakMap<SqlDatabase, (row: AttemptRow, insert: () => void) => void>();

export function withAttemptAdmission<T>(db: SqlDatabase, fence: string | undefined, plan: SecurityLockPlan,
  write: AttemptWrite, operation: () => T): T {
  return withSecurityWrite(db, fence, plan, tx => withSecurityTarget(db, tx, `attempt:${write.attemptId}`, () => {
    let inserted = false;
    let ticket: AdmissionTicket | undefined;
    activeInsert.set(db, (row, insert) => withSecurityTarget(db, tx, `attempt:${write.attemptId}`, () => {
      if (inserted || row.id !== write.attemptId) throw new Error('Unexpected admission target');
      const { subject, invocation } = write.resolveInvocation(tx);
      const { execution, manifest } = write.resolveExecution(tx, row);
      if (execution.attemptId !== write.attemptId) throw new Error('Unexpected admission execution');
      const admission = write.kernel.admitAttempt(tx, subject, invocation, execution, manifest);
      if (admission.eligibility === 'root') ticket = admission.ticket;
      insert();
      inserted = true;
    }));
    try {
      const result = operation();
      if (!inserted) throw new Error('Missing admitted attempt');
      if (ticket) {
        const stored = db.query('SELECT * FROM multiremi_turn_attempts WHERE id=?').get(write.attemptId);
        if (!stored) throw new Error('Missing admitted attempt');
        const { execution, manifest } = write.resolveExecution(tx, stored);
        write.kernel.consumeAdmission(tx, ticket, execution, manifest);
      }
      return result;
    } finally { activeInsert.delete(db); }
  }));
}

export function insertTurnAttempt(db: SqlDatabase, row: AttemptRow): void {
  const columns = Object.keys(row);
  if (columns.some(column => !/^[a-z][a-z0-9_]*$/.test(column))) throw new Error('Invalid attempt column');
  const insert = () => {
    db.run(`INSERT INTO multiremi_turn_attempts(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
      columns.map(column => row[column] ?? null));
  };
  const admit = activeInsert.get(db);
  if (admit) admit(row, insert);
  else insert();
}
