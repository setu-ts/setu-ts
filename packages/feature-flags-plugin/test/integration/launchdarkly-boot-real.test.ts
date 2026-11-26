/**
 * With LaunchDarkly unreachable at boot, `start()` ends within
 * `initTimeoutSeconds` and leaves the provider degraded (V13-232) — through the
 * REAL `@launchdarkly/node-server-sdk` (a devDependency) pointed at an in-test
 * server that accepts and never answers, and at a closed port.
 *
 * @module
 */
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LaunchDarklyProvider } from '../../src/providers/launchdarkly-provider.ts';

let blackHole: Server;
let port = 0;
const sockets = new Set<Socket>();

beforeAll(async () => {
  blackHole = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
  port = (blackHole.address() as { port: number }).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => blackHole.close(() => resolve()));
});

function provider(base: string): LaunchDarklyProvider {
  return new LaunchDarklyProvider({
    sdkKey: 'sdk-test',
    initTimeoutSeconds: 1,
    fallbackValue: true,
    ldOptions: { baseUri: base, streamUri: base, eventsUri: base, sendEvents: false },
  });
}

describe('LaunchDarkly unreachable at boot (V13-232)', () => {
  for (const [name, base] of [
    ['a server that never answers', () => `http://127.0.0.1:${port}`],
    ['a closed port', () => 'http://127.0.0.1:1'],
  ] as const) {
    it(`${name}: start() settles within the bound and serves the fallback`, async () => {
      const ld = provider(base());
      const started = performance.now();
      await ld.start();
      // One bound for the wait, one for the anonymous snapshot refill.
      expect(performance.now() - started).toBeLessThan(4500);
      expect(ld.status().healthy).toBe(false);
      expect(ld.isEnabled('any-flag')).toBe(true);
      await ld.stop();
    }, 15_000);
  }
});
