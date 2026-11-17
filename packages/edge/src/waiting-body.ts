/** Bun buffers unread request bodies while fetch awaits admission. Explicitly
 * drain into a shared, bounded waiting budget instead. After admission, hand
 * the buffered prefix and the same reader to the streaming upstream exchange.
 */
export class WaitingBody {
  readonly failed: Promise<never>;
  exhausted = false;
  private reject!: (error: Error) => void;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private waiting = true;
  private done = false;
  private disposed = false;
  private pumping: Promise<void>;
  constructor(body: ReadableStream<Uint8Array>, private budget: { bytes: number; limit: number }) {
    this.reader = body.getReader();
    this.failed = new Promise((_, reject) => { this.reject = reject; });
    this.pumping = this.pump();
  }
  private async pump() {
    try {
      while (this.waiting && !this.disposed) {
        const { value, done } = await this.reader.read();
        if (this.disposed) return;
        if (done) { this.done = true; return; }
        if (this.budget.bytes + value.byteLength > this.budget.limit) { this.exhausted = true; throw new Error('Waiting body budget exhausted'); }
        this.chunks.push(value); this.bytes += value.byteLength; this.budget.bytes += value.byteLength;
      }
    } catch (error) { if (!this.disposed) { this.reject(error as Error); this.dispose(); } }
  }
  private take() {
    const chunk = this.chunks.shift();
    if (chunk) { this.bytes -= chunk.byteLength; this.budget.bytes -= chunk.byteLength; }
    return chunk;
  }
  admit() {
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        this.waiting = false;
        // One read may already be outstanding; never read the source twice.
        await this.pumping;
        if (this.disposed) { controller.error(new Error('Waiting body cancelled')); return; }
        const chunk = this.take();
        if (chunk) { controller.enqueue(chunk); return; }
        if (this.done) { controller.close(); return; }
        const { value, done } = await this.reader.read();
        if (done) { this.done = true; controller.close(); } else controller.enqueue(value);
      },
      cancel: () => this.dispose(),
    }, { highWaterMark: 0 });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.waiting = false;
    this.budget.bytes -= this.bytes; this.bytes = 0; this.chunks = [];
    void this.reader.cancel().catch(() => {});
  }
}
