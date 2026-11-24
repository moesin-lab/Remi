import { createHash, randomUUID } from 'node:crypto';
import { applyInitialBatch } from './scm-ownership-classification.js';
import type { SqlDatabase } from './db/postgres.js';

interface Entry {
  entry_key: string;
  identity_json: string;
  text_json: string;
}

interface Difference {
  entry_key: string;
  old_digest: string | null;
  new_digest: string | null;
  before: Entry | null;
  after: Entry | null;
  kind: 'added' | 'deleted' | 'identity' | 'text';
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function inventoryDigest(entries: Entry[]): string {
  const hash = createHash('sha256').update('scm-inventory-v1\n');
  for (const entry of entries) hash.update(JSON.stringify([entry.entry_key, entry.identity_json, entry.text_json]) + '\n');
  return hash.digest('hex');
}

export function legacyInventory(db: SqlDatabase) {
  const level = Number(db.query('SELECT expand_level FROM multiremi_schema_meta WHERE singleton=1').get()?.expand_level);
  if (level !== 4 && level !== 5) throw new Error('Export the inventory from the isolated historical level 4 or 5 snapshot');
  const cutover = db.query('SELECT cursor_id,complete FROM multiremi_scm_ownership_cutover WHERE singleton=1').get();
  return { version: 1, level, checkpoint_present: Boolean(cutover), cursor: cutover?.cursor_id ?? '', complete: cutover?.complete ?? 0, entries: inventory(db) };
}

export function adoptLegacyInventory(db: SqlDatabase, bytes: Buffer, authorizedDigest: string, continuousIsolation: boolean) {
  if (createHash('sha256').update(bytes).digest('hex') !== authorizedDigest) throw new Error('Historical inventory does not match the independent target-specific anchor');
  const source = JSON.parse(bytes.toString('utf8')) as ReturnType<typeof legacyInventory>;
  if (source.version !== 1 || ![4,5].includes(source.level) || typeof source.cursor !== 'string' || ![0,1].includes(source.complete)
    || (!source.complete && !continuousIsolation) || !Array.isArray(source.entries)) throw new Error('Historical provenance or continuous isolation is missing');
  if (ownershipPhase(db)?.phase !== 'unknown') throw new Error('Only a database without trusted provenance may adopt a historical anchor');
  const cutover = db.query('SELECT cursor_id,complete FROM multiremi_scm_ownership_cutover WHERE singleton=1').get();
  if (Boolean(cutover) !== source.checkpoint_present || (cutover?.cursor_id ?? '') !== source.cursor || (cutover?.complete ?? 0) !== source.complete) throw new Error('Cutover checkpoint differs from the trusted source');
  const entries = ordered(source.entries);
  const id = randomUUID();
  return db.transaction(() => {
    const baseline = inventoryDigest(entries);
    db.run('INSERT INTO multiremi_scm_audit_generations(id,version,baseline,baseline_count,legacy_cursor,legacy_complete,legacy_present,anchor_digest) VALUES(?,1,?,?,?,?,?,?)',
      [id,baseline,entries.length,source.cursor,source.complete,Number(source.checkpoint_present),authorizedDigest]);
    for (const entry of entries) {
      if (source.level === 5 && entry.entry_key.startsWith('link:')) {
        const identity = JSON.parse(entry.identity_json);
        if (identity.attribution === null && ['auto','legacy'].includes(identity.source) && (source.complete || Buffer.compare(Buffer.from(identity.id),Buffer.from(source.cursor)) <= 0)) throw new Error('Unverified level 5 evidence gap');
      }
      db.run('INSERT INTO multiremi_scm_audit_entries(generation,entry_key,identity_json,text_json) VALUES(?,?,?,?)', [id,entry.entry_key,entry.identity_json,entry.text_json]);
    }
    db.run('INSERT INTO multiremi_scm_rollback_review(singleton) VALUES(1) ON CONFLICT(singleton) DO NOTHING');
    db.run("UPDATE multiremi_scm_audit_state SET phase='held',hold_id=? WHERE singleton=1", [id]);
    return { writersHeld: true, hold_id: id, baseline, count: entries.length };
  })();
}

function ordered(entries: Entry[]): Entry[] {
  return entries.sort((left, right) => Buffer.compare(Buffer.from(left.entry_key), Buffer.from(right.entry_key)));
}

function inventory(db: SqlDatabase): Entry[] {
  const entries: Entry[] = [];
  for (const table of ['link', 'projection'] as const) {
    const projection = table === 'projection';
    const alias = projection ? 'p' : 'l';
    const order = `${alias}.id COLLATE ${db.dialect === 'postgres' ? '"C"' : 'BINARY'}`;
    const columns = projection ? 'p.workspace_id,p.provider,p.connection_id,p.repository_id,p.external_id,p.number' :
      `l.workspace_id,l.issue_id,i.workspace_id AS issue_workspace,i.issue_key,i.issue_number,l.change_request_id,
       p.workspace_id AS pr_workspace,p.provider,p.connection_id,p.repository_id,p.external_id,p.number,
       l.source,l.active,l.linked_at,l.unlinked_at,e.attribution`;
    const source = projection ? 'multiremi_scm_change_requests p' : `multiremi_scm_issue_links l
      LEFT JOIN multiremi_issues i ON i.id=l.issue_id LEFT JOIN multiremi_scm_change_requests p ON p.id=l.change_request_id
      LEFT JOIN multiremi_scm_link_ownership e ON e.link_id=l.id`;
    let cursor: string | null = null;
    for (;;) {
      const rows = db.query(`SELECT ${alias}.id,${columns},p.source_branch,p.title,p.body FROM ${source}
        ${cursor === null ? '' : `WHERE ${order} > ?`} ORDER BY ${order} LIMIT 100`).all(...(cursor === null ? [] : [cursor]));
      const fields = projection ? ['id','workspace_id','provider','connection_id','repository_id','external_id','number'] :
        ['id','workspace_id','issue_id','issue_workspace','issue_key','issue_number','change_request_id','pr_workspace',
          'provider','connection_id','repository_id','external_id','number','source','active','linked_at','unlinked_at','attribution'];
      for (const row of rows) {
        const identity = Object.fromEntries(fields.map(field => [field,row[field]]));
        if (!projection) identity.effective_issue_key = row.issue_key || (Number(row.issue_number)>0 ? `MUL-${row.issue_number}` : row.issue_id);
        const texts = { branch: digest(row.source_branch), title: digest(row.title), body: digest(row.body) };
        entries.push({ entry_key: `${table}:${row.id}`, identity_json: JSON.stringify(identity), text_json: JSON.stringify(texts) });
      }
      if (rows.length < 100) break;
      cursor = rows.at(-1).id;
    }
  }
  return ordered(entries);
}

export function checkInitialInventory(db: SqlDatabase) {
  const entries = inventory(db);
  for (const entry of entries) {
    if (entry.entry_key.startsWith('link:')) {
      const identity = JSON.parse(entry.identity_json);
      delete identity.attribution;
      entry.identity_json = JSON.stringify(identity);
    }
  }
  const current = inventoryDigest(entries);
  const state = db.query('SELECT initial_digest FROM multiremi_scm_audit_state WHERE singleton=1').get();
  if (state.initial_digest && state.initial_digest !== current) throw new Error('Initial inventory changed; keep writers isolated');
  if (!state.initial_digest) db.run('UPDATE multiremi_scm_audit_state SET initial_digest=? WHERE singleton=1', [current]);
}

export function ownershipPhase(db: SqlDatabase) {
  return db.query('SELECT phase,hold_id FROM multiremi_scm_audit_state WHERE singleton=1').get();
}

function active(db: SqlDatabase) {
  const state = ownershipPhase(db);
  if (state?.phase !== 'held') throw new Error('No captured rollback baseline for this database');
  return db.query('SELECT * FROM multiremi_scm_audit_generations WHERE id=? AND finished=0').get(state.hold_id);
}

export function holdScmWritersForReview(db: SqlDatabase) {
  const state = ownershipPhase(db);
  if (state?.phase === 'held') {
    const generation = active(db);
    return { writersHeld: true, hold_id: generation.id, baseline: generation.baseline, count: generation.baseline_count };
  }
  if (state?.phase !== 'ready' && state?.phase !== 'capturing') throw new Error('Trusted pre-rollback baseline unavailable. Keep writers isolated.');
  const starting = state.phase === 'ready';
  if (starting && db.query('SELECT singleton FROM multiremi_scm_rollback_review').get()) {
    throw new Error('Legacy hold has no captured pre-rollback baseline; keep writers isolated');
  }
  const id: string = starting ? randomUUID() : state.hold_id;
  if (starting) db.transaction(() => {
    db.run('INSERT INTO multiremi_scm_rollback_review(singleton) VALUES(1) ON CONFLICT(singleton) DO NOTHING');
    db.run("UPDATE multiremi_scm_audit_state SET phase='capturing',hold_id=? WHERE singleton=1", [id]);
    db.run('INSERT INTO multiremi_scm_audit_generations(id,version) VALUES(?,1)', [id]);
  })();
  const entries = inventory(db);
  const baseline = inventoryDigest(entries);
  if (starting) db.run('UPDATE multiremi_scm_audit_generations SET baseline=?,baseline_count=? WHERE id=?', [baseline,entries.length,id]);
  const anchored = db.query('SELECT baseline,baseline_count FROM multiremi_scm_audit_generations WHERE id=?').get(id);
  if (anchored?.baseline !== baseline || anchored.baseline_count !== entries.length) throw new Error('Incomplete capture lacks a matching pre-rollback anchor; keep writers isolated');
  for (let offset=0; offset<entries.length; offset+=100) db.transaction(() => {
    for (const entry of entries.slice(offset,offset+100)) db.run(`INSERT INTO multiremi_scm_audit_entries(generation,entry_key,identity_json,text_json) VALUES(?,?,?,?)
      ON CONFLICT(generation,entry_key) DO NOTHING`, [id, entry.entry_key, entry.identity_json, entry.text_json]);
  })();
  return db.transaction(() => {
    if (inventoryDigest(captured(db,id)) !== baseline) throw new Error('Incomplete or altered rollback baseline');
    db.run("UPDATE multiremi_scm_audit_state SET phase='held' WHERE singleton=1");
    return { writersHeld: true, hold_id: id, baseline, count: entries.length };
  })();
}

function changes(before: Entry[], after: Entry[]): Difference[] {
  const old = new Map(before.map(entry => [entry.entry_key, entry]));
  const current = new Map(after.map(entry => [entry.entry_key, entry]));
  const differences: Difference[] = [];
  for (const key of [...new Set([...old.keys(), ...current.keys()])].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
    const prior = old.get(key), next = current.get(key);
    const kind = !prior ? 'added' : !next ? 'deleted' : prior.identity_json !== next.identity_json ? 'identity' : prior.text_json !== next.text_json ? 'text' : null;
    if (kind) differences.push({ entry_key: key, old_digest: prior ? inventoryDigest([prior]) : null,
      new_digest: next ? inventoryDigest([next]) : null, before: prior ?? null, after: next ?? null, kind });
  }
  return differences;
}

function captured(db: SqlDatabase, generation: string): Entry[] {
  const entries: Entry[] = [];
  const order = `entry_key COLLATE ${db.dialect === 'postgres' ? '"C"' : 'BINARY'}`;
  let cursor = '';
  for (;;) {
    const page = db.query(`SELECT entry_key,identity_json,text_json FROM multiremi_scm_audit_entries
      WHERE generation=? AND ${order}>? ORDER BY ${order} LIMIT 100`).all(generation,cursor);
    entries.push(...page);
    if (page.length < 100) return entries;
    cursor = page.at(-1).entry_key;
  }
}

function synchronize(db: SqlDatabase) {
  const generation = active(db);
  const before = captured(db,generation.id);
  if (before.length !== generation.baseline_count || inventoryDigest(before) !== generation.baseline) throw new Error('Captured baseline integrity check failed');
  const after = inventory(db);
  const differences = changes(before, after);
  const differenceDigest = digest(differences);
  const afterDigest = inventoryDigest(after);
  let revision = generation.revision;
  if (generation.difference_digest !== differenceDigest || generation.after_digest !== afterDigest) {
    revision = randomUUID();
    for (const item of differences) db.run(`INSERT INTO multiremi_scm_audit_changes(generation,revision,entry_key,old_digest,new_digest,kind,before_json,after_json) VALUES(?,?,?,?,?,?,?,?)`,
      [generation.id,revision,item.entry_key,item.old_digest,item.new_digest,item.kind,JSON.stringify(item.before),JSON.stringify(item.after)]);
    db.run('UPDATE multiremi_scm_audit_generations SET revision=?,difference_digest=?,after_digest=? WHERE id=?', [revision,differenceDigest,afterDigest,generation.id]);
  }
  return { hold_id: generation.id, baseline: generation.baseline, revision, difference_digest: differenceDigest, total: differences.length };
}

export function auditScmRollback(db: SqlDatabase, options: { after?: string; review?: unknown; finalize?: unknown } = {}) {
  const state = ownershipPhase(db);
  if (state?.phase === 'ready' && options.finalize && typeof options.finalize === 'object' && !db.query('SELECT singleton FROM multiremi_scm_rollback_review').get()) {
    const generation = db.query('SELECT * FROM multiremi_scm_audit_generations WHERE id=? AND finished=1').get(state.hold_id);
    if (generation) {
      const total = Number(db.query('SELECT COUNT(*) AS n FROM multiremi_scm_audit_changes WHERE revision=?').get(generation.revision).n);
      const receipt = { hold_id: generation.id, baseline: generation.baseline, revision: generation.revision, difference_digest: generation.difference_digest, total };
      const received = options.finalize as Record<string, unknown>;
      if (Object.keys(received).length === Object.keys(receipt).length && Object.entries(receipt).every(([key,value]) => received[key] === value)) return { complete: true, ...receipt };
    }
  }
  const header = db.transaction(() => synchronize(db))();
  return db.transaction(() => {
    const packet = options.review ?? options.finalize;
    const operation = options.review !== undefined ? 'review' : options.finalize !== undefined ? 'finalize' : null;
    if (operation === 'finalize') {
      const rechecked = synchronize(db);
      if (rechecked.revision !== header.revision) throw new Error('Inventory changed during finalization');
    }
    if (operation) {
      if (!packet || typeof packet !== 'object') throw new Error('Expected a generation-bound audit receipt');
      const fields = packet as Record<string, unknown>;
      const allowed = new Set([...Object.keys(header), ...(operation === 'review' ? ['after','items'] : [])]);
      if (Object.keys(fields).some(key => !allowed.has(key)) || Object.entries(header).some(([key, value]) => fields[key] !== value)) throw new Error('Stale, invalid or foreign audit receipt');
      if (operation === 'finalize') {
        const pending = db.query('SELECT entry_key FROM multiremi_scm_audit_changes WHERE revision=? AND reviewed=0 LIMIT 1').get(header.revision);
        const unresolvedIdentity = db.query("SELECT entry_key FROM multiremi_scm_audit_changes WHERE generation=? AND kind <> 'text' LIMIT 1").get(header.hold_id);
        if (pending || unresolvedIdentity) throw new Error('Unresolved rollback differences; keep writers isolated');
        const generation = active(db);
        if (generation.anchor_digest) {
          const cutover = db.query('SELECT cursor_id,complete FROM multiremi_scm_ownership_cutover WHERE singleton=1').get();
          if (Number(Boolean(cutover)) !== generation.legacy_present || (cutover?.cursor_id ?? '') !== generation.legacy_cursor || (cutover?.complete ?? 0) !== generation.legacy_complete) throw new Error('Historical checkpoint changed');
          if (!generation.legacy_complete && header.total) throw new Error('Partial historical cutover needs continuous isolation of the same snapshot');
          db.run(`INSERT INTO multiremi_scm_link_ownership(link_id,attribution)
            SELECT l.id,'[]' FROM multiremi_scm_issue_links l LEFT JOIN multiremi_scm_link_ownership e ON e.link_id=l.id
            WHERE l.source IN ('auto','legacy') AND e.link_id IS NULL AND (?=1 OR l.id<=?)`, [generation.legacy_complete,generation.legacy_cursor]);
          if (!generation.legacy_complete) {
            db.run("UPDATE multiremi_scm_audit_state SET phase='initial' WHERE singleton=1");
            while (!applyInitialBatch(db,250)) continue;
            db.run("UPDATE multiremi_scm_ownership_cutover SET complete=1 WHERE singleton=1");
          }
        }
        db.run('UPDATE multiremi_scm_audit_generations SET finished=1 WHERE id=?', [header.hold_id]);
        db.run("UPDATE multiremi_scm_audit_state SET phase='ready' WHERE singleton=1");
        db.run('DELETE FROM multiremi_scm_rollback_review WHERE singleton=1');
        return { complete: true, ...header };
      }
    }
    const submitted = options.review as Record<string, unknown> | undefined;
    let after = submitted ? submitted.after : options.after ?? '';
    if (typeof after !== 'string') throw new Error('Invalid page cursor');
    const order = `entry_key COLLATE ${db.dialect === 'postgres' ? '"C"' : 'BINARY'}`;
    if (!submitted && options.after === undefined) {
      const firstPending = db.query(`SELECT entry_key FROM multiremi_scm_audit_changes WHERE revision=? AND reviewed=0 ORDER BY ${order} LIMIT 1`).get(header.revision);
      if (firstPending) after = db.query(`SELECT entry_key FROM multiremi_scm_audit_changes WHERE revision=? AND ${order}<? ORDER BY ${order} DESC LIMIT 1`).get(header.revision,firstPending.entry_key)?.entry_key ?? '';
    }
    if (after) {
      const prefix = db.query(`SELECT COUNT(*) AS n,SUM(CASE WHEN reviewed=0 THEN 1 ELSE 0 END) AS outstanding
        FROM multiremi_scm_audit_changes WHERE revision=? AND ${order}<=?`).get(header.revision,after);
      if (Number(prefix.n)%25 !== 0 || !db.query('SELECT entry_key FROM multiremi_scm_audit_changes WHERE revision=? AND entry_key=?').get(header.revision,after)
        || (submitted && Number(prefix.outstanding)>0)) throw new Error('Invalid or out-of-order audit page cursor');
    }
    const rows = db.query(`SELECT entry_key,old_digest,new_digest,kind,reviewed FROM multiremi_scm_audit_changes
      WHERE revision=? AND ${order}>? ORDER BY ${order} LIMIT 26`).all(header.revision, after);
    const page = rows.slice(0,25);
    if (submitted) {
      const items = submitted.items;
      if (!page.length || !Array.isArray(items) || items.length !== page.length) throw new Error('Submit one full audit page');
      for (const [index,row] of page.entries()) {
        const item = items[index];
        if (row.kind !== 'text' || !item || item.entry_key !== row.entry_key || item.old_digest !== row.old_digest || item.new_digest !== row.new_digest || item.disposition !== 'retain-frozen' || Object.keys(item).length !== 4) throw new Error('Unverifiable identity or invalid review; keep writers isolated');
        db.run('UPDATE multiremi_scm_audit_changes SET reviewed=1 WHERE revision=? AND entry_key=?', [header.revision,row.entry_key]);
        row.reviewed=1;
      }
    }
    const reviewed = Number(db.query('SELECT COUNT(*) AS n FROM multiremi_scm_audit_changes WHERE revision=? AND reviewed=1').get(header.revision).n);
    const blockedHistory = Number(db.query(`SELECT COUNT(*) AS n FROM multiremi_scm_audit_changes
      WHERE generation=? AND revision<>? AND kind<>'text'`).get(header.hold_id,header.revision).n);
    return { writersHeld: true, receipt: header, blocked_history: blockedHistory, reviewed, pending: header.total-reviewed, after, entries: page, next: rows.length>25 ? page.at(-1).entry_key : null };
  })();
}
