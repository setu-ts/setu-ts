/**
 * A TCP relay that can stop forwarding while keeping its sockets open.
 *
 * The outage cells of the real-emulator suites point an adapter at this relay
 * instead of at the emulator. `freeze()` makes the store look hung: every
 * connection stays open and new connections are still accepted, but no byte
 * crosses in either direction, so a call waits exactly as it would on a frozen
 * backend. `thaw()` delivers what was held, in order, and resumes forwarding.
 * No shared container is ever paused, stopped or restarted, so the suites can
 * run beside other sessions using the same emulators.
 *
 * The relay listens on port 0 and reads the ephemeral port back after
 * `listen`, so parallel runs cannot collide.
 *
 * @module
 */
import { connect, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { IPlugin } from '@setu-ts/common';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

/** A running relay in front of one emulator. */
export interface FrozenRelay {
  /** The loopback address the relay listens on. */
  readonly host: string;
  /** The ephemeral port the relay listens on. */
  readonly port: number;
  /** Stops forwarding in both directions; sockets stay open, data is held. */
  freeze(): void;
  /** Delivers the held data in order and resumes forwarding. */
  thaw(): void;
  /** Destroys every relayed socket and stops listening. */
  close(): Promise<void>;
}

/** One chunk held while the relay is frozen. */
interface HeldChunk {
  readonly to: Socket;
  readonly chunk: Buffer;
}

/**
 * Starts a relay forwarding to `target`.
 *
 * @param target - The emulator's host and port
 * @returns The listening relay
 */
export async function startFrozenRelay(target: {
  readonly host: string;
  readonly port: number;
}): Promise<FrozenRelay> {
  let frozen = false;
  const held: HeldChunk[] = [];
  const sockets = new Set<Socket>();

  const forward = (to: Socket, chunk: Buffer): void => {
    if (frozen) {
      held.push({ to, chunk });
      return;
    }
    if (!to.destroyed) to.write(chunk);
  };

  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  const server: Server = createServer((client) => {
    const upstream = connect({ host: target.host, port: target.port });
    track(client);
    track(upstream);
    client.on('data', (chunk: Buffer) => forward(upstream, chunk));
    upstream.on('data', (chunk: Buffer) => forward(client, chunk));
    // A side that ends or fails takes its partner with it at once, exactly as a
    // direct connection would, frozen or not: freezing holds data, not closes.
    const pair = (from: Socket, to: Socket): void => {
      from.on('error', () => to.destroy());
      from.on('close', () => to.destroy());
    };
    pair(client, upstream);
    pair(upstream, client);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The frozen relay did not report a TCP address.');
  }

  return {
    host: '127.0.0.1',
    port: address.port,
    freeze(): void {
      frozen = true;
    },
    thaw(): void {
      frozen = false;
      for (const { to, chunk } of held.splice(0)) {
        if (!to.destroyed) to.write(chunk);
      }
    },
    close(): Promise<void> {
      frozen = false;
      held.length = 0;
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Splits a `host:port` or URL endpoint into the relay's target.
 *
 * The relay forwards plaintext bytes and the outage cells reach it over
 * `http://`, so only a plaintext emulator endpoint is supported. An `https://`
 * endpoint (a real account) is refused here, before the relay starts, rather
 * than failing later as an unexplained connection error mid-setup.
 *
 * @param endpoint - `127.0.0.1:8086` or `http://127.0.0.1:8000/`
 * @returns The host and numeric port
 * @throws {Error} For any scheme other than `http:` (or a bare `host:port`)
 */
export function relayTarget(endpoint: string): { readonly host: string; readonly port: number } {
  const url = new URL(endpoint.includes('://') ? endpoint : `tcp://${endpoint}`);
  if (url.protocol !== 'http:' && url.protocol !== 'tcp:') {
    throw new Error(
      `The frozen relay forwards plaintext only; the relay target '${endpoint}' uses ` +
        `'${url.protocol}'. Point the suite at the emulator's http:// endpoint.`,
    );
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`The relay target '${endpoint}' names no port.`);
  }
  return { host: url.hostname, port };
}

/** How one call settled, and how long it took. */
export type Settled =
  | { readonly outcome: 'resolved'; readonly value: unknown; readonly elapsedMs: number }
  | { readonly outcome: 'rejected'; readonly error: unknown; readonly elapsedMs: number };

/**
 * Runs one call and records how it settled and its wall time.
 *
 * @param operation - The call to time
 * @returns Its outcome and elapsed milliseconds
 */
export async function timed(operation: () => Promise<unknown>): Promise<Settled> {
  const start = performance.now();
  try {
    const value = await operation();
    return { outcome: 'resolved', value, elapsedMs: performance.now() - start };
  } catch (error) {
    return { outcome: 'rejected', error, elapsedMs: performance.now() - start };
  }
}

/** What `/ready` and the database check answered across a freeze and a thaw. */
export interface ReadinessAcrossFreeze {
  /** `/ready` before the freeze. */
  readonly baseline: number;
  /** `/ready` on the first poll after the freeze, with its wall time. */
  readonly frozen: { readonly status: number; readonly elapsedMs: number };
  /** The database check's status in `/health` while frozen. */
  readonly frozenCheck: string | undefined;
  /** `/ready` once the relay is thawed and the cached answer has expired. */
  readonly recovered: number;
}

/** The plugin's readiness probe cache lifetime, in milliseconds. */
const PROBE_TTL_MS = 5000;

/**
 * Drives `/ready` of a real kernel application across a frozen store.
 *
 * The application connects while the relay forwards. The first poll primes the
 * plugin's 5-second probe cache, so the helper waits that cache out before it
 * freezes; the poll after the freeze therefore runs a fresh probe and its wall
 * time is the probe's own bound, not a cached answer.
 *
 * @param relay - The relay the database plugin points at
 * @param database - The configured database plugin
 * @returns The statuses and the frozen poll's wall time
 */
export async function readinessAcrossFreeze(
  relay: FrozenRelay,
  database: IPlugin,
): Promise<ReadinessAcrossFreeze> {
  const app = createApplication({ plugins: [RuntimePlugin(), database, HealthPlugin()] });
  await app.start();
  const ready = async (): Promise<number> =>
    (await app.inject({ method: 'GET', url: 'http://localhost/ready' })).statusCode;
  try {
    const baseline = await ready();
    await sleep(PROBE_TTL_MS + 200);
    relay.freeze();
    const start = performance.now();
    const status = await ready();
    const elapsedMs = performance.now() - start;
    const health = (await app.inject({ method: 'GET', url: 'http://localhost/health' })).json<{
      checks?: Record<string, { status: string }>;
    }>();
    const frozenCheck = (health.checks?.['database'] ?? Object.values(health.checks ?? {})[0])
      ?.status;
    relay.thaw();
    let recovered = await ready();
    for (let attempt = 0; recovered !== 200 && attempt < 40; attempt += 1) {
      await sleep(250);
      recovered = await ready();
    }
    return { baseline, frozen: { status, elapsedMs }, frozenCheck, recovered };
  } finally {
    relay.thaw();
    await app.stop();
  }
}
