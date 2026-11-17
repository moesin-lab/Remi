export interface TransportHandlers {
  data(socket: Bun.Socket<undefined>, bytes: Buffer): void;
  drain(socket: Bun.Socket<undefined>): void;
  close(socket: Bun.Socket<undefined>): void;
  error(socket: Bun.Socket<undefined>, error: Error): void;
  connectError(socket: Bun.Socket<undefined>, error: Error): void;
}
/** Per-edge pool: reuse only fully framed, bodyless-upload exchanges. */
export class HttpPool {
  private idle = new Map<string, Bun.Socket<undefined>[]>();
  private handlers = new WeakMap<Bun.Socket<undefined>, TransportHandlers>();
  private timers = new Map<Bun.Socket<undefined>, ReturnType<typeof setTimeout>>();
  async connect(url: URL, handlers: TransportHandlers, reuse = true) {
    const key = url.origin;
    const socket = reuse ? this.idle.get(key)?.pop() : undefined;
    if (socket) { clearTimeout(this.timers.get(socket)); this.timers.delete(socket); this.handlers.set(socket, handlers); socket.resume(); return socket; }
    const connected = await Bun.connect<undefined>({ hostname: url.hostname, port: Number(url.port || 80), socket: {
      data: (socket, bytes) => { const active = this.handlers.get(socket); if (active) active.data(socket, bytes); else this.discard(socket); },
      drain: socket => this.handlers.get(socket)?.drain(socket),
      close: socket => { const active = this.handlers.get(socket); this.discard(socket); active?.close(socket); },
      error: (socket, error) => { const active = this.handlers.get(socket); this.discard(socket); active?.error(socket, error); },
      connectError: (socket, error) => handlers.connectError(socket, error),
    } });
    this.handlers.set(connected, handlers); return connected;
  }
  release(url: URL, socket: Bun.Socket<undefined>) {
    this.handlers.delete(socket);
    const queue = this.idle.get(url.origin) ?? []; this.idle.set(url.origin, queue);
    if (queue.length >= 8) { socket.end(); return; }
    queue.push(socket);
    const timer = setTimeout(() => this.discard(socket), 1000); timer.unref(); this.timers.set(socket, timer);
  }
  private discard(socket: Bun.Socket<undefined>) {
    clearTimeout(this.timers.get(socket)); this.timers.delete(socket); this.handlers.delete(socket);
    for (const queue of this.idle.values()) { const index = queue.indexOf(socket); if (index >= 0) queue.splice(index, 1); }
    socket.terminate();
  }
  stop() { for (const queue of this.idle.values()) for (const socket of [...queue]) this.discard(socket); this.idle.clear(); }
}
/** One HTTP/1.1 upstream exchange. No request body is read until TCP connects.
 * Responses retain only a bounded header block and the consumer's stream queue.
 * Each connection has one active exchange, with cancellation and retry ownership explicit.
 */
export async function exchange(url: URL, request: Request, headers: Headers, hooks: {
  sent(): void; done(): void; error(): void; connectTimeoutMs: number; responseHeaderTimeoutMs?: number; pool?: HttpPool; reportStatusErrors?: boolean; stopSignal?: AbortSignal;
  transport?: { initialData: Buffer; connect(handlers: TransportHandlers): Promise<Bun.Socket<undefined>> };
}): Promise<Response> {
  const signal = hooks.stopSignal ? AbortSignal.any([request.signal, hooks.stopSignal]) : request.signal;
  return new Promise<Response>((resolve, reject) => {
    let socket: Bun.Socket<undefined> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let buffer: Buffer = Buffer.alloc(0);
    let parsed = false; let ended = false; let chunked = false; let reusable = false;
    let remaining = -1; let chunkRemaining = -1; let needCRLF = false;
    let drain: (() => void) | undefined;
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    const connectTimer = setTimeout(() => fail(new Error('Upstream connect timeout')), hooks.connectTimeoutMs);
    const abort = () => {
      if (hooks.stopSignal?.aborted && parsed) { reusable = false; finish(); socket?.terminate(); }
      else fail(new Error('Client aborted'));
    };
    const finish = () => {
      if (ended) return; ended = true; clearTimeout(connectTimer); clearTimeout(headerTimer); signal.removeEventListener('abort', abort);
      controller.close();
      if (socket && reusable && !signal.aborted) hooks.pool!.release(url, socket); else socket?.end();
      drain?.(); hooks.done();
    };
    const fail = (error: Error) => {
      if (ended) return; ended = true; clearTimeout(connectTimer); clearTimeout(headerTimer); signal.removeEventListener('abort', abort);
      socket?.terminate(); drain?.();
      if (parsed) { controller.error(error); hooks.error(); hooks.done(); } else reject(error);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      pull() { socket?.resume(); },
      cancel() { if (!ended) { ended = true; clearTimeout(connectTimer); clearTimeout(headerTimer); signal.removeEventListener('abort', abort); socket?.terminate(); drain?.(); hooks.done(); } },
    }, { highWaterMark: 65536, size: data => data?.byteLength ?? 0 });
    const emit = (data: Buffer) => {
      // Bun delivers owned Buffers; retain the bounded slice instead of copying
      // every response chunk twice and accumulating transient allocations.
      if (data.length) controller.enqueue(data);
      if ((controller.desiredSize ?? 0) <= 0) socket?.pause();
    };
    const data = (incoming: Buffer) => {
      if (ended) return;
      buffer = buffer.length ? Buffer.concat([buffer, incoming]) : incoming;
      if (!parsed) {
        while (true) {
          const boundary = buffer.indexOf('\r\n\r\n');
          if (boundary > 65536) { fail(new Error('Upstream headers too large')); return; }
          if (boundary < 0) { if (buffer.length > 65536) fail(new Error('Upstream headers too large')); return; }
          const lines = buffer.subarray(0, boundary).toString('latin1').split('\r\n');
          buffer = buffer.subarray(boundary + 4);
          const statusLine = lines.shift() ?? '';
          const status = Number(statusLine.split(' ')[1]);
          if (status >= 100 && status < 200 && status !== 101) continue;
          if (status < 200 || status > 599 || !Number.isInteger(status)) { fail(new Error('Invalid upstream response')); return; }
          const responseHeaders = new Headers();
          for (const line of lines) {
            const colon = line.indexOf(':'); if (colon <= 0) { fail(new Error('Invalid upstream header')); return; }
            responseHeaders.append(line.slice(0, colon), line.slice(colon + 1).trim());
          }
          chunked = responseHeaders.get('transfer-encoding')?.toLowerCase() === 'chunked';
          const length = responseHeaders.get('content-length');
          remaining = !chunked && length !== null ? Number(length) : -1;
          if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) { fail(new Error('Invalid content length')); return; }
          const noBody = request.method === 'HEAD' || [204, 205, 304].includes(status);
          const connection = responseHeaders.get('connection') ?? '';
          reusable = Boolean(hooks.pool && !hooks.transport && !request.body && !chunked && remaining >= 0 && statusLine.startsWith('HTTP/1.1 ') && !connection.toLowerCase().split(',').map(s => s.trim()).includes('close'));
          for (const name of [...connection.split(','), 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) if (name.trim()) responseHeaders.delete(name.trim());
          parsed = true; clearTimeout(headerTimer);
          if (status >= 500 && hooks.reportStatusErrors !== false) hooks.error();
          resolve(new Response(noBody ? null : stream, { status, statusText: statusLine.split(' ').slice(2).join(' '), headers: responseHeaders }));
          if (noBody) { finish(); return; }
          break;
        }
      }
      if (!chunked) {
        const take = remaining < 0 ? buffer.length : Math.min(remaining, buffer.length);
        emit(buffer.subarray(0, take)); buffer = Buffer.alloc(0);
        if (remaining >= 0) { remaining -= take; if (!remaining) finish(); }
        return;
      }
      while (buffer.length && !ended) {
        if (needCRLF) {
          if (buffer.length < 2) return;
          if (buffer[0] !== 13 || buffer[1] !== 10) { fail(new Error('Invalid chunk terminator')); return; }
          buffer = buffer.subarray(2); needCRLF = false;
        }
        if (chunkRemaining < 0) {
          const end = buffer.indexOf('\r\n');
          if (end < 0) { if (buffer.length > 1024) fail(new Error('Invalid chunk size')); return; }
          const size = buffer.subarray(0, end).toString().split(';')[0];
          if (!/^[a-f0-9]+$/i.test(size)) { fail(new Error('Invalid chunk size')); return; }
          chunkRemaining = parseInt(size, 16); buffer = buffer.subarray(end + 2);
          if (!Number.isSafeInteger(chunkRemaining)) { fail(new Error('Invalid chunk size')); return; }
          if (!chunkRemaining) { finish(); return; }
        }
        const take = Math.min(chunkRemaining, buffer.length);
        emit(buffer.subarray(0, take)); buffer = buffer.subarray(take); chunkRemaining -= take;
        if (!chunkRemaining) { chunkRemaining = -1; needCRLF = true; }
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    const handlers: TransportHandlers = {
      data(_socket, bytes) { try { data(bytes); } catch (error) { fail(error as Error); } },
      drain() { const wake = drain; drain = undefined; wake?.(); },
      close() { if (parsed && !chunked && remaining < 0) finish(); else if (!ended) fail(new Error('Upstream closed early')); },
      error(_socket, error) { fail(error); },
      connectError(_socket, error) { fail(error); },
    };
    // Unsafe methods need a fresh socket: a peer can close a pooled connection
    // at any time, and a partially sent POST cannot safely be replayed.
    const connecting = hooks.transport ? hooks.transport.connect(handlers) : hooks.pool ? hooks.pool.connect(url, handlers, ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) : Bun.connect<undefined>({ hostname: url.hostname, port: Number(url.port || 80), socket: handlers });
    void connecting.then(async connected => {
      clearTimeout(connectTimer); socket = connected;
      if (ended) { socket.terminate(); return; }
      if (hooks.transport) { data(hooks.transport.initialData); return; }
      const write = async (bytes: Uint8Array) => {
        let offset = 0;
        while (offset < bytes.length && !ended) {
          const written = socket!.write(bytes.subarray(offset));
          if (written < 0) throw new Error('Upstream closed during upload');
          if (written > 0) hooks.sent();
          offset += written;
          if (offset < bytes.length) await new Promise<void>(resolve => { drain = resolve; });
        }
      };
      try {
        headers.delete('expect');
        headers.set('host', url.host); headers.set('connection', hooks.pool ? 'keep-alive' : 'close');
        const hasBody = request.body !== null;
        const chunkUpload = hasBody && !headers.has('content-length');
        if (chunkUpload) headers.set('transfer-encoding', 'chunked');
        let head = `${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
        for (const [key, value] of headers) head += `${key}: ${value}\r\n`;
        headerTimer = setTimeout(() => fail(new Error('Upstream response header timeout')), hooks.responseHeaderTimeoutMs ?? 30_000);
        await write(Buffer.from(head + '\r\n'));
        if (hasBody) {
          const reader = request.body!.getReader();
          try {
            while (!ended) {
              const { value, done } = await reader.read(); if (done) break;
              if (!value.byteLength) continue;
              if (chunkUpload) await write(Buffer.from(value.byteLength.toString(16) + '\r\n'));
              await write(value); if (chunkUpload) await write(Buffer.from('\r\n'));
            }
            if (chunkUpload && !ended) await write(Buffer.from('0\r\n\r\n'));
          } finally { if (ended) await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
      } catch (error) { fail(error as Error); }
    }, error => fail(error));
  });
}
