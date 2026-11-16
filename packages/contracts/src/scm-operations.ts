/** Observed checks alone never authorize merge. */
export interface ScmCheckObservation {
  id: string;
  kind: "check_run" | "commit_status";
  name: string;
  headSha: string;
  appId: number | null;
  appSlug: string | null;
  workflowPath: string | null;
  status: string;
  conclusion: string | null;
  url: string | null;
}

export interface ScmCheckSummary {
  headSha: string;
  observedAt: string;
  checks: ScmCheckObservation[];
  /** Empty and unknown observations must not be interpreted as success. */
  conclusion: "success" | "failure" | "pending" | "missing";
}
