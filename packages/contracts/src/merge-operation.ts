import type { MergeGateReason, ScmActor } from './merge-policy.js';
export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type MergeOperationState = 'requested' | 'blocked' | 'awaiting_human' | 'approved' | 'executing' | 'merged' | 'failed' | 'unknown' | 'rejected';
export interface MergeOperationBinding {
  head_sha: string; base_sha: string; target_branch: string; base_repository_full_name: string;
  policy_revision: number; method: MergeMethod;
}
export interface ScmMergeOperation extends MergeOperationBinding {
  id: string; project_id: string; change_request_id: string; workspace_id: string;
  actor: ScmActor; idempotency_key: string; expected_head_sha: string;
  state: MergeOperationState; version: number; lease_until: string | null;
  approval_message_id: string | null; approved_binding: MergeOperationBinding | null;
  reasons: MergeGateReason[]; merge_commit_sha: string | null;
  credential_boundary: "平台入口受控、直推未封闭" | "平台入口受控、直推已由仓库保护封闭（实时证明）"; created_at: string; updated_at: string;
}
