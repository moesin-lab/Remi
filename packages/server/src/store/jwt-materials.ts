import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { SqlDatabase } from './db/postgres.js';
import { assertUnrevokedAncestry } from './authority-provenance.js';
import { SecurityAbort, withSecurityTarget, withSecurityWrite, type SecurityTx } from './security-write.js';

export interface JwtSigningDomain {
  readonly domainId: string;
  readonly keyEpoch: string;
  readonly secret: string;
}

export interface JwtIssuance {
  readonly credentialId: string;
  readonly materialVersion: number;
  readonly expectedVersion: number;
  readonly subjectType: 'user' | 'agent';
  readonly subjectId: string;
  readonly purpose: string;
  readonly familyId: string;
  readonly nodeId: string;
  readonly generation: number;
}

export class JwtMaterialUnavailable extends Error {
  constructor() { super('JWT material state unavailable'); }
}

export function compactJwtDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface JwtMaterialIdentity {
  readonly userId: string;
  readonly digest: string;
}

// Registration only consumes an already persisted issuer node. It never creates
// an independent source from a signature, user ID, or an incoming credential.
export class JwtMaterials {
  constructor(private readonly db: SqlDatabase) {}

  isActive(): boolean {
    try {
      const row = this.db.query('SELECT feature_activation FROM multiremi_security_state WHERE singleton = 1').get();
      if (!row || ![0, 1].includes(Number(row.feature_activation))) throw new JwtMaterialUnavailable();
      return Number(row.feature_activation) === 1;
    } catch { throw new JwtMaterialUnavailable(); }
  }

  issue(tx: SecurityTx, input: JwtIssuance, claims: Record<string, unknown>, signing: JwtSigningDomain): string {
    const payload = {
      ...claims, sub: input.subjectId, jti: input.credentialId, purpose: input.purpose,
      material_version: input.materialVersion, key_epoch: signing.keyEpoch, signing_domain: signing.domainId,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', signing.secret).update(`${header}.${body}`).digest('base64url');
    const token = `${header}.${body}.${signature}`;
    this.registerIssued(tx, input, token, signing);
    return token;
  }

  registerIssued(tx: SecurityTx, input: JwtIssuance, token: string, signing: JwtSigningDomain): void {
    withSecurityTarget(this.db, tx, `jwt:${input.credentialId}`, () => {
      const material = describeJwt(token, signing);
      if (!material || material.claims.sub !== input.subjectId || material.claims.jti !== input.credentialId
        || material.claims.purpose !== input.purpose || material.claims.material_version !== input.materialVersion
        || material.claims.key_epoch !== signing.keyEpoch || material.claims.signing_domain !== signing.domainId
        || !Number.isSafeInteger(input.materialVersion) || input.materialVersion !== input.expectedVersion + 1) {
        throw new SecurityAbort('credential_version_conflict');
      }
      this.assertDomain(signing);
      const node = this.db.query(`SELECT * FROM multiremi_authority_nodes WHERE node_id = ?`).get(input.nodeId);
      if (!node || node.kind !== 'jwt_material' || node.subject_type !== input.subjectType || node.subject_id !== input.subjectId
        || Number(node.generation) !== input.generation || Number(node.continuous_parent_count) < 1
        || material.expiresAtMs > Number(node.expires_at_ms)) throw new SecurityAbort('root_authority_revoked');
      this.assertSource(tx, { ...input, expiresAtMs: material.expiresAtMs });
      const current = this.db.query('SELECT current_material_version FROM multiremi_jwt_current WHERE credential_id = ?').get(input.credentialId);
      if (Number(current?.current_material_version ?? 0) !== input.expectedVersion) throw new SecurityAbort('credential_version_conflict');
      this.db.run(`INSERT INTO multiremi_jwt_materials(compact_digest,credential_id,material_version,subject_type,subject_id,
        purpose,claims_json,header_json,expires_at_ms,domain_id,key_epoch,family_id,authority_node_id,authority_generation,authority_seq)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, compactJwtDigest(token), input.credentialId, input.materialVersion, input.subjectType,
        input.subjectId, input.purpose, material.claimsJson, material.headerJson, material.expiresAtMs, signing.domainId, signing.keyEpoch,
        input.familyId, input.nodeId, input.generation, node.issued_seq);
      if (current) {
        const updated = this.db.query(`UPDATE multiremi_jwt_current SET current_material_version = ?
          WHERE credential_id = ? AND current_material_version = ? RETURNING credential_id`)
          .get(input.materialVersion, input.credentialId, input.expectedVersion);
        if (!updated) throw new SecurityAbort('credential_version_conflict');
      } else {
        this.db.run('INSERT INTO multiremi_jwt_current(credential_id,current_material_version) VALUES(?,?)', input.credentialId, input.materialVersion);
      }
    });
  }

  validate(token: string, signing: JwtSigningDomain): JwtMaterialIdentity | null {
    const described = describeJwt(token, signing);
    if (!described) return null;
    return this.validateDigest(compactJwtDigest(token), signing, described);
  }

  validateDigest(digest: string, signing: JwtSigningDomain, described?: ReturnType<typeof describeJwt>): JwtMaterialIdentity | null {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return this.validateCurrentDigest(digest, signing, described);
      } catch (error) {
        if (error instanceof SecurityAbort && error.code === 'authority_revision_conflict') continue;
        if (error instanceof SecurityAbort && error.code !== 'security_state_unavailable' && error.code !== 'security_tx_invalid') return null;
        throw new JwtMaterialUnavailable();
      }
    }
    throw new JwtMaterialUnavailable();
  }

  private validateCurrentDigest(digest: string, signing: JwtSigningDomain, described?: ReturnType<typeof describeJwt>): JwtMaterialIdentity | null {
    const state = this.db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton = 1').get();
    if (!state) throw new JwtMaterialUnavailable();
    // This first read only determines the lock plan. Every field is re-read
    // on the primary after taking the security revision lock.
    const locator = this.db.query('SELECT credential_id,authority_node_id FROM multiremi_jwt_materials WHERE compact_digest = ?').get(digest);
    if (!locator) return null;
    const current = withSecurityWrite(this.db, undefined, {
      expectedRevision: Number(state.security_revision), workspaceIds: [], numberKeys: [],
      domainTargets: [`authority:${locator.authority_node_id}`, `jwt:${locator.credential_id}`].sort(),
    }, tx => this.currentInTransaction(tx, digest, signing, {credential_id: locator.credential_id, authority_node_id: locator.authority_node_id}, described));
    return current ? {userId: current.userId, digest} : null;
  }

  currentInTransaction(tx: SecurityTx, digest: string, signing: JwtSigningDomain,
    locator: { credential_id: string; authority_node_id: string }, described?: ReturnType<typeof describeJwt>) {
    return withSecurityTarget(this.db, tx, `jwt:${locator.credential_id}`, () => {
      this.assertDomain(signing);
      const row = this.db.query(`SELECT m.* FROM multiremi_jwt_materials m JOIN multiremi_jwt_current c
        ON c.credential_id = m.credential_id AND c.current_material_version = m.material_version
        WHERE m.compact_digest = ?`).get(digest);
      if (!row || row.revoked_at_ms !== null || row.domain_id !== signing.domainId || row.key_epoch !== signing.keyEpoch
        || row.subject_type !== 'user' || row.purpose !== 'dashboard' || Number(row.expires_at_ms) <= Date.now()
        || row.credential_id !== locator.credential_id || row.authority_node_id !== locator.authority_node_id) return null;
      const claims = JSON.parse(row.claims_json);
      if (claims.sub !== row.subject_id || claims.jti !== row.credential_id || claims.purpose !== row.purpose
        || claims.material_version !== Number(row.material_version) || claims.key_epoch !== row.key_epoch
        || claims.signing_domain !== row.domain_id || claims.exp * 1000 !== Number(row.expires_at_ms)
        || !jwtTimesValid(claims)) return null;
      if (described && (row.claims_json !== described.claimsJson || row.header_json !== described.headerJson
        || Number(row.expires_at_ms) !== described.expiresAtMs)) return null;
      const node = this.db.query(`SELECT * FROM multiremi_authority_nodes WHERE node_id = ?`).get(row.authority_node_id);
      if (!node || node.kind !== 'jwt_material' || node.subject_type !== row.subject_type || node.subject_id !== row.subject_id
        || Number(node.issued_seq) !== Number(row.authority_seq) || Number(node.generation) !== Number(row.authority_generation)
        || Number(node.continuous_parent_count) < 1 || Number(row.expires_at_ms) > Number(node.expires_at_ms)) return null;
      this.assertSource(tx, {
        nodeId: row.authority_node_id, generation: Number(row.authority_generation), familyId: row.family_id,
        subjectType: row.subject_type, subjectId: row.subject_id, expiresAtMs: Number(row.expires_at_ms),
      });
      return { userId: row.subject_id, digest, credential: {id: String(row.credential_id), version: Number(row.material_version)},
        familyId: String(row.family_id), expiresAtMs:Number(row.expires_at_ms), node: {nodeId: String(row.authority_node_id), generation: Number(row.authority_generation)} };
    });
  }

  private assertDomain(signing: JwtSigningDomain): void {
    const domain = this.db.query('SELECT key_epoch,key_digest FROM multiremi_jwt_signing_domains WHERE domain_id = ?').get(signing.domainId);
    if (!domain || domain.key_epoch !== signing.keyEpoch || domain.key_digest !== compactJwtDigest(signing.secret)) {
      throw new SecurityAbort('root_authority_revoked');
    }
  }

  private assertSource(tx: SecurityTx, input: {
    nodeId: string; generation: number; familyId: string; subjectType: string; subjectId: string; expiresAtMs: number;
  }): void {
    assertUnrevokedAncestry(this.db, tx, { nodeId: input.nodeId, generation: input.generation });
    const family = this.db.query(`SELECT f.*,n.subject_type,n.subject_id FROM multiremi_credential_families f
      JOIN multiremi_authority_nodes n ON n.node_id = f.authority_node_id WHERE f.family_id = ?`).get(input.familyId);
    if (!family || family.revoked_at_ms !== null || input.expiresAtMs > Number(family.max_expires_at_ms)
      || family.subject_type !== input.subjectType || family.subject_id !== input.subjectId) throw new SecurityAbort('root_authority_revoked');
    const sources = this.db.query(`WITH RECURSIVE sources(node_id) AS (
      SELECT parent_id FROM multiremi_authority_edges WHERE child_id = ? AND dependency = 'continuous'
      UNION SELECT e.parent_id FROM multiremi_authority_edges e JOIN sources s ON e.child_id = s.node_id WHERE e.dependency = 'continuous'
    ) SELECT n.node_id,n.subject_type FROM sources s JOIN multiremi_authority_nodes n ON n.node_id = s.node_id`).all(input.nodeId);
    if (!sources.some(row => row.node_id === family.authority_node_id)
      || input.subjectType === 'user' && sources.some(row => row.subject_type === 'agent')) throw new SecurityAbort('root_authority_revoked');
  }
}

function describeJwt(token: string, signing: JwtSigningDomain): {
  claims: Record<string, any>; claimsJson: string; headerJson: string; expiresAtMs: number;
} | null {
  try {
    const [headerPart, claimsPart, signature, extra] = token.split('.');
    if (!headerPart || !claimsPart || !signature || extra !== undefined || !signing.secret) return null;
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8'));
    if (!header || !claims || Array.isArray(header) || Array.isArray(claims)) return null;
    const algorithm = ({ HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' } as Record<string, string>)[header.alg];
    if (!algorithm) return null;
    const expected = createHmac(algorithm, signing.secret).update(`${headerPart}.${claimsPart}`).digest('base64url');
    const actualBytes = Buffer.from(signature), expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)
      || !Number.isSafeInteger(claims.exp * 1000) || !jwtTimesValid(claims)) return null;
    return { claims, claimsJson: JSON.stringify(claims), headerJson: JSON.stringify(header), expiresAtMs: claims.exp * 1000 };
  } catch { return null; }
}

function jwtTimesValid(claims: Record<string, unknown>): boolean {
  const now = Date.now() / 1000;
  return typeof claims.exp === 'number' && now < claims.exp
    && (claims.nbf === undefined || typeof claims.nbf === 'number' && claims.nbf <= now)
    && (claims.iat === undefined || typeof claims.iat === 'number' && claims.iat <= now + 60);
}
