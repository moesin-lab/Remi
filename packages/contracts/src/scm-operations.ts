/** Observed checks alone never authorize merge. */
export interface ScmCheckObservation {
  id: string;
  kind: "check_run" | "commit_status" | "workflow_run";
  name: string;
  headSha: string;
  appId: number | null;
  appSlug: string | null;
  workflowPath: string | null;
  status: string;
  conclusion: string | null;
  url: string | null;
  /** GitHub workflow rerun attempt; absent for job checks and commit statuses. */
  runAttempt?: number | null;
}

export interface ScmCheckSummary {
  headSha: string;
  observedAt: string;
  checks: ScmCheckObservation[];
  /** Empty and unknown observations must not be interpreted as success. */
  conclusion: "success" | "failure" | "pending" | "missing";
}
