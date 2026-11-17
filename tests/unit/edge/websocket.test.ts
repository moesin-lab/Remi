import { test, expect } from 'bun:test';
import { UpstreamSocket } from '../../../packages/edge/src/websocket';

// Drive the real parser with controlled TCP segmentation. No sockets are needed
// to verify payload ownership, interleaved control frames and allocation bounds.
function parser(limit = 4 * 1024 * 1024) {
  const socket = Object.create(UpstreamSocket.prototype) as UpstreamSocket;
  Object.assign(socket, { readyState: 1, paused: false, buffer: Buffer.alloc(0), fragments: [], fragmentBytes: 0,
    fragmentOpcode: 0, frameReceived: 0, queue: [], queuedBytes: 0, networkBytes: () => 0 });
  const messages: (string | Buffer)[] = [];
  socket.onmessage = ({ data }) => { messages.push(typeof data === 'string' ? data : Buffer.from(data)); if (Buffer.isBuffer(data)) socket.releaseMessage(data); };
  const read = (bytes: Buffer) => (socket as any).read(bytes, { limit, protocols: [] });
  return { socket, messages, read };
}
function frame(opcode: number, payload: Buffer, final = true) {
  const size = payload.length; const header = Buffer.alloc(size < 126 ? 2 : size <= 65535 ? 4 : 10);
  header[0] = (final ? 128 : 0) | opcode;
  header[1] = size < 126 ? size : size <= 65535 ? 126 : 127;
  if (header.length === 4) header.writeUInt16BE(size, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(size), 2);
  return Buffer.concat([header, payload]);
}
test('segmented frames reuse only delivered payloads and preserve binary/text/empty messages', () => {
  const { read, messages } = parser();
  const expected = [Buffer.alloc(4194304, 37), Buffer.alloc(4194304, 91), Buffer.alloc(0), '汉字🙂'];
  for (const message of expected) {
    const bytes = frame(typeof message === 'string' ? 1 : 2, Buffer.from(message));
    // Split each extended header byte and then many partial payload chunks.
    for (let i = 0; i < Math.min(10, bytes.length); i++) read(bytes.subarray(i, i + 1));
    for (let i = 10; i < bytes.length; i += 997) read(bytes.subarray(i, i + 997));
  }
  expect(messages).toEqual(expected);
});
test('fragment assembly survives ping between continuations and validates aggregate size before allocation', () => {
  const { read, socket, messages } = parser(1024);
  read(frame(2, Buffer.alloc(1024, 7))); // Seed the reusable payload.
  const bytes = Buffer.concat([frame(2, Buffer.alloc(500, 1), false), frame(9, Buffer.from('ping')), frame(0, Buffer.alloc(500, 2)), frame(2, Buffer.from('next'))]);
  for (let i = 0; i < bytes.length; i += 13) read(bytes.subarray(i, i + 13));
  expect(messages).toEqual([Buffer.alloc(1024, 7), Buffer.concat([Buffer.alloc(500, 1), Buffer.alloc(500, 2)]), Buffer.from('next')]);
  expect((socket as any).queue[0][0]).toBe(0x8a);
  read(frame(2, Buffer.alloc(1000), false));
  let overflow = false; socket.onoverflow = () => { overflow = true; };
  read(frame(0, Buffer.alloc(25)).subarray(0, 2));
  expect(overflow).toBe(true); expect((socket as any).framePayload).toBeUndefined();
  socket.terminate();
});
