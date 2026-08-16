/**
 * Real-host signal registration — drives each adapter's DEFAULT host.
 *
 * Every unit test for `onSignal` INJECTS a host, which is exactly how M55's
 * `readStream` shipped dead on two of three runtimes: `node:fs/promises`
 * exports no `createReadStream` and `buildBunHost` never returned one, yet
 * every test passed because every test supplied what the default host lacked.
 * `runtime/test/integration/read-stream-real.test.ts` is the guard that closes
 * that hole for the filesystem seam; this is its counterpart for signals.
 *
 * So these tests deliberately construct the DEFAULT host — no injection — and
 * register a real listener through the real underlying API. Each one removes
 * its listener afterwards: a leaked SIGINT handler would survive into the rest
 * of the suite and swallow a Ctrl-C from whoever is running it.
 *
 * `SIGINT` is used throughout rather than `SIGTERM` because it is the one both
 * Deno and Node can register AND remove on every non-Windows platform, and
 * because nothing in the test runner sends it.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import process from 'node:process';

import { createDenoRuntimeServices } from '../../src/adapters/deno/deno-runtime.ts';
import { buildNodeHost } from '../../src/adapters/node/node-runtime.ts';
import { buildBunHost } from '../../src/adapters/bun/bun-runtime.ts';
import { createCloudflareRuntimeServices } from '../../src/adapters/workers/cf-runtime.ts';

const onWindows = Deno.build.os === 'windows';

describe('signal-real | Deno default host', () => {
  it('constructs without injection and exposes onSignal off-Windows', () => {
    // Constructing at all is half the assertion: the factory reads
    // `host.build.os`, so a default host missing `build` would throw a bare
    // TypeError here — the M52c/M50 unvalidated-binding class.
    const services = createDenoRuntimeServices();

    expect(typeof services.exit).toBe('function');
    expect(services.onSignal === undefined).toBe(onWindows);
  });

  it('registers a REAL listener through Deno.addSignalListener', { ignore: onWindows }, () => {
    const services = createDenoRuntimeServices();
    const handler = () => {};

    // If `addSignalListener` were missing from the default host, or wired to
    // the wrong member, this throws rather than silently no-opping.
    services.onSignal?.('SIGINT', handler);

    // Cleanup goes through Deno directly: the seam intentionally exposes no
    // removal (a process that received a termination signal is ending), so the
    // test must undo what it did rather than leak into the rest of the suite.
    Deno.removeSignalListener('SIGINT', handler);
  });
});

describe('signal-real | Node default host', () => {
  it('routes onSignal to the real process.on', () => {
    // `buildNodeHost()` with no argument binds `node:process`, which is the
    // member M55 proved cannot be assumed present just because the module is.
    const host = buildNodeHost();
    const before = process.listenerCount('SIGINT');
    const handler = () => {};

    host.onSignal('SIGINT', handler);

    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    process.removeListener('SIGINT', handler);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('signal-real | Bun default host', () => {
  it('routes onSignal to the real process.on', () => {
    // Bun's default host is built from `node:process`, NOT from the `Bun`
    // global — `bun-runtime.ts`'s own header records that the global carries
    // neither `Bun.exit` nor `Bun.hostname`, so assuming `Bun.on` would have
    // produced exactly the dead default this file exists to catch.
    const host = buildBunHost();
    const before = process.listenerCount('SIGINT');
    const handler = () => {};

    host.onSignal('SIGINT', handler);

    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    process.removeListener('SIGINT', handler);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('signal-real | Workers', () => {
  it('omits onSignal on the real factory, not just a faked one', () => {
    const services = createCloudflareRuntimeServices();

    expect('onSignal' in services).toBe(false);
  });
});
