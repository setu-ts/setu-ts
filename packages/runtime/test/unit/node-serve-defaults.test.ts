/**
 * Recurrence gate: the default Node serve host must NOT opt out of
 * node-server's global objects (M87).
 *
 * `@hono/node-server` serves a response through its synchronous fast path only
 * when the response carries the internal cache symbol its own `Response` class
 * sets, and that class reaches user code only when node-server installs it as
 * a global — which it does by default, and skips when passed
 * `overrideGlobalObjects: false`. This adapter passed exactly that from M23
 * until M87, so every response it ever produced on Node took the slow path.
 *
 * This is a SOURCE-level assertion on purpose. The flag is added inside
 * `defaultNodeServeHost`, which is `@internal`, unexported, and performs a
 * real `npm:` import — so every unit test drives an injected fake host and
 * bypasses it. A fake-host test asserting what `listen()` forwards passes
 * whether or not the default host re-adds the flag: verified by reverting the
 * source and watching that test stay green. Reading the source is the only
 * check here that fails when the opt-out comes back.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

const SOURCE = await Deno.readTextFile(
  new URL('../../src/adapters/node/node-http-adapter.ts', import.meta.url),
);

describe('default Node serve host (M87)', () => {
  it('does not disable node-server global objects', () => {
    // Whitespace-insensitive: `overrideGlobalObjects` followed by `:` and
    // `false` in any layout deno fmt might produce.
    const optOut = /overrideGlobalObjects\s*:\s*false/;
    const offending = SOURCE.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) =>
        optOut.test(line) && !line.trimStart().startsWith('//') &&
        !line.trimStart().startsWith('*')
      );

    expect(offending.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([]);
  });

  it('still declares the option, so a caller may opt out deliberately', () => {
    // The seam stays on NodeServeHost — removing it would make the opt-out
    // unexpressible for an application that needs undici's globals intact.
    expect(SOURCE).toMatch(/overrideGlobalObjects\?\s*:\s*boolean/);
  });
});
