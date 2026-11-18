/** Shared by the runtime expand guard and the startup architecture test. */
export function hasDestructiveSchemaSql(sql: string): boolean {
  const text = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  return /\b(?:DROP\s+(?:TABLE|COLUMN|VIEW|INDEX|CONSTRAINT)|RENAME\s+(?:TO|COLUMN)|ALTER\s+COLUMN\s+[^\s,;]+\s+(?:TYPE|SET\s+(?:DATA\s+TYPE|NOT\s+NULL))|TRUNCATE\b)/i.test(text);
}
