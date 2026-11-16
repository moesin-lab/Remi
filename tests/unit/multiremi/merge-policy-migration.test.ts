import { runMigrations } from "@multiremi/store/migrations.js";
import { ensureMergeOperationSchema } from "@multiremi/store/merge-operation-schema.js";
import { expect, it } from "bun:test";
import { unifiedModelBackendTests } from "./unified-model-test-backends.js";
import { ensureMergePolicySchema } from "@multiremi/store/merge-policy-schema.js";
unifiedModelBackendTests("B1 additive merge policy migration", fixture => {
  it("adds the same server-only credential columns idempotently on SQLite/PG", () => {
    const { db } = fixture();
    runMigrations(db); runMigrations(db);
    expect(db.query("SELECT merge_credential_encrypted,merge_credential_hint,merge_credential_kind FROM multiremi_scm_connections").all()).toEqual([]);
  });
  it("installs the same policy/actor/review schema idempotently", () => {
    const { db } = fixture();
    ensureMergePolicySchema(db); ensureMergePolicySchema(db);
    ensureMergeOperationSchema(db); ensureMergeOperationSchema(db);
    expect(db.query("SELECT workspace_id,remote_key,repository_id,project_id,connection_id,policy_revision,source,created_at FROM multiremi_scm_strict_coverage").all()).toEqual([]);
    expect(db.query("SELECT id,project_id,change_request_id,idempotency_key,state,version,lease_until,operation FROM multiremi_scm_merge_operations").all()).toEqual([]);
    expect(db.query("SELECT project_id,change_request_id,idempotency_key,operation_id,request_body FROM multiremi_scm_merge_request_keys").all()).toEqual([]);
    expect(db.query("SELECT project_id,revision,policy,updated_by,updated_at FROM multiremi_project_merge_policies").all()).toEqual([]);
    expect(db.query("SELECT id,change_request_id,action,actor,created_at FROM multiremi_scm_cr_actors").all()).toEqual([]);
    expect(db.query("SELECT id,project_id,change_request_id,sequence,review FROM multiremi_scm_reviews").all()).toEqual([]);
  });
});
