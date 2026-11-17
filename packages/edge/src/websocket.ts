import { createHash, randomBytes } from 'node:crypto';
import { exchange, type TransportHandlers } from './http';

/** Minimal RFC 6455 client: no extensions, bounded messages and drain-driven writes.
 * Bun 1.3.14's client drops the close reason; encode the close frame explicitly.
 */
export class UpstreamSocket {
  readyState = 0;
  bufferedAmount = 0;
  protocol = '';
  binaryType = 'arraybuffer';
  onopen?: () => void;
  onresponse?: (response: Response) => void;
  onoverflow?: () => void;
  onerror?: () => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onmessage?: (event: { data: string | ArrayBuffer }) => void;
  private socket?: Bun.Socket<undefined>;
  private responseHandlers?: TransportHandlers;
  private paused = false;
  private reading = false;
  private options: { protocols: string[]; limit: number };
  private url: URL;
  private rejection?: { request: Request; stopSignal: AbortSignal; done(): void; error(): void };
  private buffer: Buffer = Buffer.alloc(0);
  private queue: Buffer[] = [];
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode = 0;
  private key = randomBytes(16).toString('base64');
  private timer?: ReturnType<typeof setTimeout>;
  constructor(url: URL, options: { headers: Record<string, string>; protocols: string[]; limit: number; rejection?: UpstreamSocket['rejection'] }) {
    this.rejection = options.rejection;
    this.options = options; this.url = new URL(url); this.url.protocol = 'http:';
    void Bun.connect<undefined>({ hostname: url.hostname, port: Number(url.port || 80), socket: {
      data: (_socket, bytes) => { if (this.responseHandlers) { this.responseHandlers.data(_socket, bytes); return; } try { this.read(Buffer.from(bytes), options); } catch { this.onerror?.(); this.close(1002, 'Invalid WebSocket frame'); } },
      drain: () => this.flush(),
      close: socket => { if (this.responseHandlers) this.responseHandlers.close(socket); else this.finish(1006, ''); },
      error: (socket, error) => { if (this.responseHandlers) this.responseHandlers.error(socket, error); else { this.onerror?.(); this.finish(1006, ''); } },
      connectError: () => { this.onerror?.(); this.finish(1006, ''); },
    } }).then(socket => {
      this.socket = socket;
      if (this.readyState === 3) { socket.terminate(); return; }
      const headers = new Headers(options.headers);
      headers.set('host', url.host); headers.set('connection', 'Upgrade'); headers.set('upgrade', 'websocket');
      headers.set('sec-websocket-key', this.key); headers.set('sec-websocket-version', '13');
      if (options.protocols.length) headers.set('sec-websocket-protocol', options.protocols.join(', '));
      let head = `GET ${url.pathname}${url.search} HTTP/1.1\r\n`;
      for (const [name, value] of headers) head += `${name}: ${value}\r\n`;
      this.enqueue(Buffer.from(head + '\r\n'));
    }, () => { this.onerror?.(); this.finish(1006, ''); });
  }
  pause() { this.paused = true; this.socket?.pause(); }
  resume() { this.paused = false; if (!this.reading) this.read(Buffer.alloc(0), this.options); if (!this.paused) this.socket?.resume(); }
  private read(bytes: Buffer, options: { protocols: string[]; limit: number }) {
    this.reading = true;
    try { this.parse(bytes, options); } finally { this.reading = false; }
  }
  private parse(bytes: Buffer, options: { protocols: string[]; limit: number }) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, bytes]) : bytes;
    if (this.readyState === 0) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) { if (this.buffer.length > 65536) this.terminate(); return; }
      if (end > 65536) { this.terminate(); return; }
      const lines = this.buffer.subarray(0, end).toString('latin1').split('\r\n');
      const statusLine = lines.shift()!;
      if (!/^HTTP\/1\.[01] 101(?: |$)/.test(statusLine)) {
        // The same socket and response bytes go through the HTTP stream parser:
        // authentication/protocol rejections are responses, never health failures.
        const initialData = this.buffer; this.buffer = Buffer.alloc(0); this.readyState = 3;
        void exchange(this.url, this.rejection?.request ?? new Request(this.url), new Headers(), {
          sent() {}, done: () => this.rejection?.done(), error: () => this.rejection?.error(), connectTimeoutMs: 1000,
          stopSignal: this.rejection?.stopSignal, reportStatusErrors: false,
          transport: { initialData, connect: async handlers => { this.responseHandlers = handlers; return this.socket!; } },
        }).then(response => this.onresponse?.(response), () => this.onerror?.());
        return;
      }
      const headers = new Headers();
      for (const line of lines) { const colon = line.indexOf(':'); if (colon <= 0) throw new Error('Bad header'); headers.append(line.slice(0, colon), line.slice(colon + 1).trim()); }
      const expected = createHash('sha1').update(this.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      this.protocol = headers.get('sec-websocket-protocol') ?? '';
      if (headers.get('sec-websocket-accept') !== expected || headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
        !headers.get('connection')?.toLowerCase().split(',').map(v => v.trim()).includes('upgrade') ||
        headers.has('sec-websocket-extensions') || (this.protocol && !options.protocols.includes(this.protocol))) {
        this.onerror?.(); this.terminate(); return;
      }
      this.buffer = this.buffer.subarray(end + 4); this.readyState = 1; this.onopen?.();
    }
    while (!this.paused && this.buffer.length >= 2 && this.readyState !== 3) {
      const first = this.buffer[0]; const opcode = first & 15; const final = Boolean(first & 128);
      if ((first & 112) || (this.buffer[1] & 128)) throw new Error('Unsupported frame flags');
      let length = this.buffer[1] & 127; let offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      if (length === 127) { if (this.buffer.length < 10) return; const big = this.buffer.readBigUInt64BE(2); if (big > BigInt(options.limit)) { this.onoverflow?.(); this.close(1013, 'Backpressure limit'); return; } length = Number(big); offset = 10; }
      if (length > options.limit || (opcode >= 8 && (!final || length > 125))) { this.onoverflow?.(); this.close(1013, 'Backpressure limit'); return; }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length); this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 8) {
        if (payload.length === 1) throw new Error('Invalid close frame');
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        if (code < 1000 || code >= 5000 || [1004, 1005, 1006, 1015].includes(code) || (code >= 1016 && code < 3000)) throw new Error('Invalid close code');
        const reason = payload.length > 2 ? new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2)) : '';
        if (this.readyState === 1) this.frame(8, payload);
        this.finish(code, reason); return;
      }
      if (opcode === 9) { this.frame(10, payload); continue; }
      if (opcode === 10) continue;
      if (![0, 1, 2].includes(opcode) || (opcode === 0 ? !this.fragmentOpcode : this.fragmentOpcode !== 0)) throw new Error('Invalid continuation');
      if (opcode !== 0) this.fragmentOpcode = opcode;
      this.fragments.push(payload); this.fragmentBytes += payload.length;
      if (this.fragmentBytes > options.limit) { this.onoverflow?.(); this.close(1013, 'Backpressure limit'); return; }
      if (final) {
        const message = Buffer.concat(this.fragments, this.fragmentBytes);
        const text = this.fragmentOpcode === 1;
        this.fragments = []; this.fragmentBytes = 0; this.fragmentOpcode = 0;
        this.onmessage?.({ data: text ? new TextDecoder('utf-8', { fatal: true }).decode(message) : new Uint8Array(message).buffer });
      }
    }
  }
  private frame(opcode: number, payload: Uint8Array) {
    const size = payload.length; const prefix = size < 126 ? 2 : size <= 65535 ? 4 : 10;
    const frame = Buffer.allocUnsafe(prefix + 4 + size); frame[0] = 128 | opcode;
    if (size < 126) frame[1] = 128 | size;
    else if (size <= 65535) { frame[1] = 254; frame.writeUInt16BE(size, 2); }
    else { frame[1] = 255; frame.writeBigUInt64BE(BigInt(size), 2); }
    const mask = randomBytes(4); mask.copy(frame, prefix);
    for (let i = 0; i < size; i++) frame[prefix + 4 + i] = payload[i] ^ mask[i % 4];
    this.enqueue(frame);
  }
  private enqueue(frame: Buffer) { this.queue.push(frame); this.bufferedAmount += frame.length; this.flush(); }
  private flush() {
    if (!this.socket || this.readyState === 3) return;
    while (this.queue.length) {
      const frame = this.queue[0]; const written = this.socket.write(frame);
      if (written < 0) { this.terminate(); return; }
      this.bufferedAmount -= written;
      if (written < frame.length) { this.queue[0] = frame.subarray(written); return; }
      this.queue.shift();
    }
  }
  send(data: string | Buffer) { if (this.readyState === 1) this.frame(typeof data === 'string' ? 1 : 2, typeof data === 'string' ? Buffer.from(data) : data); }
  close(code = 1000, reason = '') {
    if (this.readyState === 0) { this.terminate(); return; }
    if (this.readyState !== 1) return;
    const reasonBytes = Buffer.from(reason); const payload = Buffer.alloc(2 + Math.min(123, reasonBytes.length));
    payload.writeUInt16BE(code); reasonBytes.copy(payload, 2, 0, 123); this.frame(8, payload); this.readyState = 2;
    this.timer = setTimeout(() => this.terminate(), 100); this.timer.unref();
  }
  private finish(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3; clearTimeout(this.timer); this.socket?.end();
    this.queue = []; this.buffer = Buffer.alloc(0); this.fragments = []; this.bufferedAmount = 0;
    this.onclose?.({ code, reason });
  }
  terminate() { this.socket?.terminate(); this.finish(1006, ''); }
}
