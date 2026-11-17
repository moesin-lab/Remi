// Identify only this test's traffic without changing paths or production routing.
export const trafficHeader = 'x-edge-test-nonce';
export function testTraffic() {
  const nonce = crypto.randomUUID();
  return { nonce, headers: { [trafficHeader]: nonce },
    matches: (req: Request) => req.headers.get(trafficHeader) === nonce };
}

// These raw fixtures exchange small HTTP requests. Accumulate the full header
// before identifying traffic, including when TCP splits the nonce across reads.
export function ownHttpHead(nonce: string) {
  const pending = new WeakMap<object, string>();
  return (socket: { end(data: string): unknown }, bytes: Uint8Array): string | undefined => {
    const head = (pending.get(socket) ?? '') + Buffer.from(bytes).toString();
    const boundary = head.indexOf('\r\n\r\n');
    if (boundary < 0) { pending.set(socket, head); return; }
    pending.delete(socket);
    if (!head.slice(0, boundary).split('\r\n').some(line => {
      const colon = line.indexOf(':');
      return line.slice(0, colon).toLowerCase() === trafficHeader && line.slice(colon + 1).trim() === nonce;
    })) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    return head;
  };
}
