import { dlopen, ptr, type Library } from 'bun:ffi';
import type { Socket } from 'node:net';

/** Bun 1.3.14 repeats reads >= 232 KiB without checking pause on Unix.
 * SO_RCVBUF keeps reads below that threshold. Linux doubles the requested size.
 * The descriptor and native constants are tied to the pinned Bun runtime.
 */
export const WS_RECEIVE_WINDOW_BYTES = 64 * 1024;
export const WS_READ_QUEUE_BYTES = 1024 * 1024;
const symbols = {
  setsockopt: { args: ['i32', 'i32', 'i32', 'ptr', 'u32'], returns: 'i32' },
  getsockopt: { args: ['i32', 'i32', 'i32', 'ptr', 'ptr'], returns: 'i32' },
} as const;
let native: Library<typeof symbols> | undefined;
function socketOptions() {
  if (native) return native.symbols;
  const libraries = process.platform === 'linux' ? ['libc.so.6', 'libc.so'] : ['/usr/lib/libSystem.B.dylib'];
  for (const library of libraries) {
    try { native = dlopen(library, symbols); return native.symbols; } catch { /* Try the other libc name (musl). */ }
  }
  throw new Error('Edge WebSocket socket options unavailable');
}
export function limitReceiveWindow(socket: Socket) {
  // Bun's repeated-recv branch is excluded on Windows; the Readable ceiling
  // still protects that platform without relying on Unix socket descriptors.
  if (process.platform === 'win32') return;
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error(`Edge WebSocket receive window unsupported on ${process.platform}`);
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (!Number.isInteger(fd) || fd! < 0) throw new Error('Edge WebSocket TCP descriptor unavailable');
  const size = new Int32Array([WS_RECEIVE_WINDOW_BYTES]);
  const length = new Uint32Array([size.byteLength]);
  const level = process.platform === 'darwin' ? 0xffff : 1;
  const option = process.platform === 'darwin' ? 0x1002 : 8;
  const api = socketOptions();
  if (api.setsockopt(fd!, level, option, ptr(size), size.byteLength) !== 0 ||
      api.getsockopt(fd!, level, option, ptr(size), ptr(length)) !== 0 ||
      size[0] <= 0 || size[0] > 2 * WS_RECEIVE_WINDOW_BYTES) throw new Error('Edge WebSocket receive window failed');
}
