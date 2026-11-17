// Separate process: its timers and latency clock must not stall with the API.
import { percentile } from "@multiremi/observability/request-metrics.js";
const config = JSON.parse(await Bun.stdin.text()) as {
  url: string; headers: Record<string, string>; pollers: number; seconds: number; intervalMs: number; paths: string[];
};
const durations = new Map<string, number[]>();
const errors: Record<string, number> = {};
const pending: Promise<void>[] = [];
const started = performance.now();
let batches = 0;
function poll() {
  if (performance.now() - started >= config.seconds * 1000) return;
  batches++;
  for (let n = 0; n < config.pollers; n++) for (const path of config.paths) {
    pending.push((async () => {
      const at = performance.now();
      try {
        const response = await fetch(`${config.url}${path}`, { headers: config.headers });
        await response.text();
        if (!response.ok) errors[String(response.status)] = (errors[String(response.status)] ?? 0) + 1;
        const samples = durations.get(path) ?? [];
        samples.push(performance.now() - at);
        durations.set(path, samples);
      } catch (error) { const name = error instanceof Error ? error.name : "unknown"; errors[name] = (errors[name] ?? 0) + 1; }
    })());
  }
}
poll();
const timer = setInterval(poll, config.intervalMs);
await Bun.sleep(config.seconds * 1000);
clearInterval(timer);
await Promise.all(pending);
console.log(JSON.stringify({ batches, elapsed_ms: performance.now() - started, errors,
  routes: [...durations].map(([path, values]) => ({ path, requests: values.length,
    p50_ms: percentile(values, .5), p95_ms: percentile(values, .95) })) }));
