/** Registered SQL excludes every PostgreSQL newline string continuation. */
export const unsupportedStringContinuations = [
  String.raw`SELECT E'a'` + '\n' + String.raw`'\''; TRUNCATE S.retained; -- '`,
  "SELECT 'a'\n'b'",
  "SELECT 'a'\n-- continuation\n'b'",
  "SELECT 'a' /* continuation\n */ 'b'",
  "SELECT 'a' /* outer\n /* nested */ end */ 'b'",
  String.raw`SELECT e'a'` + '\n' + String.raw`'\''; TRUNCATE S.retained; -- '`,
  "SELECT B'1'\n'0'", "SELECT X'a'\n'b'", "SELECT N'a'\n'b'",
];
export const formerlySupportedSingleLiterals = [
  String.raw`SELECT E'a\'b'`, String.raw`SELECT e'a\'b'`,
  "SELECT 'a',\n'b'", "SELECT 'a' 'alias'", "SELECT 'a' /* same line */ 'alias'",
  "SELECT B'1', X'a', N'b'", "SELECT $$'a'\n'b'$$", 'SELECT "a"\n\'b\'',
];

/** PG dollar tags are case-sensitive; a differently cased tag is content. */
export const destructiveDollarQuotes = [
  'SELECT $a$$A$$a$; TRUNCATE public.U&"retained"; -- $a$',
  'SELECT 1; SELECT $a$$A$$a$; TRUNCATE public.retained; -- $a$',
  'SELECT $tag$$TAG$$tag$; TRUNCATE public.retained; -- $tag$',
  'SELECT 1 AS a$b$; TRUNCATE public.retained; -- $b$',
];
export const supportedDollarQuotes = [
  'SELECT $a$$A$ U&"literal" $a$',
  'SELECT $tag$$TAG$ U&"literal" $tag$',
  'SELECT $é1$ U&"literal" $é1$',
  'SELECT $_tag2$ U&"literal" $_tag2$',
  'SELECT $标签$ U&"literal" $标签$',
  'SELECT 1 AS a$b$',
];

// The registered SQL allowlist supersedes the earlier lexer compatibility.
export const supportedSingleLiterals = formerlySupportedSingleLiterals.filter(sql => !/E'|e'|B'|X'|N'|\$\$/.test(sql));
export const unsupportedSingleLiterals = formerlySupportedSingleLiterals.filter(sql => !supportedSingleLiterals.includes(sql));
export const unsupportedDollarQuotes = supportedDollarQuotes.filter(sql => !sql.includes('1 AS'));
export const allowedDollarIdentifiers = supportedDollarQuotes.filter(sql => sql.includes('1 AS'));
