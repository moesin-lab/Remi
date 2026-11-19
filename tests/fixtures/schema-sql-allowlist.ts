/** Shared counterexamples exercised by detector, source scanner and real PG. */
export const unsupportedRegisteredSql = [
  'SELECT 1 AS a$b$',
  // Reviewer's CR comment changes the statement boundary in PostgreSQL.
  "SELECT 1 -- comment\r; TRUNCATE S.retained; -- comment",
  "SELECT 1 -- comment\r\n; TRUNCATE S.retained",
  "SELECT 1\f; TRUNCATE S.retained", "SELECT 1\v; TRUNCATE S.retained",
  "SELECT '\r'", "SELECT '\f'", "SELECT '\v'",
  String.raw`SELECT E'a'` + '\n' + String.raw`'\''; TRUNCATE S.retained; -- '`,
  String.raw`SELECT e'a'` + '\r' + String.raw`'\''; TRUNCATE S.retained; -- '`,
  "SELECT E'a'", "SELECT e'a'", "SELECT B'1'", "SELECT X'a'", "SELECT N'a'",
  'SELECT $$hello$$', 'SELECT $tag$hello$tag$',
  'SELECT `id` FROM S.retained', 'SELECT [id] FROM S.retained',
  'SELECT (1; SELECT 2)', 'SELECT /* outer /* nested */ end */ 1',
  "SELECT 'a'\n'b'", "SELECT 'a'\n-- continuation\n'b'", "SELECT 'a' /* continuation\n */ 'b'",
  'SELECT U&"id" FROM S.retained', "SELECT u&'hello'",
  ...["'!'", "E'!'", '$$!$$', "'!'\n''", "'!'\n-- continuation\n''", "E'!'\n-- continuation\n''"].map(escape =>
    `TRUNCATE S.U&"ret!0061ined" UESCAPE ${escape}`),
];
