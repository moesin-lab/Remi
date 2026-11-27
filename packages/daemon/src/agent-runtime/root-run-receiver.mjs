const [uid, gid] = process.argv.slice(2).map(Number);
if (process.getuid() !== 0 || !Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) process.exit(1);
process.setgroups([]);
process.setgid(gid);
process.setuid(uid);
if (process.getuid() !== uid || process.getgid() !== gid || process.getgroups().some(group => group !== gid)) process.exit(1);
const { serveParkedReceiver } = await import('./root-run-carrier.mjs');
serveParkedReceiver();
