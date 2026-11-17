/** Run with pinned Bun: bun tests/manual/edge-ws-memory.ts [absolute edge index.ts]
 * A real Bun backend, separate edge process and separate Node TCP slow reader.
 * No GC while streaming; compare a source baseline using the same observer.
 */
import { resolve } from 'node:path';
const source = resolve(process.argv[2] ?? 'packages/edge/src/index.ts');
const backend = Bun.serve({ port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response('no'); }, websocket: {
  backpressureLimit: 4 * 1024 * 1024, closeOnBackpressureLimit: false,
  message(ws, data) {
    const { count, size } = JSON.parse(String(data)); let sent = 0;
    const producer = setInterval(() => {
      if (ws.getBufferedAmount() >= 4 * 1024 * 1024) return;
      if (ws.send(new Uint8Array(size).fill(sent & 255)) !== 0 && ++sent === count) clearInterval(producer);
    }, 1);
    producers.add(producer);
  },
} });
const producers = new Set<ReturnType<typeof setInterval>>();
let receive: ((data: any) => void) | undefined;
const edge = Bun.spawn([process.execPath, 'tests/helpers/edge/regression-process.ts', backend.url.href, '30000', source], {
  stdout: 'pipe', stderr: 'inherit', ipc(data) { receive?.(data); },
});
const lineReader = edge.stdout.getReader(); const line = await lineReader.read(); lineReader.releaseLock();
const url = new TextDecoder().decode(line.value).trim();
const query = (message: string): Promise<any> => new Promise(resolve => { receive = resolve; edge.send(message); });
const runs: any[] = [];
try {
  await query('start');
  for (const [count, size] of [[64, 4194304], [64, 1048576], [192, 524288], [384, 4194304], [384, 4194304], [384, 4194304]]) {
    const reader = Bun.spawn(['node', 'tests/helpers/edge/slow-reader.cjs', url, String(size), String(count), 'benchmark'], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(reader.stdout).text(), new Response(reader.stderr).text(), reader.exited]);
    if (code !== 0) throw new Error(stderr);
    for (let i = 0; i < 400 && (await query('report')).activeRelays; i++) await Bun.sleep(5);
    const report = await query('report');
    if (report.activeRelays || report.relayTimers) throw new Error('Relay cleanup failed');
    runs.push({ count, size, received: JSON.parse(stdout), ...report });
    console.error(JSON.stringify({ count, size, peak: report.peak, rss: report.memory.rss }));
  }
  const beforeGC = await query('report'); const afterGC = await query('gc');
  console.log(JSON.stringify({ source, bun: Bun.version, platform: process.platform, arch: process.arch, node: Bun.spawnSync(['node', '--version']).stdout.toString().trim(), runs, beforeGC, afterGC }, null, 2));
} finally {
  edge.send('stop'); await edge.exited;
  for (const producer of producers) clearInterval(producer);
  void backend.stop(true);
}
