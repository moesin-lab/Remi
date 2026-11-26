import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { MultiremiStore } from '@multiremi/store.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { classifyScmLinks, scmOwnershipReady } from '@multiremi/store/scm-ownership.js';
import { adoptLegacyInventory, auditScmRollback, holdScmWritersForReview, legacyInventory } from '@multiremi/store/scm-rollback-audit.js';
import { migratedStoreBackend } from '../../helpers/migrated-store-backends.js';
import historicalCutovers from '../../fixtures/scm-cutover-historical.json';
import { runStartupMigrations } from '@multiremi/store/migrations.js';

for (const dialect of ['wal', 'delete', 'postgres'] as const) {
  describe.skipIf(dialect === 'postgres' && !process.env.MULTIREMI_TEST_POSTGRES_URL)(`SCM rollback audit (${dialect})`, () => {
    const backend = migratedStoreBackend(dialect === 'postgres' ? 'postgres' : 'sqlite', { prefix: 'scm_audit_', fixture: 'scm-rollback-audit' });
    if (dialect === 'postgres') backend.install();
    async function fixture() {
      if (dialect === 'postgres') return backend.open();
      const dir = mkdtempSync(join(tmpdir(), 'scm-audit-'));
      const db = openSqliteDatabase(join(dir, 'data.sqlite'), { create: true });
      db.exec(`PRAGMA journal_mode=${dialect}`);
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      return { db: db as SqlDatabase, store, close: async () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
    }

    function projections(db: SqlDatabase, count: number) {
      db.exec(`INSERT INTO multiremi_scm_connections(id,name,provider,base_url,api_base_url,created_at,updated_at)
        VALUES ('fixture','fixture','github','https://github.com','https://api.github.com','now','now')`);
      for (let index=0; index<count; index++) db.run(`INSERT INTO multiremi_scm_change_requests
        (id,workspace_id,connection_id,repository_id,provider,external_id,number,title,state,created_at,updated_at)
        VALUES (?,'local','fixture','repo','github',?,?,'original','open','now','now')`, [`pr${index}`,String(index),index+1]);
    }
    const report = (db: SqlDatabase, after?: string) => {
      const result = auditScmRollback(db,{ after });
      if (!('receipt' in result) || !result.receipt || !result.entries) throw new Error('Expected pending audit');
      return result;
    };
    const packet = (page: ReturnType<typeof report>) => ({ ...page.receipt, after: page.after,
      items: page.entries!.map(row => ({ entry_key: row.entry_key, old_digest: row.old_digest, new_digest: row.new_digest, disposition: 'retain-frozen' })) });

    function restoreInventoryStage(db: SqlDatabase, level: number) {
      db.exec(`DROP TABLE multiremi_scm_audit_changes; DROP TABLE multiremi_scm_audit_entries;
        DROP TABLE multiremi_scm_audit_generations; DROP TABLE multiremi_scm_audit_state`);
      if (level === 4 || level === 7) db.exec('DROP TABLE multiremi_scm_rollback_review');
      if (level < 7) {
        db.exec(`DROP TABLE multiremi_feishu_command_results; ALTER TABLE multiremi_feishu_bot_configs DROP COLUMN wake_words_json;
          DROP TABLE multiremi_attempt_system_prompts; DROP TABLE multiremi_system_prompt_versions; DROP TABLE multiremi_system_prompt_documents;
          DELETE FROM multiremi_schema_steps WHERE level BETWEEN 4 AND 6;
          UPDATE multiremi_schema_steps SET id='20261124_scm_link_ownership', level=4 WHERE level=7;
          UPDATE multiremi_schema_steps SET id='20261124_scm_rollback_review', level=5 WHERE level=8`);
      }
      db.run('DELETE FROM multiremi_schema_steps WHERE level>?', [level]);
      db.run('UPDATE multiremi_schema_meta SET expand_level=?', [level]);
    }

    for (const level of [4, 5, 7, 8]) it(`holds stage ${level} with no checkpoint across startup`, async () => {
      const { db, close } = await fixture();
      try {
        restoreInventoryStage(db, level);
        runStartupMigrations(db);
        runStartupMigrations(db);
        expect(db.query('SELECT phase FROM multiremi_scm_audit_state').get()).toEqual({ phase: 'unknown' });
        expect(scmOwnershipReady(db)).toBe(false);
      } finally { await close(); }
    });

    it('rejects a main or mixed snapshot and refuses a malformed historical startup before writes', async () => {
      const { db, close } = await fixture();
      try {
        restoreInventoryStage(db, 7);
        db.run('UPDATE multiremi_schema_meta SET expand_level=4');
        expect(() => legacyInventory(db)).toThrow('lineage');
        db.run("UPDATE multiremi_schema_steps SET id='20261124_scm_link_ownership' WHERE level=7");
        expect(() => runStartupMigrations(db)).toThrow('historical SCM');
        expect(db.query('SELECT expand_level FROM multiremi_schema_meta').get()).toEqual({ expand_level: 4 });
        expect(db.query('SELECT phase FROM multiremi_schema_steps WHERE level=8').get()).toBeNull();
      } finally { await close(); }
    });

    for (const source of historicalCutovers) it(`matches the canonical inventory emitted from ${source.sha ?? source.step_id} and preserves its weak link and tombstone`, async () => {
      const {db,store,close}=await fixture();
      try {
        projections(db,1);
        const owners=source.links.map(link=>store.createIssue({id:link.issue_id,workspaceId:'local',title:link.issue_id}));
        db.run("UPDATE multiremi_scm_change_requests SET external_id='123',title=?,body=?",[owners[0].key,`Mentions ${owners[1].key}`]);
        for (const link of source.links) {
          db.run(`INSERT INTO multiremi_scm_issue_links(id,workspace_id,issue_id,change_request_id,source,active,linked_at,created_at,updated_at)
            VALUES (?,'local',?,'pr0',?,?,'then','then','then')`,[link.id,link.issue_id,link.source,link.active]);
          if (link.attribution !== null) db.run('INSERT INTO multiremi_scm_link_ownership(link_id,attribution) VALUES(?,?)',[link.id,link.attribution]);
        }
        restoreInventoryStage(db, source.level);
        db.run('INSERT INTO multiremi_scm_ownership_cutover(singleton,cursor_id,complete) VALUES(1,?,?)',[source.checkpoint.cursor_id,source.checkpoint.complete]);
        const archive=Buffer.from(JSON.stringify(legacyInventory(db))+'\n');
        expect(createHash('sha256').update(archive).digest('hex')).toBe(source.archive_sha256);
        runStartupMigrations(db);
        expect(()=>classifyScmLinks(db)).toThrow('baseline unavailable');
        expect(()=>holdScmWritersForReview(db)).toThrow('baseline unavailable');
        if (source.level === 5 || source.level === 8) {
          const gap = JSON.parse(archive.toString());
          const entry = gap.entries.find((row: {entry_key: string}) => row.entry_key === 'link:a');
          entry.identity_json = JSON.stringify({ ...JSON.parse(entry.identity_json), attribution: null });
          const bytes = Buffer.from(JSON.stringify(gap));
          expect(() => adoptLegacyInventory(db, bytes, createHash('sha256').update(bytes).digest('hex'), false)).toThrow(`level ${source.level} evidence gap`);
        }
        adoptLegacyInventory(db,archive,source.archive_sha256,false);
        runStartupMigrations(db);
        const unchanged=report(db);
        expect(unchanged.pending).toBe(0);
        auditScmRollback(db,{finalize:unchanged.receipt});
        expect(scmOwnershipReady(db)).toBe(true);
        expect(db.query('SELECT link_id,attribution FROM multiremi_scm_link_ownership ORDER BY link_id').all()).toEqual([
          {link_id:'a',attribution:'["title"]'},{link_id:'b',attribution:'[]'},
        ]);
        expect(store.listScmChangeRequestsForIssue(owners[2].id)).toEqual([]);
      } finally { await close(); }
    },30_000);

    function interrupt(db: SqlDatabase, table: string, operation: 'INSERT' | 'UPDATE', predicate: string) {
      if (dialect === 'postgres') {
        db.run("CREATE OR REPLACE FUNCTION interrupt_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'interrupted audit'; END; $$");
        db.run(`CREATE TRIGGER interrupt_audit BEFORE ${operation} ON ${table} FOR EACH ROW WHEN (${predicate}) EXECUTE FUNCTION interrupt_audit()`);
      } else {
        db.exec(`CREATE TRIGGER interrupt_audit BEFORE ${operation} ON ${table} WHEN ${predicate} BEGIN SELECT RAISE(ABORT,'interrupted audit'); END`);
      }
      return () => db.run(`DROP TRIGGER interrupt_audit${dialect === 'postgres' ? ` ON ${table}` : ''}`);
    }

    it('resumes anchored capture, difference staging, review and final commit after interrupted transactions', async () => {
      const { db,close }=await fixture();
      try {
        projections(db,101);
        classifyScmLinks(db);
        let resume=interrupt(db,'multiremi_scm_audit_entries','INSERT',"NEW.entry_key='projection:pr99'");
        expect(()=>holdScmWritersForReview(db)).toThrow('interrupted audit');
        expect(scmOwnershipReady(db)).toBe(false);
        expect(Number(db.query('SELECT COUNT(*) AS n FROM multiremi_scm_audit_entries').get().n)).toBe(100);
        resume();
        db.exec("UPDATE multiremi_scm_change_requests SET title='changed' WHERE id='pr99'");
        expect(()=>holdScmWritersForReview(db)).toThrow('matching pre-rollback anchor');
        db.exec("UPDATE multiremi_scm_change_requests SET title='original' WHERE id='pr99'");
        holdScmWritersForReview(db);
        db.exec("UPDATE multiremi_scm_change_requests SET title='clean' WHERE id IN ('pr1','pr2')");
        resume=interrupt(db,'multiremi_scm_audit_changes','INSERT',"NEW.entry_key='projection:pr2'");
        expect(()=>report(db)).toThrow('interrupted audit');
        expect(Number(db.query('SELECT COUNT(*) AS n FROM multiremi_scm_audit_changes').get().n)).toBe(0);
        resume();
        const page=report(db);
        resume=interrupt(db,'multiremi_scm_audit_changes','UPDATE',"NEW.entry_key='projection:pr2'");
        expect(()=>auditScmRollback(db,{review:packet(page)})).toThrow('interrupted audit');
        expect(report(db).reviewed).toBe(0);
        resume();
        auditScmRollback(db,{review:packet(page)});
        resume=interrupt(db,'multiremi_scm_audit_state','UPDATE',"NEW.phase='ready'");
        expect(()=>auditScmRollback(db,{finalize:page.receipt})).toThrow('interrupted audit');
        expect(scmOwnershipReady(db)).toBe(false);
        resume();
        auditScmRollback(db,{finalize:page.receipt});
        expect(scmOwnershipReady(db)).toBe(true);
      } finally { await close(); }
    },30_000);

    for (const count of [26,51]) it(`stages ${count} text-only changes by generation and releases only after finalization`, async () => {
      const { db,close } = await fixture();
      try {
        projections(db,count);
        classifyScmLinks(db);
        const hold = holdScmWritersForReview(db);
        expect(holdScmWritersForReview(db)).toEqual(hold);
        db.exec("UPDATE multiremi_scm_change_requests SET title='clean'");
        const first = report(db);
        expect(first.pending).toBe(count);
        expect(() => auditScmRollback(db,{ finalize: first.receipt })).toThrow('Unresolved');
        const second = report(db,first.next);
        expect(() => auditScmRollback(db,{ review: packet(second) })).toThrow('out-of-order');
        const forged = packet(first);
        forged.items.at(-1)!.old_digest='unverified';
        expect(() => auditScmRollback(db,{ review: forged })).toThrow();
        expect(report(db).reviewed).toBe(0);
        expect(() => auditScmRollback(db,{ review: { ...packet(first), hold_id: 'another-db' } })).toThrow('foreign');
        let page = first;
        for (;;) {
          auditScmRollback(db,{ review: packet(page) });
          auditScmRollback(db,{ review: packet(page) });
          expect(scmOwnershipReady(db)).toBe(false);
          if (!page.next) break;
          page=report(db,page.next);
        }
        expect(report(db).pending).toBe(0);
        expect(auditScmRollback(db,{ finalize: first.receipt })).toMatchObject({ complete: true });
        expect(auditScmRollback(db,{ finalize: first.receipt })).toMatchObject({ complete: true });
        expect(scmOwnershipReady(db)).toBe(true);
        const nextHold=holdScmWritersForReview(db);
        expect(nextHold.hold_id).not.toBe(hold.hold_id);
        expect(() => auditScmRollback(db,{ finalize: first.receipt })).toThrow('foreign');
        const zero=report(db);
        expect(zero.pending).toBe(0);
        expect(scmOwnershipReady(db)).toBe(false);
        auditScmRollback(db,{ finalize: zero.receipt });
        expect(scmOwnershipReady(db)).toBe(true);
      } finally { await close(); }
    });

    it('enumerates 26 then 51 unverified new links without publishing any historical owner', async () => {
      const {db,store,close}=await fixture();
      try {
        projections(db,51);
        const issue=store.createIssue({workspaceId:'local',title:'New links'});
        classifyScmLinks(db);
        holdScmWritersForReview(db);
        const insert=`INSERT INTO multiremi_scm_issue_links(id,workspace_id,issue_id,change_request_id,source,active,linked_at,created_at,updated_at)
          SELECT id,'local',?,id,'auto',1,'then','then','then' FROM multiremi_scm_change_requests WHERE number BETWEEN ? AND ?`;
        db.run(insert,[issue.id,1,26]);
        const first=report(db);
        expect(first.pending).toBe(26);
        expect(report(db,first.next).entries).toHaveLength(1);
        db.run(insert,[issue.id,27,51]);
        expect(()=>auditScmRollback(db,{review:packet(first)})).toThrow('foreign');
        let current=report(db);
        expect(current.pending).toBe(51);
        const keys=new Set();
        for (;;) {
          for (const item of current.entries!) {
            expect(item.kind).toBe('added');
            keys.add(item.entry_key);
          }
          if (!current.next) break;
          current=report(db,current.next);
        }
        expect(keys.size).toBe(51);
        expect(()=>auditScmRollback(db,{finalize:current.receipt})).toThrow('Unresolved');
        expect(db.query('SELECT link_id FROM multiremi_scm_link_ownership').all()).toEqual([]);
        expect(scmOwnershipReady(db)).toBe(false);
      } finally { await close(); }
    });

    it('detects external identity drift, tombstone revival, source changes and balanced deletion/addition', async () => {
      const { db,store,close }=await fixture();
      try {
        projections(db,3);
        const issue=store.createIssue({workspaceId:'local',title:'Issue'});
        const destination = store.createWorkspace({ name: 'Moved issue' });
        db.run("UPDATE multiremi_scm_change_requests SET repository_id='another-repo',number=1 WHERE id='pr1'");
        db.run(`INSERT INTO multiremi_scm_issue_links(id,workspace_id,issue_id,change_request_id,source,active,linked_at,created_at,updated_at)
          VALUES ('link','local',?,'pr0','manual',0,'then','then','then')`,[issue.id]);
        classifyScmLinks(db);
        holdScmWritersForReview(db);
        db.exec("UPDATE multiremi_scm_change_requests SET external_id='456' WHERE id='pr0'");
        const drift=report(db);
        expect(drift.entries!.map(row=>row.kind)).toEqual(['identity','identity']);
        expect(() => auditScmRollback(db,{finalize:drift.receipt})).toThrow('Unresolved');
        db.run('UPDATE multiremi_issues SET workspace_id=? WHERE id=?', [destination.id, issue.id]);
        db.run("UPDATE multiremi_scm_issue_links SET change_request_id='pr1' WHERE id='link'");
        const moved = report(db);
        expect(moved.entries!.find(row => row.entry_key === 'link:link')?.new_digest).not.toBe(drift.entries![0].new_digest);
        expect(() => auditScmRollback(db, { finalize: moved.receipt })).toThrow('Unresolved');
        db.run("UPDATE multiremi_scm_issue_links SET change_request_id='pr0' WHERE id='link'");
        db.exec("UPDATE multiremi_scm_issue_links SET active=1,source='auto'; DELETE FROM multiremi_scm_change_requests WHERE id='pr2'; UPDATE multiremi_scm_change_requests SET id='pr3' WHERE id='pr1'");
        const later=report(db);
        expect(later.entries!.map(row=>row.kind)).toContain('added');
        expect(later.entries!.map(row=>row.kind)).toContain('deleted');
        expect(() => auditScmRollback(db,{review:packet(drift)})).toThrow('foreign');
        expect(() => auditScmRollback(db,{review:packet(later)})).toThrow('Unverifiable');
        expect(scmOwnershipReady(db)).toBe(false);
        expect(store.listIssueActivity(issue.id).filter(row=>row.type==='scm_merge_completed')).toEqual([]);
        expect(Number(db.query('SELECT COUNT(*) AS n FROM multiremi_scm_effects').get().n)).toBe(0);
      } finally { await close(); }
    });

    it('protects the legacy cursor prefix and resumes its suffix only with independently verified isolation', async () => {
      const {db,store,close}=await fixture();
      try {
        projections(db,2);
        const issue=store.createIssue({workspaceId:'local',title:'Historical partial classification'});
        for (const [link,pr] of [['a','pr0'],['z','pr1']]) db.run(`INSERT INTO multiremi_scm_issue_links
          (id,workspace_id,issue_id,change_request_id,source,active,linked_at,created_at,updated_at)
          VALUES (?,'local',?,?,'auto',1,'then','then','then')`,[link,issue.id,pr]);
        db.run('UPDATE multiremi_scm_change_requests SET title=?',[issue.key]);
        restoreInventoryStage(db, 7);
        db.exec("INSERT INTO multiremi_scm_ownership_cutover(singleton,cursor_id,complete) VALUES(1,'a',0)");
        const bytes=Buffer.from(JSON.stringify(legacyInventory(db)));
        const pin=createHash('sha256').update(bytes).digest('hex');
        runStartupMigrations(db);
        expect(()=>adoptLegacyInventory(db,bytes,pin,false)).toThrow('isolation');
        adoptLegacyInventory(db,bytes,pin,true);
        const unchanged=report(db);
        expect(unchanged.pending).toBe(0);
        expect(scmOwnershipReady(db)).toBe(false);
        auditScmRollback(db,{finalize:unchanged.receipt});
        expect(db.query('SELECT link_id,attribution FROM multiremi_scm_link_ownership ORDER BY link_id').all()).toEqual([
          {link_id:'a',attribution:'[]'},{link_id:'z',attribution:'["title"]'},
        ]);
      } finally { await close(); }
    });

    it('accepts only independently pinned legacy weak evidence; freezes it at finalization', async () => {
      const {db,store,close}=await fixture();
      try {
        projections(db,1);
        const issue=store.createIssue({workspaceId:'local',title:'Old weak mention'});
        db.run(`INSERT INTO multiremi_scm_issue_links(id,workspace_id,issue_id,change_request_id,source,active,linked_at,created_at,updated_at)
          VALUES ('weak','local',?,'pr0','auto',0,'then','then','then')`,[issue.id]);
        restoreInventoryStage(db, 7);
        db.exec("INSERT INTO multiremi_scm_ownership_cutover(singleton,cursor_id,complete) VALUES(1,'weak',1)");
        const bytes=Buffer.from(JSON.stringify(legacyInventory(db)));
        const pinned=createHash('sha256').update(bytes).digest('hex');
        runStartupMigrations(db);
        expect(()=>classifyScmLinks(db)).toThrow('baseline unavailable');
        expect(()=>adoptLegacyInventory(db,Buffer.from('unverified'),pinned,false)).toThrow('independent');
        adoptLegacyInventory(db,bytes,pinned,false);
        const page=report(db);
        expect(db.query('SELECT * FROM multiremi_scm_link_ownership').all()).toEqual([]);
        auditScmRollback(db,{finalize:page.receipt});
        expect(db.query('SELECT attribution FROM multiremi_scm_link_ownership').get()).toEqual({attribution:'[]'});
        expect(store.listScmChangeRequestsForIssue(issue.id)).toEqual([]);
      } finally { await close(); }
    });
  });
}
