/** Registered expand SQL deliberately uses a small, shared lexical allowlist.
 * Keep offsets so execution and lint agree on top-level statement boundaries. */
interface SqlToken { text: string; end: number }
function registeredSqlTokens(sql: string, templates = false): SqlToken[] {
  if (templates) sql = sql.replace(/\$\{[^}]*\}/g, '__template__');
  const tokens: SqlToken[] = [];
  const unsupported = (reason: string) => [{ text: `<unsupported:${reason}>`, end: sql.length }];
  if (/[\r\f\v]/.test(sql)) return unsupported('CR/FF/VT characters are unsupported; use LF only');
  let offset = 0, depth = 0, afterLiteral = false, newline = false;
  while (offset < sql.length) {
    const rest = sql.slice(offset);
    const trivia = /^(?:[ \t\n]+|--[^\n]*)/.exec(rest);
    if (trivia) {
      if (trivia[0].includes('\n')) newline = true;
      offset += trivia[0].length;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', offset + 2);
      if (end < 0) return unsupported('unterminated block comment');
      const comment = sql.slice(offset + 2, end);
      if (comment.includes('/*')) return unsupported('nested block comments are unsupported');
      if (comment.includes('\n')) newline = true;
      offset = end + 2;
      continue;
    }
    if (afterLiteral && newline && rest.startsWith("'")) return unsupported('String continuations are unsupported; combine the value into a single literal');
    if (/^[Uu]&["']/.test(rest)) return unsupported('Unicode escape identifiers/strings are unsupported; use ordinary double-quoted identifiers and ordinary strings');
    if (/^[EeBbXxNn]'/.test(rest)) return unsupported('E/B/X/N prefixed literals are unsupported; use an ordinary single literal');
    if (/^\$(?:[A-Za-z_\x80-\uFFFF][A-Za-z_0-9\x80-\uFFFF]*)?\$/.test(rest)) return unsupported('dollar-quoted literals are unsupported; use an ordinary single literal');
    if (/^[`\[\]]/.test(rest)) return unsupported('backtick and bracket forms are unsupported; use ordinary double-quoted identifiers');
    const quoted = /^(?:'(?:''|[^'])*'|"(?:""|[^"])*")/.exec(rest);
    if (quoted) {
      afterLiteral = rest[0] === "'";
      newline = false;
      offset += quoted[0].length;
      tokens.push({ text: '<identifier-or-value>', end: offset });
      continue;
    }
    const word = /^(?:[A-Za-z_\x80-\uFFFF](?:[A-Za-z_0-9\x80-\uFFFF]|\$(?!\{))*|\$[0-9]+|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/.exec(rest);
    const symbol = /^[+\-*\/%<>=~!@#^&|?:.,();]/.exec(rest);
    const match = word || symbol;
    if (!match) return unsupported(`unrecognized SQL character ${JSON.stringify(rest[0])}`);
    const raw = match[0];
    if (raw === ';' && depth) return unsupported('semicolons inside parentheses are unsupported');
    if (raw === '(') depth++;
    if (raw === ')' && --depth < 0) return unsupported('unbalanced parentheses');
    afterLiteral = false;
    newline = false;
    offset += raw.length;
    tokens.push({ text: raw.toUpperCase(), end: offset });
  }
  if (depth) return unsupported('unbalanced parentheses');
  return tokens;
}

function registeredUnsupported(tokens: SqlToken[]): string | undefined {
  return tokens.find(token => token.text.startsWith('<unsupported:'))?.text.slice(13, -1);
}

/** Split only after the entire input has passed the lexical allowlist. */
export function splitSchemaStatements(sql: string): string[] {
  const tokens = registeredSqlTokens(sql);
  const reason = registeredUnsupported(tokens);
  if (reason) throw new Error(`Registered migration SQL refused: ${reason}`);
  const statements: string[] = [];
  let start = 0, hasTokens = false;
  for (const token of tokens) {
    if (token.text === ';') {
      if (hasTokens) statements.push(sql.slice(start, token.end - 1));
      start = token.end;
      hasTokens = false;
    } else hasTokens = true;
  }
  if (hasTokens) statements.push(sql.slice(start));
  return statements;
}

/** Source strings need SQL candidate disambiguation; known SQL never does. */
export function isSchemaSqlCandidate(sql: string): boolean {
  // Avoid lexing arbitrary prose, shell programs and JSON stored in source.
  const first = /^[ \t\n\r\f\v]*([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase();
  const heads = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
    'DO', 'GRANT', 'REVOKE', 'COMMENT', 'SET', 'SHOW', 'PRAGMA', 'REASSIGN', 'SECURITY', 'VACUUM', 'ANALYZE',
    'REINDEX', 'CLUSTER', 'REFRESH', 'DISCARD']);
  if (first && !heads.has(first)) return false;
  if (!first && !/^[ \t\n\r\f\v]*(?:--|\/\*)/.test(sql)) return false;
  if (first && !['CREATE', 'ALTER', 'DROP', 'SET'].includes(first)) return true;
  const head = legacySqlTokens(sql);
  if (['CREATE', 'ALTER', 'DROP'].includes(head[0]!)) return Boolean(objectClass(head));
  if (head[0] === 'SET') return head[1] !== '-' && (head.includes('=') || ['LOCAL', 'SESSION', 'ROLE', 'CONSTRAINTS', 'TRANSACTION', 'TIME', 'SEARCH_PATH'].includes(head[1]!));
  return heads.has(head[0]!);
}

const unsupportedSql = {
  '<unsupported-unicode-escape>': 'Unicode escape identifiers/strings are unsupported in registered migrations; use ordinary double-quoted identifiers and ordinary strings',
  '<unsupported-string-continuation>': 'String continuations are unsupported in registered migrations; combine the value into a single literal',
} as const;
const isUnsupportedToken = (token: string): token is keyof typeof unsupportedSql => Object.hasOwn(unsupportedSql, token);

/** Frozen legacy source lint only; NEVER used to validate known migration SQL.
 * Also disambiguates source candidates from prose and shell programs. */
function legacySqlTokens(sql: string): string[] {
  const tokens: string[] = [];
  // PG 16 lexical rules: tags follow unquoted identifier rules without $,
  // must not follow an identifier, and closing delimiters match exact case.
  // https://www.postgresql.org/docs/16/sql-syntax-lexical.html#SQL-SYNTAX-DOLLAR-QUOTING
  const pattern = /\s+|--[^\n]*|[Ee]'(?:\\[\s\S]|''|[^'\\])*'|[BbXxNn]?'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|(?<![A-Za-z0-9_$\x80-\u{10FFFF}])\$([A-Za-z_\x80-\u{10FFFF}][A-Za-z_0-9\x80-\u{10FFFF}]*)?\$[\s\S]*?\$\1\$|(?:\$\{[^}]*\}|[\p{L}_](?:[\p{L}\p{N}_]|\$(?!\{))*|\$[0-9]+|\?)+|[^\s]/gu;
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
    if (/^[Uu]&["']/.test(sql.slice(offset, offset + 3))) {
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
    afterLiteral = /^(?:[EeBbXxNn])?'/.test(token);
    newlineTrivia = false;
    tokens.push(token);
  }
  return tokens.map(token => isUnsupportedToken(token) ? token : /^(?:["'$`\[]|[EeBbXxNn]')/.test(token)
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

/** Every unsupported form shares the runtime and arch rejection path. */
export function unsupportedSchemaSqlReason(sql: string): string | undefined {
  return registeredUnsupported(registeredSqlTokens(sql));
}
export function hasUnsupportedSchemaSql(sql: string): boolean {
  return unsupportedSchemaSqlReason(sql) !== undefined;
}

/** Known SQL fails closed on TRUNCATE regardless of shape. Catalog diffs
 * cannot detect TRUNCATE's data deletion. */
export function hasDestructiveSchemaStatement(sql: string): boolean {
  return destructiveSchemaSql(sql, true);
}

/** Frozen legacy sources retain their pre-B1 lint behavior. */
export function hasLegacyDestructiveSchemaSql(sql: string): boolean {
  return destructiveSchemaSql(sql, false, true);
}

function destructiveSchemaSql(sql: string, knownSql: boolean, legacy = false): boolean {
  if (!legacy && !knownSql && !isSchemaSqlCandidate(sql)) return false;
  const strict = legacy ? [] : registeredSqlTokens(sql, !knownSql);
  if (registeredUnsupported(strict)) return true;
  const tokens = legacy ? legacySqlTokens(sql) : strict.map(token => token.text);
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

export function registeredSchemaSqlReason(sql: string): string | undefined { return registeredUnsupported(registeredSqlTokens(sql, true)); }
