// Linux routes all of 127/8 locally; other platforms may require an alias.
// This address is NOT scanner isolation: host discovery also probes 127.0.0.2.
// Exact traffic counters must use a per-test nonce regardless of bind address.
export const testHostname = process.platform === 'linux' ? '127.0.0.2' : '127.0.0.1';

// The host proxy bypass commonly contains only 127.0.0.1. Keep genuine local
// fetch/probe traffic off HTTP proxies without changing unrelated destinations.
if (process.platform === 'linux') {
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const entries = (process.env[name] ?? '').split(',').filter(Boolean);
    if (!entries.includes(testHostname)) process.env[name] = [...entries, testHostname].join(',');
  }
}
