from pathlib import Path
p=Path('tests/unit/multiremi/multiremi-issue-decisions.test.ts')
s=p.read_text()
start='async function exerciseAnsweredWindow(store: MultiremiStore): Promise<void> {\n'
s=s.replace(start,start+'''  const profileDb = (store as any).db;
  const profileExecute = profileDb.execute?.bind(profileDb);
  const profileRows = new Map<string, { count: number; ms: number; rows: number }>();
  const profileStart = performance.now();
  if (profileExecute) profileDb.execute = (sql: string, params: unknown[]) => {
    const start = performance.now();
    let result: any;
    try { result = profileExecute(sql, params); return result; }
    finally {
      const key = sql.replace(/\\s+/g, ' ').trim();
      const row = profileRows.get(key) ?? { count: 0, ms: 0, rows: 0 };
      row.count++; row.ms += performance.now() - start; row.rows += result?.rows?.length ?? 0;
      profileRows.set(key, row);
    }
  };
  try {
''')
end=s.index('\n}\n',s.index(start))
s=s[:end]+'''\n  } finally {
    if (profileExecute) profileDb.execute = profileExecute;
    console.log('MUL182_PROFILE ' + JSON.stringify({ dialect: profileDb.dialect ?? 'sqlite', elapsedMs: performance.now() - profileStart,
      queries: [...profileRows.values()].reduce((n, row) => n + row.count, 0), statements: [...profileRows].sort((a, b) => b[1].ms - a[1].ms) }));
  }
'''+s[end:]
p.write_text(s)
