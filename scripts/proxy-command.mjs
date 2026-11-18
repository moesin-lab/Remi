// A separate streaming process preserves the local manager's synchronous API
// without buffering long-running Docker build/watch output in spawnSync.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export function redactor(secrets) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const keep = Math.max(1, ...values.map((value) => value.length)) - 1;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  function drain(final) {
    const cutoff = final ? pending.length : Math.max(0, pending.length - keep);
    let index = 0;
    let output = '';
    while (index < cutoff) {
      let next = -1;
      let matched = '';
      for (const value of values) {
        const position = pending.indexOf(value, index);
        if (position !== -1 && (next === -1 || position < next)) { next = position; matched = value; }
      }
      if (next === -1 || next >= cutoff) { output += pending.slice(index, cutoff); index = cutoff; }
      else { output += pending.slice(index, next) + '[REDACTED]'; index = next + matched.length; }
    }
    pending = pending.slice(index);
    return output;
  }
  return new Transform({
    transform(chunk, encoding, done) { pending += decoder.write(chunk); done(null, drain(false)); },
    flush(done) { pending += decoder.end(); done(null, drain(true)); },
  });
}

if (process.argv[2] === '--run') {
  const { command, args, input, secrets, cwd, detectPortBinding } = JSON.parse(readFileSync(0, 'utf8'));
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  // Observe bounded tails while preserving streaming output and redaction.
  // 98 is reserved for a classified bind failure; other child failures map to 1.
  let portBinding = false;
  if (detectPortBinding) {
    for (const stream of [child.stdout, child.stderr]) {
      let tail = '';
      stream.on('data', (chunk) => {
        tail += chunk.toString('utf8');
        if (/bind: address already in use|port is already allocated|Only one usage of each socket address|ports? (?:are|is) not available[^\r\n]*bind/iu.test(tail)) portBinding = true;
        tail = tail.slice(-8192);
      });
    }
  }
  child.stdout.pipe(redactor(secrets)).pipe(process.stdout);
  child.stderr.pipe(redactor(secrets)).pipe(process.stderr);
  child.stdin.on('error', () => {}); // An early Docker failure can close stdin.
  child.stdin.end(input);
  let interrupted = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; child.kill(signal); });
  child.on('error', () => { process.stderr.write('Docker runtime proxy command could not start\n'); process.exitCode = 1; });
  child.on('close', (code) => {
    process.exitCode = interrupted ? 1 : code === 0 ? 0 : detectPortBinding ? (portBinding ? 98 : 1) : (code || 1);
  });
}
