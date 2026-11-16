import { expect, it } from "bun:test";
import { unifiedModelBackendTests } from "./unified-model-test-backends.js";
import { ensureMergePolicySchema } from "@multiremi/store/merge-policy-schema.js";
unifiedModelBackendTests("B1 additive merge policy migration", fixture => {
  it("installs the same policy/actor/review schema idempotently", () => {
    const { db } = fixture();
    ensureMergePolicySchema(db); ensureMergePolicySchema(db);
    expect(db.query("SELECT project_id,revision,policy,updated_by,updated_at FROM multiremi_project_merge_policies").all()).toEqual([]);
    expect(db.query("SELECT id,change_request_id,action,actor,created_at FROM multiremi_scm_cr_actors").all()).toEqual([]);
    expect(db.query("SELECT id,project_id,change_request_id,sequence,review FROM multiremi_scm_reviews").all()).toEqual([]);
  });
});
