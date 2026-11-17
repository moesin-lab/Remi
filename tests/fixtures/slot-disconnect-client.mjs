import { connect } from "node:net";
const port = Number(process.argv[2]);
const deadline = Date.now() + 3000;
let resets = 0;
let received = 0;
await Promise.all(Array.from({ length: 16 }, async (_, worker) => {
  while (Date.now() < deadline) {
    await new Promise(resolve => {
      const socket = connect(port, "127.0.0.1");
      socket.on("error", () => {});
      socket.once("close", () => { resets++; resolve(); });
      socket.on("data", () => { received++; if (worker % 3 === 0) socket.destroy(); });
      socket.once("connect", () => {
        socket.write("GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n".repeat(8));
        setTimeout(() => {
          if (socket.destroyed) return;
          if (worker % 2 === 0) socket.destroy();
          else socket.resetAndDestroy();
        }, (resets + worker) % 5);
      });
    });
  }
}));
console.log(JSON.stringify({ resets, received }));
