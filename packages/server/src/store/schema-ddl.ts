/** Tokenize SQL without treating comments, values or quoted identifiers as keywords.
 * Template placeholders are opaque identifiers for the architecture scanner. */
function sqlTokens(sql: string): string[] {
  const tokens: string[] = [];
  const pattern = /\s+|--[^\n]*|'(?:''|[^'])*'|"(?:""|[^"])*"|\$([a-z_][a-z_0-9]*)?\$[\s\S]*?\$\1\$|(?:[\p{L}_][\p{L}\p{N}_$]*|\$\{[^}]*\})+|[^\s]/giu;
  let offset = 0;
  while (offset < sql.length) {
    if (sql.startsWith('/*', offset)) {
      let depth = 1;
      offset += 2;
      while (offset < sql.length && depth) {
        if (sql.startsWith('/*', offset)) { depth++; offset += 2; }
        else if (sql.startsWith('*/', offset)) { depth--; offset += 2; }
        else offset++;
      }
      continue;
    }
    pattern.lastIndex = offset;
    const match = pattern.exec(sql)!;
    const token = match[0];
    offset = pattern.lastIndex;
    if (/^(?:\s|--)/.test(token)) continue;
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

function destructiveDrop(statement: string[]): boolean {
  const identifier = (token: string | undefined) => Boolean(token && (/^[\p{L}_][\p{L}\p{N}_$]*$/u.test(token) || token === '<identifier-or-value>'));
  for (let kindWords = 1; kindWords <= 3; kindWords++) {
    if (!statement.slice(1, kindWords + 1).every(identifier)) continue;
    let index = kindWords + 1;
    if (statement[index] === 'IF' && statement[index + 1] === 'EXISTS') index += 2;
    let valid = true;
    do {
      if (!identifier(statement[index++])) { valid = false; break; }
      while (statement[index] === '.') {
        index++;
        if (!identifier(statement[index++])) { valid = false; break; }
      }
      if (statement[index] === '(') {
        let depth = 0;
        do { if (statement[index] === '(') depth++; if (statement[index] === ')') depth--; index++; }
        while (index < statement.length && depth);
        if (depth) valid = false;
      }
      if (statement[index] !== ',') break;
      index++;
    } while (index < statement.length);
    if (statement[index] === 'USING' && identifier(statement[index + 1])) index += 2;
    if (statement[index] === 'WITH' && statement[index + 1] === '(') {
      index += 2;
      while (index < statement.length && statement[index] !== ')') index++;
      if (statement[index] === ')') index++;
    }
    if (statement[index] === 'CASCADE' || statement[index] === 'RESTRICT') index++;
    if (valid && index === statement.length) return true;
  }
  return false;
}

/** Shared by the runtime expand guard and the startup architecture test. */
export function hasDestructiveSchemaSql(sql: string): boolean {
  return splitTopLevel(sqlTokens(sql), ';').some(statement => {
    if (statement[0] === 'TRUNCATE' && statement.length > 1) return true;
    // DO bodies are opaque executable SQL, unlike dollar-quoted SELECT values.
    if (statement[0] === 'DO' && (statement[1] === '<identifier-or-value>' || statement[1] === 'LANGUAGE'
      || (statement[1] === 'E' && statement[2] === '<identifier-or-value>')
      || (statement[1] === 'U' && statement[2] === '&' && statement[3] === '<identifier-or-value>'))) return true;
    // Parse the shape rather than enumerate object kinds. Up to three words
    // cover multiword kinds such as FOREIGN DATA WRAPPER / TEXT SEARCH CONFIGURATION.
    if (statement[0] === 'DROP' && destructiveDrop(statement)) return true;
    if (statement[0] === 'ALTER' && statement[1] !== 'TABLE' && statement.includes('RENAME')) return true;
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
