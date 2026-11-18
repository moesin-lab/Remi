const unsupportedSql = {
  '<unsupported-unicode-escape>': 'Unicode escape identifiers/strings are unsupported in registered migrations; use ordinary double-quoted identifiers and ordinary strings',
  '<unsupported-string-continuation>': 'String continuations are unsupported in registered migrations; combine the value into a single literal',
} as const;
const isUnsupportedToken = (token: string): token is keyof typeof unsupportedSql => Object.hasOwn(unsupportedSql, token);

/** Tokenize SQL without treating comments, values or quoted identifiers as keywords.
 * Template placeholders are opaque identifiers for the architecture scanner. */
function sqlTokens(sql: string): string[] {
  const tokens: string[] = [];
  const pattern = /\s+|--[^\n]*|E'(?:\\[\s\S]|''|[^'\\])*'|[BXN]?'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\$([a-z_][a-z_0-9]*)?\$[\s\S]*?\$\1\$|(?:\$\{[^}]*\}|[\p{L}_](?:[\p{L}\p{N}_]|\$(?!\{))*|\$[0-9]+|\?)+|[^\s]/giu;
  let offset = 0, afterLiteral = false, newlineTrivia = false;
  while (offset < sql.length) {
    if (sql.startsWith('/*', offset)) {
      const start = offset;
      let depth = 1;
      offset += 2;
      while (offset < sql.length && depth) {
        if (sql.startsWith('/*', offset)) { depth++; offset += 2; }
        else if (sql.startsWith('*/', offset)) { depth--; offset += 2; }
        else offset++;
      }
      if (afterLiteral && /[\r\n]/.test(sql.slice(start, offset))) newlineTrivia = true;
      continue;
    }
    // Do not parse continuation contents: an E prefix changes the escape rules
    // of every following segment. Reject before those rules can hide SQL.
    if (afterLiteral && newlineTrivia && sql[offset] === "'") {
      return [...tokens, '<unsupported-string-continuation>'];
    }
    // Registered SQL deliberately excludes PG Unicode escapes. Do not try to
    // parse UESCAPE or its string continuations: reject the whole statement.
    if (/^u&["']/i.test(sql.slice(offset, offset + 3))) {
      tokens.push('<unsupported-unicode-escape>');
      offset += 2;
      continue;
    }
    pattern.lastIndex = offset;
    const match = pattern.exec(sql)!;
    const token = match[0];
    offset = pattern.lastIndex;
    if (/^(?:\s|--)/.test(token)) {
      if (afterLiteral && /[\r\n]/.test(token)) newlineTrivia = true;
      continue;
    }
    afterLiteral = /^(?:[EBXN])?'/i.test(token);
    newlineTrivia = false;
    tokens.push(token);
  }
  return tokens.map(token => isUnsupportedToken(token) ? token : /^(?:["'$`\[]|[EBXN]')/i.test(token)
    ? '<identifier-or-value>' : token.toUpperCase());
}

function splitTopLevel(tokens: string[], separator: string): string[][] {
  const parts: string[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token === separator && depth === 0) parts.push([]);
    else parts[parts.length - 1]!.push(token);
    if (token === '(') depth++;
    if (token === ')') depth--;
  }
  return parts;
}

// Closed candidate vocabulary: PostgreSQL 16 SQL Commands
// https://www.postgresql.org/docs/16/sql-commands.html
// plus SQLite CREATE VIRTUAL TABLE: https://sqlite.org/lang_createvtab.html
// Multiword classes include their syntax prefix (e.g. TEXT SEARCH CONFIGURATION).
export const SCHEMA_DDL_OBJECT_CLASSES = [
  'TABLE', 'INDEX', 'VIEW', 'MATERIALIZED VIEW', 'SEQUENCE', 'TYPE', 'DOMAIN',
  'SCHEMA', 'FUNCTION', 'PROCEDURE', 'ROUTINE', 'AGGREGATE', 'OPERATOR',
  'TRIGGER', 'EVENT TRIGGER', 'RULE', 'POLICY', 'STATISTICS', 'EXTENSION',
  'FOREIGN TABLE', 'FOREIGN DATA WRAPPER', 'SERVER', 'USER MAPPING',
  'PUBLICATION', 'SUBSCRIPTION', 'COLLATION', 'CONVERSION', 'CAST', 'TRANSFORM',
  'LANGUAGE', 'PROCEDURAL LANGUAGE', 'ACCESS METHOD', 'TEXT SEARCH',
  'TABLESPACE', 'DATABASE', 'ROLE', 'USER', 'GROUP', 'OWNED',
  'DEFAULT PRIVILEGES', 'LARGE OBJECT', 'SYSTEM', 'VIRTUAL TABLE',
] as const;
const objectModifiers = new Set(['OR', 'REPLACE', 'UNIQUE', 'TEMP', 'TEMPORARY',
  'UNLOGGED', 'GLOBAL', 'LOCAL', 'RECURSIVE', 'CONCURRENTLY', 'CONSTRAINT', 'TRUSTED']);

function objectClass(statement: string[]): string | undefined {
  let i = 1;
  while (objectModifiers.has(statement[i]!)) i++;
  return SCHEMA_DDL_OBJECT_CLASSES.find(kind => kind.split(' ').every((word, n) => statement[i + n] === word));
}
function additiveAlterAction(action: string[]): boolean {
  if (action[0] === 'ADD') return true;
  if (action[0] !== 'ALTER') return false;
  let i = 1;
  if (action[i] === 'COLUMN') i++;
  i++; // opaque column identifier
  return (action[i] === 'SET' && action[i + 1] === 'DEFAULT')
    || (action[i] === 'DROP' && (action[i + 1] === 'DEFAULT'
      || (action[i + 1] === 'NOT' && action[i + 2] === 'NULL')));
}
function truncateCandidate(s: string[]): boolean {
  const identifier = (t: string | undefined) => Boolean(t && (/^[\p{L}_][\p{L}\p{N}_$]*$/u.test(t) || t === '<identifier-or-value>'));
  let i = 1;
  if (s[i] === 'TABLE') i++;
  do {
    if (s[i] === 'ONLY') i++;
    if (!identifier(s[i++])) return false;
    while (s[i] === '.') { i++; if (!identifier(s[i++])) return false; }
    if (s[i] === '*') i++;
    if (s[i] !== ',') break;
    i++;
  } while (i < s.length);
  if (['RESTART', 'CONTINUE'].includes(s[i]!) && s[i + 1] === 'IDENTITY') i += 2;
  if (['CASCADE', 'RESTRICT'].includes(s[i]!)) i++;
  return i === s.length;
}

/** Source lint first disambiguates SQL candidates from prose/shell strings. */
export function hasDestructiveSchemaSql(sql: string): boolean {
  return destructiveSchemaSql(sql, false);
}

/** Both unsupported lexical forms share the runtime and arch rejection path. */
export function unsupportedSchemaSqlReason(sql: string): string | undefined {
  const token = sqlTokens(sql).find(isUnsupportedToken);
  return token && unsupportedSql[token];
}
export function hasUnsupportedSchemaSql(sql: string): boolean {
  return unsupportedSchemaSqlReason(sql) !== undefined;
}

/** Known SQL fails closed on TRUNCATE regardless of shape. Catalog diffs
 * cannot detect TRUNCATE's data deletion. */
export function hasDestructiveSchemaStatement(sql: string): boolean {
  return destructiveSchemaSql(sql, true);
}

function destructiveSchemaSql(sql: string, knownSql: boolean): boolean {
  const tokens = sqlTokens(sql);
  if (tokens.some(isUnsupportedToken)) return true;
  return splitTopLevel(tokens, ';').some(s => {
    if (s[0] === 'DO') return s[1] === '<identifier-or-value>' || s[1] === 'LANGUAGE'
      || (s[1] === 'E' && s[2] === '<identifier-or-value>');
    if (s[0] === 'TRUNCATE') {
      // Known SQL never needs prose disambiguation. Explicit arch candidates
      // also fail closed on any tail, including syntax unknown to this lexer.
      return knownSql || ['TABLE', 'ONLY', '<identifier-or-value>'].includes(s[1]!)
        || truncateCandidate(s);
    }
    if (s[0] === 'REVOKE') {
      let depth=0;
      return s.some(token => {
        if (token==='(') depth++;
        if (token===')') depth--;
        return token==='FROM' && depth===0;
      });
    }
    if (s[0] === 'SECURITY' && s[1] === 'LABEL') return true;
    if (s[0] === 'REASSIGN' && s[1] === 'OWNED' && s[2] === 'BY') return true;
    if (!['CREATE', 'ALTER', 'DROP'].includes(s[0]!)) return false;
    const kind = objectClass(s);
    if (!kind) return false;
    if (s[0] === 'CREATE') return false;
    if (s[0] === 'DROP') return true;
    if (kind === 'TYPE') {
      return !s.some((t, i) => t === 'ADD' && s[i + 1] === 'VALUE');
    }
    if (kind !== 'TABLE' || s[1] !== 'TABLE') return true;
    let i = 2;
    if (s[i] === 'IF' && s[i + 1] === 'EXISTS') i += 2;
    if (s[i] === 'ONLY') i++;
    i++;
    while (s[i] === '.') i += 2;
    if (s[i] === '*') i++;
    return splitTopLevel(s.slice(i), ',').some(action => !additiveAlterAction(action));
  });
}
