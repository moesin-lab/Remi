// Run in Node: exercise real TCP read suspension independently of Bun's adapter.
const { connect } = require('node:net');
const assert = require('node:assert/strict');
const [url, sizeArg, countArg] = process.argv.slice(2);
const size = Number(sizeArg), count = Number(countArg);
const stalled = process.argv[5] === 'stalled';
const socket = connect(Number(new URL(url).port), '127.0.0.1');
let head = Buffer.alloc(0), upgraded = false, header = Buffer.alloc(0);
let remaining = 0, received = 0, timer;
const deadline = setTimeout(() => { throw new Error(`Timeout after ${received} frames`); }, 80000);
socket.on('connect', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
socket.on('error', error => { throw error; });
socket.on('end', () => {
  if (!stalled) throw new Error(`Early EOF after ${received} frames`);
  clearTimeout(deadline); clearTimeout(timer); socket.destroy(); console.log(JSON.stringify({ ended: true }));
});
socket.on('data', data => {
  socket.pause(); timer = setTimeout(() => socket.resume(), 1);
  if (stalled && upgraded) return;
  let bytes = data;
  if (!upgraded) {
    head = Buffer.concat([head, bytes]); const end = head.indexOf('\r\n\r\n');
    if (end < 0) return;
    assert.match(head.subarray(0, end).toString(), /^HTTP\/1.1 101/);
    bytes = head.subarray(end + 4); head = Buffer.alloc(0); upgraded = true;
    const message = process.argv[5] === 'benchmark' ? Buffer.from(JSON.stringify({ size, count })) : Buffer.from('x');
    socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | message.length, 0, 0, 0, 0]), message]));
    if (stalled) { clearTimeout(timer); timer = setTimeout(() => socket.resume(), 1000); return; }
  }
  while (bytes.length) {
    if (!remaining) {
      const take = Math.min(10 - header.length, bytes.length);
      header = Buffer.concat([header, bytes.subarray(0, take)]); bytes = bytes.subarray(take);
      if (header.length < 10) return;
      assert.equal(header[0], 0x82); assert.equal(header[1], 127);
      assert.equal(Number(header.readBigUInt64BE(2)), size);
      header = Buffer.alloc(0); remaining = size;
    }
    const take = Math.min(remaining, bytes.length);
    assert.ok(bytes.subarray(0, take).every(value => value === (received & 255)), `Corrupt frame ${received}`);
    remaining -= take; bytes = bytes.subarray(take);
    if (!remaining && ++received === count) {
      clearTimeout(timer); clearTimeout(deadline); socket.destroy();
      console.log(JSON.stringify({ received, bytes: received * size })); return;
    }
  }
});
