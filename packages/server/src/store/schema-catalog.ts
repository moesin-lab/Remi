import type { SqlDatabase } from './db/postgres.js';

export interface SchemaCatalogEntry {
  key: string;
  definition: unknown;
  acl?: string[];
  labels?: string[];
  notNull?: boolean;
  /** New restrictions on a relation which existed before the step are forbidden. */
  restricts?: string;
}
export type SchemaCatalog = Map<string, SchemaCatalogEntry>;
const userNamespace = "n.nspname <> 'pg_catalog' AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp'";
const relationKey = (schema: unknown, name: unknown) => `relation:${JSON.stringify([schema, name])}`;
// acldefault('c', owner) is an empty column ACL: table grants are separate.
// Split grant options into atoms so removing grantability also removes an atom.
const acl = (expression: string, kind: string, owner: string) =>
  `ARRAY(SELECT atom FROM pg_catalog.aclexplode(coalesce(${expression}, pg_catalog.acldefault(${kind.startsWith('CASE') ? kind : "'" + kind + "'"}, ${owner}))) x
    CROSS JOIN LATERAL (VALUES (x.grantor::text || ':' || x.grantee::text || ':' || x.privilege_type),
      (CASE WHEN x.is_grantable THEN x.grantor::text || ':' || x.grantee::text || ':' || x.privilege_type || ':grant' END)) v(atom)
    WHERE atom IS NOT NULL ORDER BY atom)`;

/** Token boundaries retain literal values, so changing a named CHECK's value
 * is detected without mistaking a default string for a constraint declaration. */
function sqliteNamedConstraints(sql: string): Array<[string,string[]]> {
  const tokens = (sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\p{L}_][\p{L}\p{N}_$]*|[^\s]/gu) ?? [])
    .filter(token => !token.startsWith('--') && !token.startsWith('/*'));
  const found: Array<[string,string[]]> = [];
  for (let i=0;i<tokens.length;i++) if (tokens[i]!.toUpperCase() === 'CONSTRAINT' && tokens[i+1]) {
    const name = tokens[++i]!;
    let depth=0, end=i+1;
    for (;end<tokens.length;end++) {
      const token=tokens[end];
      if (token==='(') depth++;
      if (token===')' && --depth<0) break;
      if (token===',' && depth===0) break;
    }
    found.push([name,tokens.slice(i+1,end)]);
    i=end-1;
  }
  return found;
}

/** Fixed set queries, independent of namespace count. All reads use the step's
 * connection/transaction. OIDs are used only to join catalogs, never as identity. */
export function snapshotSchemaCatalog(db: SqlDatabase): SchemaCatalog {
  const entries: SchemaCatalogEntry[] = [];
  const add = (kind: string, identity: unknown[], definition: unknown, extra: Partial<SchemaCatalogEntry> = {}) =>
    entries.push({ key: `${kind}:${JSON.stringify(identity)}`, definition, ...extra });
  if (db.dialect === 'postgres') {
    for (const r of db.query(`SELECT n.nspname, ${acl('n.nspacl', 'n', 'n.nspowner')} AS acl
      FROM pg_catalog.pg_namespace n WHERE ${userNamespace}`).all()) add('schema', [r.nspname], {}, { acl: r.acl });
    for (const r of db.query(`SELECT n.nspname,c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relispartition,
      pg_catalog.pg_get_expr(c.relpartbound,c.oid) AS bound,
      CASE WHEN c.relkind='p' THEN pg_catalog.pg_get_partkeydef(c.oid) END AS partition_key,
      ARRAY(SELECT pn.nspname || '.' || pc.relname FROM pg_catalog.pg_inherits i
        JOIN pg_catalog.pg_class pc ON pc.oid=i.inhparent JOIN pg_catalog.pg_namespace pn ON pn.oid=pc.relnamespace
        WHERE i.inhrelid=c.oid ORDER BY i.inhseqno) AS parents,
      CASE WHEN c.relkind IN ('v','m') THEN pg_catalog.pg_get_viewdef(c.oid,false) END AS view_definition,
      CASE WHEN c.relkind IN ('v','m') THEN ARRAY(SELECT option FROM unnest(c.reloptions) option ORDER BY option) END AS view_options,
      CASE WHEN c.relkind IN ('i','I') THEN pg_catalog.pg_get_indexdef(c.oid) END AS index_definition,
      CASE WHEN seq.seqrelid IS NOT NULL THEN json_build_array(pg_catalog.format_type(seq.seqtypid,NULL),seq.seqstart::text,seq.seqincrement::text,seq.seqmax::text,seq.seqmin::text,seq.seqcache::text,seq.seqcycle)::text END AS sequence_definition,
      ${acl('c.relacl', "CASE WHEN c.relkind='S' THEN 's'::\"char\" ELSE 'r'::\"char\" END", 'c.relowner')} AS acl,
      ix.indisunique,tn.nspname AS table_schema,tc.relname AS table_name
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_catalog.pg_sequence seq ON seq.seqrelid=c.oid
      LEFT JOIN pg_catalog.pg_index ix ON ix.indexrelid=c.oid
      LEFT JOIN pg_catalog.pg_class tc ON tc.oid=ix.indrelid LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=tc.relnamespace
      WHERE ${userNamespace}`).all()) {
      const { nspname, relname, acl: permissions, indisunique, table_schema, table_name, ...definition } = r;
      add('relation', [nspname, relname], definition, { acl: permissions,
        ...(indisunique ? { restricts: relationKey(table_schema, table_name) } : {}) });
    }
    for (const r of db.query(`SELECT n.nspname,c.relname,a.attname,a.attnum,
      pg_catalog.format_type(a.atttypid,a.atttypmod) AS data_type,a.attnotnull,a.attidentity,a.attgenerated,
      cn.nspname AS collation_schema,co.collname,
      ${acl('a.attacl', 'c', 'c.relowner')} AS acl,
      CASE WHEN a.attgenerated<>'' THEN pg_catalog.pg_get_expr(d.adbin,d.adrelid) END AS generated_expression
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
      WHERE ${userNamespace} AND a.attnum>0 AND NOT a.attisdropped`).all()) {
      const { nspname, relname, attname, attnotnull, acl: permissions, ...definition } = r;
      add('column', [nspname, relname, attname], definition, { notNull: attnotnull, acl: permissions });
    }
    for (const r of db.query(`SELECT n.nspname,t.typname,t.typtype,t.typnotnull,
      pg_catalog.format_type(NULLIF(t.typbasetype,0),t.typtypmod) AS base_type,
      ARRAY(SELECT e.enumlabel FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid ORDER BY e.enumsortorder) AS labels,
      ${acl('t.typacl', 'T', 't.typowner')} AS acl
      FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE ${userNamespace}`).all()) {
      const { nspname, typname, labels, acl: permissions, ...definition } = r;
      add('type', [nspname, typname], definition, { labels, acl: permissions });
    }
    for (const r of db.query(`SELECT n.nspname,c.relname,t.typname,con.conname,con.contype,
      regexp_replace(pg_catalog.pg_get_constraintdef(con.oid,false), ' NOT VALID$', '') AS definition
      FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_namespace n ON n.oid=con.connamespace
      LEFT JOIN pg_catalog.pg_class c ON c.oid=con.conrelid LEFT JOIN pg_catalog.pg_type t ON t.oid=con.contypid
      WHERE ${userNamespace}`).all()) add('constraint', [r.nspname,r.relname,r.typname,r.conname], r.definition,
        { ...('cufxp'.includes(r.contype) && r.relname ? { restricts: relationKey(r.nspname,r.relname) } : {}) });
    for (const r of db.query(`SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_catalog.pg_get_triggerdef(t.oid,false) AS definition
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${userNamespace} AND NOT t.tgisinternal`).all())
      add('trigger', [r.nspname,r.relname,r.tgname], [r.definition,r.tgenabled]);
    for (const r of db.query(`SELECT n.nspname,c.relname,p.polname,p.polcmd,p.polpermissive,
      ARRAY(SELECT CASE WHEN role_oid=0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(role_oid)::text END FROM unnest(p.polroles) role_oid ORDER BY role_oid) AS roles,
      pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS qual,pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) AS with_check
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${userNamespace}`).all()) {
      const { nspname, relname, polname, ...definition } = r;
      add('policy', [nspname,relname,polname], definition, { restricts: relationKey(nspname,relname) });
    }
    for (const r of db.query(`SELECT n.nspname,c.relname,r.rulename,r.ev_enabled,pg_catalog.pg_get_ruledef(r.oid,false) AS definition
      FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE ${userNamespace} AND r.rulename<>'_RETURN'`).all()) add('rule', [r.nspname,r.relname,r.rulename], [r.definition,r.ev_enabled]);
    for (const r of db.query(`SELECT n.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
      pg_catalog.pg_get_functiondef(p.oid) AS definition,${acl('p.proacl', 'f', 'p.proowner')} AS acl
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE ${userNamespace} AND p.prokind IN ('f','p','w')`).all()) add('routine', [r.nspname,r.proname,r.args], r.definition, { acl: r.acl });
    for (const r of db.query('SELECT extname,extversion FROM pg_catalog.pg_extension').all()) add('extension', [r.extname], r.extversion);
    // Generic disappearance coverage. Defaults are explicitly mutable, including
    // generated pg_attrdef identities; generated expressions are modeled above.
    // pg_depend has multiple edges per object: DISTINCT yields one identity.
    for (const r of db.query(`SELECT DISTINCT obj.type,obj.identity FROM pg_catalog.pg_depend d
      CROSS JOIN LATERAL pg_catalog.pg_identify_object(d.classid,d.objid,d.objsubid) obj
      WHERE d.classid<>'pg_catalog.pg_attrdef'::regclass AND (
        (d.refclassid='pg_catalog.pg_namespace'::regclass AND d.refobjid IN (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE ${userNamespace}))
        OR (d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid IN
          (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${userNamespace})))`).all())
      add('dependent', [r.type,r.identity], {});
  } else {
    db.query('SELECT name FROM temp.sqlite_schema').all();
    for (const schema of db.query('PRAGMA database_list').all()) {
      const quoted = '"' + String(schema.name).replaceAll('"', '""') + '"';
      add('schema', [schema.name], {});
      for (const row of db.query(`SELECT type,name,tbl_name,sql FROM ${quoted}.sqlite_schema WHERE name NOT LIKE 'sqlite_%'`).all()) {
        const tableKey = relationKey(schema.name,row.tbl_name);
        if (row.type !== 'table') {
          add('object', [schema.name,row.type,row.name], row.sql, {
            ...(/CREATE\s+UNIQUE\s+INDEX/i.test(row.sql ?? '') ? { restricts: tableKey } : {}) });
          continue;
        }
        add('relation', [schema.name,row.name], {});
        for (const column of db.query('SELECT * FROM pragma_table_xinfo(?, ?)').all(row.name,schema.name)) {
          const { name, notnull, dflt_value: _default, ...definition } = column;
          add('column', [schema.name,row.name,name], definition, { notNull: Boolean(notnull) });
        }
        for (const [name,definition] of sqliteNamedConstraints(String(row.sql ?? ''))) {
          add('constraint', [schema.name,row.name,name], definition, { restricts: tableKey });
        }
        for (const index of db.query('SELECT * FROM pragma_index_list(?, ?)').all(row.name,schema.name)) {
          add('index', [schema.name,row.name,index.name],
            db.query('SELECT seqno,cid,name,desc,coll,key FROM pragma_index_xinfo(?, ?)').all(index.name,schema.name),
            { ...(index.unique ? { restricts: tableKey } : {}) });
        }
      }
    }
  }
  return new Map(entries.map(entry => [entry.key,entry]));
}

export function assertAdditiveSchemaCatalog(before: SchemaCatalog, after: SchemaCatalog): void {
  const violations: string[] = [];
  for (const [key, entry] of before) {
    const next = after.get(key);
    if (!next) { violations.push(`removed or renamed ${key}`); continue; }
    if (JSON.stringify(entry.definition) !== JSON.stringify(next.definition)) violations.push(`changed definition ${key}`);
    if (!entry.notNull && next.notNull) violations.push(`SET NOT NULL ${key}`);
    if (entry.acl?.some(item => !next.acl?.includes(item))) violations.push(`removed ACL ${key}`);
    // Enum insertion may change absolute sort numbers; existing relative order
    // must remain unchanged, so only compare the subsequence of old labels.
    if (entry.labels && JSON.stringify(next.labels?.filter(label => entry.labels!.includes(label))) !== JSON.stringify(entry.labels)) violations.push(`changed enum labels ${key}`);
  }
  for (const [key,entry] of after) if (!before.has(key) && entry.restricts && before.has(entry.restricts)) violations.push(`new restriction on existing relation ${key}`);
  if (violations.length) throw new Error(`Destructive schema catalog change is forbidden in an expand migration; declare a later-release contract step:\n${violations.join('\n')}`);
}
