import { createHash } from 'node:crypto';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { bootstrapAuthorizationDigest, RootManagement } from '@multiremi/store/root-management.js';
import type { ResolveAgentDependencies } from '@multiremi/store/agent-grant-dependencies.js';

const hash=(input:string)=>createHash('sha256').update(input).digest('hex');

export async function bootstrap(db:SqlDatabase, resolve?: ResolveAgentDependencies) {
    const service = new RootManagement(db,resolve);
    const password = 'test-dashboard-password';
    const verifier = await Bun.password.hash(password,{algorithm:'argon2id',memoryCost:19456,timeCost:2});
    db.run("INSERT INTO multiremi_users(id,name,email,created_at,updated_at) VALUES('usr_auth','test','auth@example.invalid','now','now')");
    db.query("INSERT INTO multiremi_password_credentials(user_id,login_email,password_hash,updated_at) VALUES('usr_auth','auth@example.invalid',?,'now')").run(verifier);
    db.run("INSERT INTO multiremi_authority_nodes VALUES('identity',1,1,'independent_identity','user','usr_auth','system',0,9999999999999,NULL,0)");
    db.run("INSERT INTO multiremi_authority_nodes VALUES('password',2,1,'password','user','usr_auth','system',0,9999999999999,NULL,1)");
    db.run("INSERT INTO multiremi_authority_edges VALUES('password',1,2,'identity',1,1,'continuous')");
    db.query("INSERT INTO multiremi_password_authority_versions VALUES('usr_auth',1,?,'password','identity')").run(hash(verifier));
    const signing={domainId:'test-dashboard',keyEpoch:'1',secret:'local-test-signing-secret'};
    const input={userId:'usr_auth',deploymentId:'test',authorization:'test-once',reason:'isolated test',expectedRevision:0,
      dashboardSigningDomain:{domainId:signing.domainId,keyEpoch:signing.keyEpoch,keyDigest:hash(signing.secret)}};
    db.query(`INSERT INTO multiremi_root_bootstrap_authorizations(authorization_digest,deployment_id,user_id,reason,expires_at_ms)
      VALUES(?,?,?,?,?)`).run(bootstrapAuthorizationDigest(input),input.deploymentId,input.userId,input.reason,Date.now()+60000);
    const passwordProof=await service.verifyIndependentPassword(input.userId,password);
    const created=service.bootstrapHuman(passwordProof,input);
    db.run("UPDATE multiremi_security_state SET feature_activation=1,minimum_enforcement_version='fixture'");
    return {service,passwordProof,signing,input,created};
}
