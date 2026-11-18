/** Tokenize SQL without treating comments, values or quoted identifiers as keywords.
 * Template placeholders are opaque identifiers for the architecture scanner. */
function sqlTokens(sql: string): string[] {
  const tokens: string[] = [];
  const pattern = /\s+|--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\$([a-z_][a-z_0-9]*)?\$[\s\S]*?\$\1\$|(?:[a-z_][a-z_0-9$]*|\$\{[^}]*\})+|[^\s]/gi;
  for (const match of sql.matchAll(pattern)) {
    const token = match[0];
    if (/^(?:\s|--|\/\*)/.test(token)) continue;
    tokens.push(/^["'$]/.test(token) ? '<identifier-or-value>' : token.toUpperCase());
  }
  return tokens;
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

function destructiveAlterAction(action: string[]): boolean {
  // DROP/RENAME are action verbs, never words embedded in a column default.
  if (action[0] === 'DROP' || action[0] === 'RENAME') return true;
  if (action[0] !== 'ALTER') return false;
  let index = 1;
  if (action[index] === 'COLUMN') index++;
  if (action[index] === 'IF' && action[index + 1] === 'EXISTS') index += 2;
  index++; // column identifier, including quoted identifiers with spaces
  return action[index] === 'TYPE' || (action[index] === 'SET'
    && ((action[index + 1] === 'DATA' && action[index + 2] === 'TYPE')
      || (action[index + 1] === 'NOT' && action[index + 2] === 'NULL')));
}

/** Shared by the runtime expand guard and the startup architecture test. */
export function hasDestructiveSchemaSql(sql: string): boolean {
  return splitTopLevel(sqlTokens(sql), ';').some(statement => {
    if (statement[0] === 'TRUNCATE' && statement.length > 1) return true;
    if (statement[0] === 'DROP' && ['TABLE', 'VIEW', 'INDEX'].includes(statement[1] ?? '')) return true;
    if (statement[0] !== 'ALTER' || statement[1] !== 'TABLE') return false;
    let index = 2;
    if (statement[index] === 'IF' && statement[index + 1] === 'EXISTS') index += 2;
    if (statement[index] === 'ONLY') index++;
    index++; // table identifier
    while (statement[index] === '.') index += 2; // schema-qualified name
    if (statement[index] === '*') index++;
    return splitTopLevel(statement.slice(index), ',').some(destructiveAlterAction);
  });
}
