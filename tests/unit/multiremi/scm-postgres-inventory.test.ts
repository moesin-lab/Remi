import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { removeRootSchema } from '../../fixtures/root-schema-upgrade.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptPostgresInventory, databaseCommandSpecs, postgresInventoryTarget } from '../../../apps/remi/cli/commands/database.js';
import { PostgresSyncDatabase } from '@multiremi/store/db/postgres.js';
import { runStartupMigrations } from '@multiremi/store/migrations.js';
import { auditScmRollback, legacyInventory } from '@multiremi/store/scm-rollback-audit.js';

const fixtureUrl = 'postgres://fixture:secret@127.0.0.1:5432/MiX%20Case';

for (const variable of ['PGDATABASE','PG_DATABASE','PGPORT','PG_PORT','PGHOST','PG_HOST','PGHOSTADDR','PG_HOSTADDR','PGSERVICE','PGSERVICEFILE','PGOPTIONS']) {
  it(`refuses ${variable} before pin lookup or opening a client`, async () => {
    let lookedUp = false;
    await expect(adoptPostgresInventory('unused', { MULTIREMI_DATABASE_URL: fixtureUrl, [variable]: 'configured' }, () => {
      lookedUp = true;
      throw new Error('Unexpected pin lookup');
    })).rejects.toThrow(variable);
    expect(lookedUp).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'scm-env-'));
    try {
      const cli = Bun.spawnSync([process.execPath, 'apps/remi/main.ts', 'db', 'classify-scm-links','--adopt-inventory','unused'], {
        env: { PATH: process.env.PATH, HOME: dir, MULTIREMI_DATABASE_URL: fixtureUrl, [variable]: 'configured',
          BUN_INSTALL_CACHE_DIR: join(dir,'install'), BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(dir,'transpiler') },
      });
      expect(cli.exitCode).toBe(1);
      expect(cli.stderr.toString()).toContain(`Unset ${variable}`);
      expect(cli.stderr.toString()).not.toContain('secret');
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
}

it('rejects ambiguous endpoints, implicit database names and alternative routing', () => {
  for (const suffix of ['localhost:5432/a','127.0.0.1/a','127.0.0.1:0/a','127.0.0.1:65536/a','[fe80::1%25eth0]:5432/a',
    '127.1:5432/a','127.0.0.1:5432/','127.0.0.1:5432/a?','127.0.0.1:5432/a#','127.0.0.1:5432/a%2Fb',
    '127.0.0.1:5432/a%252Fb','127.0.0.1:5432/%2E','127.0.0.1:5432/a%00','127.0.0.1:5432/%FF','127.0.0.1:5432/a/b']) {
    expect(() => postgresInventoryTarget({ MULTIREMI_DATABASE_URL: `postgres://fixture:secret@${suffix}` })).toThrow('pinned direct');
  }
});

for (const [address, hostname] of [['127.0.0.1','127.0.0.1'], ['[0:0:0:0:0:0:0:1]','::1']]) {
  it.each([
    [undefined, 0], ['disable', 0], ['prefer', 1], ['require', 2], ['verify-ca', 3], ['verify-full', 4],
  ] as const)(`checks actual Bun worker client options for ${address} with PGSSLMODE=%s`, (mode, expectedMode) => {
    const dir = mkdtempSync(join(tmpdir(), 'scm-options-'));
    try {
      const workerFile = join(dir, 'options-worker.ts');
      writeFileSync(workerFile, `
        import { postgresInventoryTarget } from ${JSON.stringify(import.meta.resolve('../../../apps/remi/cli/commands/database.ts'))};
        import { connect } from ${JSON.stringify(import.meta.resolve('../../../packages/server/src/store/db/pg-worker.ts'))};
        const { url, target, key } = postgresInventoryTarget(process.env);
        const { options } = connect(url, true, target);
        postMessage({ key, host: options.hostname, port: options.port, database: options.database,
          adapter: options.adapter, auth: options.username === 'fixture' && options.password === 'secret', socket: !!options.path,
          configuredMode: new URL(url).searchParams.get('sslmode'), tlsMode: options.sslMode });`);
      const probe = Bun.spawnSync([process.execPath, '-e', `
        const worker = new Worker(process.argv[1]);
        worker.onerror = () => process.exit(1);
        worker.onmessage = event => { console.log(JSON.stringify(event.data)); process.exit(0); };`, workerFile], {
        timeout: 4000, env: { PATH: process.env.PATH, HOME: dir, ...(mode && { PGSSLMODE: mode }), BUN_INSTALL_CACHE_DIR: join(dir,'install'),
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(dir,'transpiler'), MULTIREMI_DATABASE_URL: fixtureUrl.replace('127.0.0.1',address) } });
      expect(probe.exitCode, probe.stderr.toString()).toBe(0);
      expect(JSON.parse(probe.stdout.toString())).toEqual({ key: `postgres://${hostname === '::1' ? '[::1]' : hostname}:5432/MiX%20Case`,
        host: hostname, port: 5432, database: 'MiX Case', adapter: 'postgres', auth: true, socket: false,
        configuredMode: mode ?? null, tlsMode: expectedMode });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
describe.skipIf(!adminUrl)('historical adoption on direct isolated PostgreSQL databases', () => {
  const prefix = `Scm_${randomUUID().replaceAll('-', '')}`;
  let admin: Bun.SQL, urlA: string, urlB: string, archive: string, directory: string, pinnedKey: string, sha256: string;
  const created: string[] = [];

  function inspect<Result>(url: string, operation: (db: PostgresSyncDatabase) => Result) {
    const db = new PostgresSyncDatabase(url);
    try { return operation(db); } finally { db.close(); }
  }

  function snapshot(url: string) {
    return inspect(url, db => ['audit_state','audit_generations','audit_entries','audit_changes','rollback_review'].map(table =>
      db.query(`SELECT * FROM multiremi_scm_${table}`).all()));
  }

  function invoke(url: string, env: NodeJS.ProcessEnv = {}, open?: Parameters<typeof adoptPostgresInventory>[3]) {
    const spec = databaseCommandSpecs(file => adoptPostgresInventory(file, { ...env, MULTIREMI_DATABASE_URL: url }, key => {
      if (key !== pinnedKey) throw new Error('No fixture pin for target');
      return { sha256 };
    }, open)).find(entry => entry.id === 'db.classify-scm-links')!;
    return spec.run({ spec, options: { 'adopt-inventory': archive }, matchedPath: spec.path, positionals: [], rawArgs: [], alias: null });
  }

  beforeAll(async () => {
    const direct = new URL(adminUrl!);
    if (!['127.0.0.1','localhost','[::1]'].includes(direct.hostname)) throw new Error('Requires isolated loopback PostgreSQL fixture');
    admin = new Bun.SQL(adminUrl!, { max: 1 });
    const [endpoint] = await admin`SELECT host(inet_server_addr()) AS address, inet_server_port() AS port`;
    direct.hostname = endpoint.address.includes(':') ? `[${endpoint.address}]` : endpoint.address;
    direct.port = String(endpoint.port);
    directory = mkdtempSync(join(tmpdir(), 'scm-adopt-pg-'));
    archive = join(directory,'history.json');
    async function create(name: string, template?: string) {
      await admin.unsafe(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ''}`);
      created.push(name);
      direct.pathname = `/${name}`;
      return direct.href;
    }
    const template = await create(prefix);
    const bytes = inspect(template, db => {
      runStartupMigrations(db);
      removeRootSchema(db);
      db.exec(`DROP TABLE multiremi_scm_audit_changes; DROP TABLE multiremi_scm_audit_entries; DROP TABLE multiremi_scm_audit_generations; DROP TABLE multiremi_scm_audit_state;
        DELETE FROM multiremi_schema_steps WHERE level>=9; UPDATE multiremi_schema_meta SET expand_level=8;
        INSERT INTO multiremi_scm_ownership_cutover(singleton,cursor_id,complete) VALUES(1,'',1);
        INSERT INTO multiremi_scm_connections(id,name,provider,base_url,api_base_url,created_at,updated_at)
          VALUES ('fixture','fixture','github','https://github.com','https://api.github.com','then','then');
        INSERT INTO multiremi_scm_change_requests(id,workspace_id,connection_id,repository_id,provider,external_id,title,state,created_at,updated_at)
          VALUES ('pr','local','fixture','repo','github','123','clean','open','then','then')`);
      return Buffer.from(JSON.stringify(legacyInventory(db))+'\n');
    });
    writeFileSync(archive,bytes);
    sha256 = createHash('sha256').update(bytes).digest('hex');
    urlA = await create(`${prefix}_A`,prefix);
    urlB = await create(`${prefix}_B`,prefix);
    pinnedKey = postgresInventoryTarget({ MULTIREMI_DATABASE_URL: urlA }).key;
    for (const url of [urlA,urlB]) inspect(url, db => {
      expect(Buffer.from(JSON.stringify(legacyInventory(db))+'\n')).toEqual(bytes);
      runStartupMigrations(db);
    });
  },30_000);

  afterAll(async () => {
    try { for (const name of created.reverse()) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`); }
    finally { await admin?.close(); if (directory) rmSync(directory,{recursive:true,force:true}); }
  });

  it('rejects missing pins, routing overrides and mismatched live database or port before audit writes', async () => {
    const before = snapshot(urlB);
    expect(before[0][0]).toMatchObject({phase:'unknown',hold_id:null});
    await expect(invoke(urlB)).rejects.toThrow('No fixture pin');
    expect(snapshot(urlB)).toEqual(before);
    await expect(invoke(urlA,{PGDATABASE:`${prefix}_B`})).rejects.toThrow('PGDATABASE');
    expect(snapshot(urlB)).toEqual(before);
    await expect(invoke(urlA,{},()=>new PostgresSyncDatabase(urlB))).rejects.toThrow('backend identity mismatch');
    expect(snapshot(urlB)).toEqual(before);
    const otherPort = new URL(urlA);
    otherPort.port = otherPort.port === '5432' ? '5433' : '5432';
    const original = pinnedKey;
    try {
      pinnedKey = postgresInventoryTarget({MULTIREMI_DATABASE_URL:otherPort.href}).key;
      await expect(invoke(otherPort.href,{},()=>new PostgresSyncDatabase(urlA))).rejects.toThrow('backend identity mismatch');
      expect(snapshot(urlA)).toEqual(before);
    } finally { pinnedKey = original; }
  });

  for (const fault of ['insert failure','disconnect']) it(`rolls back all audit writes on ${fault} after identity verification`, async () => {
    const before = snapshot(urlA);
    inspect(urlA, db => {
      const action = fault === 'disconnect' ? 'PERFORM pg_terminate_backend(pg_backend_pid());' : "RAISE EXCEPTION 'injected insert failure';";
      db.run('CREATE SEQUENCE adopt_fault_reached');
      db.run(`CREATE FUNCTION interrupt_adopt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('adopt_fault_reached'); ${action} RETURN NEW; END; $$`);
      db.run('CREATE TRIGGER interrupt_adopt BEFORE INSERT ON multiremi_scm_rollback_review FOR EACH ROW EXECUTE FUNCTION interrupt_adopt()');
    });
    try {
      await expect(invoke(urlA)).rejects.toThrow(fault === 'insert failure' ? 'injected insert failure' : undefined);
      expect(inspect(urlA, db => db.query('SELECT is_called FROM adopt_fault_reached').get().is_called)).toBe(true);
      expect(snapshot(urlA)).toEqual(before);
    } finally { inspect(urlA, db => db.exec('DROP TRIGGER interrupt_adopt ON multiremi_scm_rollback_review; DROP FUNCTION interrupt_adopt(); DROP SEQUENCE adopt_fault_reached')); }
  },15_000);

  it('adopts A into held, requires its own finalize and refuses its receipt on untouched B', async () => {
    const beforeB = snapshot(urlB);
    expect(beforeB[1]).toHaveLength(0);
    await invoke(urlA);
    const page = inspect(urlA, db => auditScmRollback(db));
    if (!('receipt' in page) || !page.receipt) throw new Error('Missing held audit receipt');
    expect(snapshot(urlA)[0][0]).toMatchObject({phase:'held'});
    expect(() => inspect(urlB, db => auditScmRollback(db,{finalize:page.receipt}))).toThrow();
    expect(snapshot(urlB)).toEqual(beforeB);
    inspect(urlA,db => auditScmRollback(db,{finalize:page.receipt}));
    expect(snapshot(urlA)[0][0]).toMatchObject({phase:'ready'});
  });
});
