// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages.
/**
 * Real-import test: the NATS header factory (§12.2).
 *
 * `NatsBroker` builds `MsgHdrs` through the `headers()` function it keeps off
 * the lazily-loaded nats module. Every other NATS test injects a connection,
 * which carries no module — so without this test the real factory is never
 * exercised, and the shape it produces is never checked against the real one.
 *
 * That shape is the whole reason D2 existed: a real `MsgHdrs` answers
 * `keys()`/`get()`, and casting it to a plain object yields
 * `['_code', '_description', 'headers']` — its private internals — rather than
 * the header that was set. No fake would have shown that.
 *
 * Needs no server: `headers()` is a pure constructor.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('REAL nats header factory (guarded)', () => {
  it('builds MsgHdrs the broker can write to and read back', async () => {
    let nats: typeof import('npm:nats@2.x');
    try {
      nats = await import('npm:nats@2.x');
    } catch {
      console.warn('SKIP: npm:nats is not resolvable');
      return;
    }

    expect(typeof nats.headers).toBe('function');

    // The write path: exactly what NatsBroker.publishWithHeaders does.
    const headers = nats.headers();
    headers.set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');

    // The read path: exactly what the broker's toHeaderRecord does.
    const record: Record<string, string> = {};
    for (const key of headers.keys()) {
      const value = headers.get(key);
      if (typeof value === 'string') record[key] = value;
    }

    expect(record).toEqual({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });

    // And the negative control for D2, pinned against the real object: a plain
    // cast reads `undefined` and exposes internals instead.
    const asPlain = headers as unknown as Record<string, unknown>;
    expect(asPlain.traceparent).toBeUndefined();
    expect(Object.keys(asPlain)).not.toContain('traceparent');
  });
});
