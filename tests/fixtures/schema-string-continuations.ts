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
export const supportedSingleLiterals = [
  String.raw`SELECT E'a\'b'`, String.raw`SELECT e'a\'b'`,
  "SELECT 'a',\n'b'", "SELECT 'a' 'alias'", "SELECT 'a' /* same line */ 'alias'",
  "SELECT B'1', X'a', N'b'", "SELECT $$'a'\n'b'$$", 'SELECT "a"\n\'b\'',
];
