import { expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = join(import.meta.dir, '../..');
function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir,e.name)) : /\.(?:ts|tsx)$/.test(e.name) ? [join(dir,e.name)] : []); }
function violations(path: string, source: string): boolean {
  return /\bgetScmMergeCredential\s*\(/.test(source) && !['packages/server/src/store/store.ts','packages/server/src/scm/credential-boundary.ts','packages/server/src/scm/merge-execution.ts'].includes(path)
    || /\.getMergeCredential\s*\(/.test(source) && path !== 'packages/server/src/store/store.ts'
    || /\bmergerOperations\s*\(/.test(source) && !['packages/server/src/scm/credential-boundary.ts','packages/server/src/scm/live-merge-gate.ts','packages/server/src/scm/merge-execution.ts'].includes(path);
}
it('keeps the merger secret reader confined to worker/proof and Store facade', () => {
  const offenders = files(join(root,'packages')).concat(files(join(root,'apps'))).filter(file => violations(relative(root,file), readFileSync(file,'utf8')));
  expect(offenders).toEqual([]);
  for (const path of ['packages/server/src/api/routers/scm.ts','packages/server/src/api/routers/daemon.ts','packages/server/src/agent-plugins/scm-git-auth.ts']) {
    expect(violations(path, 'store.getScmMergeCredential(id)')).toBe(true);
    expect(violations(path, 'store.scm.getMergeCredential(id)')).toBe(true);
    expect(violations(path, 'mergerOperations(store, binding)')).toBe(true);
  }
});
