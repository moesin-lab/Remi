// Test-only PG wire fault injection: replace one cleanup statement with a real
// advisory-lock wait. ROLLBACK itself doesn't normally wait on a row/advisory
// lock; this models a backend that cannot finish cleanup, without a sleep that
// would eventually release ownership by itself. Runs off the sync bridge thread.
import { connect, createServer } from "node:net";

const scope = self as unknown as Worker;
scope.onmessage = ({ data: { url, cleanup, lock } }) => {
  const target = new URL(url);
  const proxy = createServer(socket => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    let startup = true;
    let buffer = Buffer.alloc(0);
    for (const stream of [socket, upstream]) {
      stream.on("error", () => { socket.destroy(); upstream.destroy(); });
      stream.on("close", () => { socket.destroy(); upstream.destroy(); });
    }
    upstream.pipe(socket);
    socket.on("data", data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= (startup ? 4 : 5)) {
        const length = startup ? buffer.readInt32BE(0) : buffer.readInt32BE(1) + 1;
        if (buffer.length < length) break;
        let frame = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        if (startup) startup = false;
        else if (frame[0] === 0x50 || frame[0] === 0x51) { // Parse or simple Query
          const start = frame[0] === 0x50 ? frame.indexOf(0, 5) + 1 : 5;
          const end = frame.indexOf(0, start);
          if (frame.toString("utf8", start, end).trim().toUpperCase() === cleanup) {
            const statement = Buffer.from(`SELECT pg_advisory_lock(${lock})`);
            frame = Buffer.concat([frame.subarray(0, start), statement, frame.subarray(end)]);
            frame.writeInt32BE(frame.length - 1, 1);
            scope.postMessage({ injected: true });
          }
        }
        upstream.write(frame);
      }
    });
  });
  proxy.listen(0, "127.0.0.1", () => scope.postMessage({ port: (proxy.address() as { port: number }).port }));
};
