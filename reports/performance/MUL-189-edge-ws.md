# MUL-189: bound large-frame Edge WS memory

Measured 2026-11-18 on Linux 5.15.120 x86_64, Bun 1.3.14 (0d9b296a), Node 22.23.2.
Baseline: PR #95 independent-review SHA `58d483d57448466bcd51c01bd1ced4fdea031fb0`.
The edge files are identical in PR #95's merged head and current main at measurement.
This change neither merges nor deploys anything. Local tests use a real Bun backend,
an independent edge subprocess, and a separate Node raw TCP slow reader. Each TCP
chunk pauses reads for 1 ms. Every frame's opcode, length, sequence and complete
payload are checked. Backend production honors its own 4 MiB high-water mark.

## Evidence

Raw evidence: [before](MUL-189-edge-ws-before.json), [after](MUL-189-edge-ws-after.json),
[isolated acceptance](MUL-189-edge-ws-acceptance.json). Values are MiB (2^20 bytes).
In the repeat benchmark, RSS and queue maxima are **cumulative**, not per-row peaks.
One edge PID processes all six connections; GC is called only before the first
connection and after the final report. At no time during transfer or between
connections is GC requested. Each 384-frame row transfers 1.5 GiB; total is 4.90625 GiB.

| Stream | Baseline cumulative peak RSS | Modified cumulative peak RSS | Baseline RSS after relay cleanup | Modified RSS after relay cleanup |
|---|---:|---:|---:|---:|
| 64 × 4096 KiB (connection 1) | 577.31 | 83.17 | 66.67 | 75.54 |
| 64 × 1024 KiB (connection 2) | 577.31 | 90.95 | 75.77 | 74.32 |
| 192 × 512 KiB (connection 3) | 577.31 | 90.95 | 76.43 | 78.94 |
| 384 × 4096 KiB (connection 4) | 598.39 | 106.75 | 73.32 | 71.22 |
| 384 × 4096 KiB (connection 5) | 1041.40 | 106.75 | 74.82 | 82.22 |
| 384 × 4096 KiB (connection 6) | 1849.59 | 106.75 | 88.27 | 78.44 |

Fresh-process acceptance peaks in the final 37-test run: 64×4 MiB 83.59 MiB, 64×1 MiB 76.81 MiB, 192×0.5 MiB 76.74 MiB, 384×4 MiB 112.02 MiB.
Peak-growth ceiling remains 96 MiB above the measured idle baseline, with default
4 MiB messages/1 MiB downstream high-water mark. The bound was introduced based on
measured 30–57 MiB growth, leaving runtime variability headroom; it does not solve
memory pressure by increasing an existing limit or changing the stall deadline.

## Attribution

The 1 MiB `wsBufferLimit` controls the downstream native write queue, not total RSS.
Sampling every 2 ms shows its maximum below 5 MiB + 14 bytes in both versions. Large
frames may cross a high-water mark by one entire accepted frame. Linux TCP kernel
queues are separate from process RSS; reducing the receive window bounds their
contribution but kernel queues cannot explain hundreds of MiB in edge RSS alone.

Baseline repeated whole-frame `Buffer.concat` produced **31.20 GiB** of cumulative
concat allocations while forwarding 4.90625 GiB. Modified parser concat allocations
were **29.87 MiB**. Baseline first 256 MiB stream alone produced 1.42 GiB of concat
allocations, versus 1.34 MiB after the change. Direct fill and buffer reuse also
remove message-level Buffer → ArrayBuffer → Buffer copies. Allocation counters
count traffic, not simultaneously live memory. `memoryUsage().external`,
`arrayBuffers` and `heapUsed` overlap in Bun and must not be added together.

The original 64×4 MiB baseline reached 577.31 MiB; repeated streams raised its
cumulative peak to 1,849.59 MiB, although it fell to 88.27 MiB after all relays closed.
After forced final GC it was 83.30 MiB and arrayBuffers were zero. This demonstrates
reclaimable allocation pressure/retention, not evidence of a permanently live
1.8 GiB relay or a simple fixed 600 MiB allocation. Six connections do not prove
absence of leaks at arbitrary duration.

A parser-only intermediate experiment in the preceding interrupted task recorded
251.66 MiB in `raw.readableLength` and 333.85 MiB RSS. This evidence is from that
experiment, not the current baseline (which does not expose Readable length).
It showed a second independent cause: Bun's adapter hides input behind paused
application `data` events. [Bun 1.3.14 loop.c lines 594–611](https://github.com/oven-sh/bun/blob/bun-v1.3.14/packages/bun-usockets/src/loop.c#L594)
repeat recv at >=232 KiB without testing the pause flag, even after its data callback.
A 64 KiB receive-buffer request stays below that branch's threshold. Edge checks
the effective option at connection setup and enforces a separate 1 MiB Readable
hard ceiling by rejecting a push before it retains the chunk. Current Readable
peak is 86 KiB, parser storage 4.04 MiB, downstream 4.93 MiB, pending delivery 0.
The current benchmark's baseline Readable value of 0 means **unavailable**, not
proof of zero input buffering. Interval samples can miss synchronous parser peaks;
source-enforced length validation and allocation structure supply the bounds.

## Budget and limitations

With M=`wsMaxMessageBytes`, H=`wsBufferLimit`, Q=`wsQueueLimit`:

- Parser payloads/fragments total ≤2M (fragment assembly can overlap source fragments).
  Reusable storage is one accepted payload ≤M. A TCP chunk can transiently overlap
  parsing; use 2M + 1 MiB = 9 MiB as the default parser regression budget.
- Readable input queue is hard-capped at 1 MiB; socket receive buffer ≤128 KiB on
  tested Linux. Cap exhaustion closes the relay with 1013. This is independent of H.
- Downstream native accepted queue is approximately H + M plus WS frame headers
  (default acceptance bound 5 MiB + 14); pending delivery ≤M. Pending data and parser
  storage can refer to the same allocation, so summing these overestimates live bytes.
- Client-to-backend writes have a separate Q=64 MiB safety ceiling, plus one frame
  and socket write buffering. The 96 MiB RSS-growth test concerns backend-to-client
  slow reads, not a fully saturated bidirectional relay or arbitrary custom limits.

For the tested single downstream-congested relay, reserve 160 MiB of process RSS
(about 48 MiB startup + 96 MiB observed-growth regression budget + headroom). This
is capacity-planning guidance, **not** an enforced RSS/cgroup ceiling. Arbitrary
concurrent relays require adding per-relay parser/read/write budgets, including
Q on bidirectional saturation, then measuring the actual concurrent workload.
There is no global WS admission/memory limit in this change.

Linux/glibc is verified here. Linux/musl library resolution, macOS socket constants
and Windows' excluded recv-repeat branch are implemented but not runtime-tested.
The lazy FFI loader avoids making HTTP listener startup depend on glibc; option
failure fails WS setup instead of silently falling back to unbounded reads. The
private Bun/Node descriptor and push behavior require revalidation on Bun upgrades.
The 64 KiB receive window can reduce throughput on high-RTT paths; WAN throughput,
TLS (edge remains HTTP-only), compiled executable, deployment, and concurrent
relay capacity are unverified. No live backend or business operation was used.

## Reproduction and checks

```bash
bun run test tests/unit/edge
bunx tsc --noEmit
npm run docs:test
npm run docs:check
bun tests/manual/edge-ws-memory.ts > after.json
bun tests/manual/edge-ws-memory.ts /absolute/baseline/packages/edge/src/index.ts > before.json
```

Acceptance includes all three requested frame matrices and 384×4 MiB, complete
byte checks, a fully non-reading Node TCP peer closed with 1013 under the existing
stall deadline, relay/timer cleanup, and direct parser checks for fragmented
headers/payloads, buffer ownership, empty/text messages, interleaved ping and
aggregate size rejection before allocation. Typecheck and doc checks are recorded
in the PR delivery; local tests do not establish deployed behavior.
