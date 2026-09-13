/**
 * X45-1 guard: drives a **real** MinIO object through `S3Provider.getStream()`
 * with a deliberately slow consumer and asserts the provider reads only a
 * BOUNDED amount ahead of it.
 *
 * ## Why the instrument is wire bytes and not RSS
 *
 * X45-1 reported this path "pulls materially ahead of a slow client" on the
 * evidence of process RSS: +50 MB while a 1 MiB/s client received 10 MiB,
 * against +2.6 MB for a generated-`ReadableStream` control. Measured here,
 * that reading does not survive two controls:
 *
 * - RSS cannot distinguish RETAINED memory from allocator high-water. Forcing
 *   GC at the same point returns `heapUsed` and `external` to baseline
 *   (+0.35 MiB / +0.18 MiB) while RSS stays up — nothing is held.
 * - The generated-stream control is not like-for-like: it never imports or
 *   initialises the AWS SDK, which costs **+28.7 MiB** on its own before any
 *   object is touched. Repeating the same download in one warm process
 *   converges to nothing (+35 MiB cold, +15 MiB, then −4.6 MiB).
 *
 * Counted at the socket instead, read-ahead is a few MiB and CONSTANT: 3.1 MiB
 * across 20 s / 20 MiB delivered at 1 MiB/s, and 1.9-2.5 MiB at the 2 MiB/s
 * this suite runs, moving by at most 0.30 MiB between the quarter mark and the
 * end of the window. The fix X45-1 suggested (a `pull()`-driven adapter over
 * the node `Readable`) measures 3.2 MiB against the current 3.1 MiB, i.e. it
 * changes nothing, and routing the SDK through `FetchHttpHandler` is worse at
 * 5.2 MiB.
 *
 * So this suite exists to pin the property rather than to fix a defect: the
 * gap X45-1 correctly identified is that no gate drove a large real object
 * through a slow reader. A future change that buffers the object — the
 * regression that finding feared — moves wire bytes, which this measures, and
 * would have been invisible to the RSS probe that raised it.
 *
 * ## Scope
 *
 * This pins `S3Provider` ONLY, and that is the honest scope rather than a
 * convenience: `GcsProvider` and `AzureBlobProvider` stream natively but drain
 * their SDK stream eagerly with no `pull` and no `cancel`, and `MemoryProvider`
 * and `LocalStorageProvider` have no native `getStream` at all, so
 * `StorageService` reads the object whole and emits one chunk. None of those
 * four would pass this suite, and the README's per-provider table says so.
 *
 * Guarded on `S3_ENDPOINT_URL` via `ignore:`, so an absent backend reports as
 * IGNORED rather than as a pass that asserted nothing.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { S3Provider } from '../../src/providers/s3-provider.ts';

// ── Guard ───────────────────────────────────────────────────────────────────

const endpoint = Deno.env.get('S3_ENDPOINT_URL');
let sdkPresent = false;
if (endpoint !== undefined) {
  try {
    await import('npm:@aws-sdk/client-s3@^3');
    sdkPresent = true;
  } catch {
    // npm:@aws-sdk/client-s3 not available
  }
}
const skip = endpoint === undefined || !sdkPresent;

// ── Sizing ──────────────────────────────────────────────────────────────────

const MIB = 1024 * 1024;
/** Object size. Large enough that buffering it whole is unmistakable. */
const OBJECT_BYTES = 64 * MIB;
/**
 * Consumer rates, slow relative to loopback MinIO so backpressure is real.
 * Both figures the docs quote are exercised here rather than asserted in prose
 * only, so a regression cannot make a published number stale silently.
 */
const READ_RATES_BYTES_PER_SEC = [1 * MIB, 2 * MIB] as const;
/** How long the slow consumer runs. */
const READ_WINDOW_MS = 8_000;
/**
 * Read-ahead ceiling. Measured ~3 MiB; a provider that buffered the object
 * would sit at `OBJECT_BYTES` minus what the consumer took, i.e. ~48 MiB at
 * the end of the window. 16 MiB discriminates with margin on both sides.
 */
const READ_AHEAD_CAP_BYTES = 16 * MIB;
/**
 * How much read-ahead may grow between the quarter mark and the end of the
 * window, while delivered bytes grow four-fold. Measured across three runs the
 * delta is -0.10 to +0.30 MiB, so this is ~13x the worst observed; a read-ahead
 * that genuinely tracked delivery would move by many MiB over the same span.
 */
const READ_AHEAD_SCALING_SLACK_BYTES = 4 * MIB;
/** Growth allowed at the wire while the consumer is fully stalled. */
const STALLED_GROWTH_CAP_BYTES = 8 * MIB;

const PROXY_PORT = 9010;
const OBJECT_KEY = 'x45-backpressure-64mib.bin';

/**
 * Real time, deliberately — NOT `IRuntimeServices`.
 *
 * This suite paces a real consumer against a real socket and its conclusions
 * are denominated in real seconds: an injectable clock is exactly what must not
 * be possible here, because a fake one would decouple the pacing from the
 * backend's actual send rate and leave every read-ahead figure meaningless.
 * Routing through the runtime would also be pure indirection — `hrtime()` is
 * `return performance.now()` and `setTimeout` is `globalThis.setTimeout`
 * (`packages/runtime/src/services/cross-runtime.ts:39-47`) — while implying to
 * a reader that the clock is swappable. The repo's rule targets `Date.now()`,
 * which mixes wall-clock with monotonic; this file contains none, and uses the
 * monotonic clock throughout.
 */
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function toIpv4(url: string): string {
  return url.replace(/localhost/g, '127.0.0.1');
}

// ── Counting TCP proxy ──────────────────────────────────────────────────────

/**
 * A byte-counting TCP relay in front of the real backend. The provider is
 * pointed at the relay, so `originBytes` is what the S3 server has actually
 * pushed toward this process — the quantity that distinguishes streaming from
 * buffering, and the one RSS cannot see.
 */
interface CountingProxy {
  readonly port: number;
  originBytes(): number;
  openConnections(): number;
  close(): Promise<void>;
}

function startCountingProxy(originHost: string, originPort: number, port: number): CountingProxy {
  let originBytes = 0;
  let open = 0;
  const sockets = new Set<Deno.Conn>();
  const listener = Deno.listen({ hostname: '127.0.0.1', port });

  const pump = async (from: Deno.Conn, to: Deno.Conn, count: boolean): Promise<void> => {
    const buf = new Uint8Array(64 * 1024);
    try {
      for (;;) {
        const n = await from.read(buf);
        if (n === null) break;
        if (count) originBytes += n;
        // `write()` may forward FEWER bytes than asked; dropping the unwritten
        // suffix would silently truncate the relayed HTTP stream, and the catch
        // below would read the resulting failure as a normal close.
        let offset = 0;
        while (offset < n) {
          const written = await to.write(buf.subarray(offset, n));
          if (written <= 0) throw new Error('TCP relay made no write progress');
          offset += written;
        }
      }
    } catch {
      // Either side closing mid-copy is the normal end of a relayed request.
    }
    // `closeWrite()` is async, so a peer that has already gone away rejects
    // rather than throwing — a bare try/catch would not hold it.
    await to.closeWrite().catch(() => {});
  };

  const accepting = (async () => {
    for await (const client of listener) {
      open++;
      sockets.add(client);
      void (async () => {
        let origin: Deno.TcpConn;
        try {
          origin = await Deno.connect({ hostname: originHost, port: originPort });
        } catch {
          client.close();
          sockets.delete(client);
          open--;
          return;
        }
        sockets.add(origin);
        await Promise.allSettled([pump(client, origin, false), pump(origin, client, true)]);
        for (const s of [client, origin]) {
          try {
            s.close();
          } catch {
            // Already closed by the peer.
          }
          sockets.delete(s);
        }
        open--;
      })();
    }
  })();

  return {
    port,
    originBytes: () => originBytes,
    openConnections: () => open,
    close: async () => {
      listener.close();
      for (const s of sockets) {
        try {
          s.close();
        } catch {
          // Already closed.
        }
      }
      sockets.clear();
      await accepting.catch(() => {});
      // Let the in-flight relay tasks observe the closed sockets and settle.
      await wait(100);
    },
  };
}

// ── Fixture ─────────────────────────────────────────────────────────────────

/** Ensures the bucket and the large fixture object exist, uploading once. */
async function ensureFixture(
  realEndpoint: string,
  bucket: string,
  accessKeyId: string,
  secretAccessKey: string,
): Promise<void> {
  const mod = await import('npm:@aws-sdk/client-s3@^3');
  const client = new mod.S3Client({
    endpoint: realEndpoint,
    region: 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  try {
    await client.send(new mod.HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new mod.CreateBucketCommand({ Bucket: bucket }));
  }
  try {
    const head = await client.send(
      new mod.HeadObjectCommand({ Bucket: bucket, Key: OBJECT_KEY }),
    );
    if (head.ContentLength === OBJECT_BYTES) return;
  } catch {
    // Absent — fall through and upload.
  }
  await client.send(
    new mod.PutObjectCommand({
      Bucket: bucket,
      Key: OBJECT_KEY,
      Body: new Uint8Array(OBJECT_BYTES).fill(0x41),
      ContentLength: OBJECT_BYTES,
    }),
  );
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('REAL MinIO/S3 streaming backpressure (X45-1)', { ignore: skip }, () => {
  it('reads a bounded amount ahead of a slow consumer, and stops for a stalled one', async () => {
    const real = new URL(toIpv4(endpoint as string));
    const bucket = Deno.env.get('S3_BUCKET') ?? 'm70c-verify';
    const accessKeyId = Deno.env.get('S3_ACCESS_KEY_ID') ?? 'minioadmin';
    const secretAccessKey = Deno.env.get('S3_SECRET_ACCESS_KEY') ?? 'minioadmin';
    const originPort = real.port === '' ? 9000 : Number(real.port);

    await ensureFixture(real.origin, bucket, accessKeyId, secretAccessKey);

    const proxy = startCountingProxy(real.hostname, originPort, PROXY_PORT);
    const provider = new S3Provider({
      bucket,
      endpoint: `http://127.0.0.1:${proxy.port}`,
      region: 'us-east-1',
      accessKeyId,
      secretAccessKey,
    });

    try {
      await provider.connect();

      // ── (1) slow consumer: read-ahead stays bounded and does not scale ────
      for (const rate of READ_RATES_BYTES_PER_SEC) {
        // Sampled BEFORE the request: measured, 4-392 KiB of body can already
        // have landed by the time `getStream()` resolves, and those bytes count
        // toward `consumed` while a later baseline would miss them — which
        // drives read-ahead negative on a fast enough machine. Taking it here
        // means the figure carries the response headers (a few hundred bytes).
        const baseline = proxy.originBytes();
        const slow = await provider.getStream(OBJECT_KEY);
        expect(slow).not.toBeNull();
        const reader = (slow as ReadableStream<Uint8Array>).getReader();

        let consumed = 0;
        let earlyReadAhead = -1;
        // Capping only the END of the window would let a provider burst far
        // ahead and then idle while the consumer caught up, so the peak is
        // tracked across every iteration instead.
        let peakReadAhead = 0;
        const startedAt = performance.now();
        const sampleAhead = (): number => {
          const ahead = proxy.originBytes() - baseline - consumed;
          if (ahead > peakReadAhead) peakReadAhead = ahead;
          return ahead;
        };

        while (performance.now() - startedAt < READ_WINDOW_MS) {
          const { done, value } = await reader.read();
          if (done) break;
          consumed += value.byteLength;
          sampleAhead();
          const dueAt = startedAt + (consumed / rate) * 1000;
          // Bounded by the window's remainder: a provider that hands over one
          // enormous chunk must not be able to sleep this loop past its window.
          const remaining = startedAt + READ_WINDOW_MS - performance.now();
          const delay = Math.min(dueAt - performance.now(), remaining);
          if (delay > 0) await wait(delay);
          // Read-ahead is highest after the consumer has been idle, so sample
          // again on this side of the pacing delay.
          const ahead = sampleAhead();
          if (earlyReadAhead < 0 && performance.now() - startedAt >= READ_WINDOW_MS / 4) {
            earlyReadAhead = ahead;
          }
        }

        const lateReadAhead = sampleAhead();
        const label = `at ${rate / MIB} MiB/s`;

        // The consumer really was slow, and really did get a partial object:
        // without this the caps below could pass on a stream that never ran.
        expect(consumed, label).toBeGreaterThan(4 * MIB);
        expect(consumed, label).toBeLessThan(OBJECT_BYTES / 2);

        // A provider that buffered the object would sit ~48 MiB ahead. The PEAK
        // is what is capped, so a burst that has drained by the end cannot pass.
        expect(peakReadAhead, label).toBeLessThan(READ_AHEAD_CAP_BYTES);
        // The sample was actually taken (the -1 sentinel fails this).
        expect(earlyReadAhead, label).toBeGreaterThanOrEqual(0);
        // And read-ahead must not SCALE with what has been delivered: a fixed
        // socket buffer stays put while the consumed total grows four-fold. The
        // slack is deliberately small — reusing the cap here would make this
        // assertion implied by the one above, and so unable to fail at all.
        expect(lateReadAhead - earlyReadAhead, label)
          .toBeLessThan(READ_AHEAD_SCALING_SLACK_BYTES);

        await reader.cancel();
        await wait(300);
      }

      // ── (2) cancelling releases the upstream connection ───────────────────
      // Every stream opened above was cancelled; none may still be draining.
      await wait(500);
      expect(proxy.openConnections()).toBe(0);

      // ── (3) stalled consumer: the wire goes quiet ─────────────────────────
      const stalledBaseline = proxy.originBytes();
      const stalled = await provider.getStream(OBJECT_KEY);
      expect(stalled).not.toBeNull();
      const stalledReader = (stalled as ReadableStream<Uint8Array>).getReader();
      const first = await stalledReader.read();
      expect(first.done).toBe(false);
      const firstBytes = first.value?.byteLength ?? 0;
      // Let whatever was already in flight land before sampling.
      await wait(1_000);
      const settled = proxy.originBytes();
      // The settling window is measured too: without this an eager provider
      // could pull the whole object during it and then go quiet, satisfying the
      // growth check below while never having stopped the wire at all.
      expect(settled - stalledBaseline - firstBytes).toBeLessThan(READ_AHEAD_CAP_BYTES);
      await wait(3_000);
      expect(proxy.originBytes() - settled).toBeLessThan(STALLED_GROWTH_CAP_BYTES);
      await stalledReader.cancel();
    } finally {
      await provider.disconnect();
      await proxy.close();
    }
  });
});
