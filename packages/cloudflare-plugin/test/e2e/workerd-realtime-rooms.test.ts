/**
 * Rooms on real workerd: two Workers sharing one Durable Object namespace.
 *
 * One `wrangler dev` session runs three configurations from
 * `fixtures/workerd-realtime`: a framework-free front Worker (the only one
 * `wrangler dev` exposes), Worker A (the chat app, owning the hub class) and
 * Worker B (the same app, binding the class by `script_name`). Both apps are
 * bundled from the workspace sources, at the scaffold's
 * `compatibility_date = "2025-09-01"`, which predates workerd's automatic
 * close reply.
 *
 * The fixtures' dates are checked against the CLI template's, through
 * wrangler's own config reader.
 *
 * Guarded like the CLI's Workers tests: skipped off CI when the `wrangler`
 * binary cannot run, failed on CI.
 *
 * Not provable here (no Cloudflare account): two isolates of one Worker, the
 * hub's hibernation on the platform, production connection limits.
 *
 * @module
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'workerd-realtime');
const wrangler = join(here, '..', '..', 'node_modules', '.bin', 'wrangler');

const onCi = process.env['CI'] === 'true';
const hasWrangler = spawnSync(wrangler, ['--version'], { encoding: 'utf8' }).status === 0;
const skip = !hasWrangler && !onCi;

const CASE_TIMEOUT_MS = 120_000;

let dev: ChildProcess | undefined;
let output = '';
let port = 0;

/** A free local port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check` holds, or fails after `ms`. */
async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

interface Client {
  readonly socket: WebSocket;
  readonly got: string[];
}

/**
 * Every client a test opens, closed after each test whatever its outcome, so
 * a failed case cannot leave members that skew a later `/size` or hub count.
 */
const openClients = new Set<WebSocket>();
const openRawSockets = new Set<Socket>();

/** How long one client may take to close before the cleanup fails. */
const CLOSE_TIMEOUT_MS = 5000;

/**
 * Closes every tracked client and waits until each has closed, then until the
 * server is back at its baseline: no member in any room the tests use, and no
 * link at the hub. A client that does not close in time, or a server that
 * keeps a member, fails the cleanup rather than skewing a later test.
 */
async function closeTracked(): Promise<void> {
  const stuck: string[] = [];
  const closing = [...openClients].map(
    (socket) =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          stuck.push(socket.url);
          resolve();
        }, CLOSE_TIMEOUT_MS);
        socket.addEventListener('close', () => {
          clearTimeout(timer);
          resolve();
        });
        if (socket.readyState !== WebSocket.CLOSING) socket.close(1000);
      }),
  );
  const rawClosing = [...openRawSockets].map(
    (raw) =>
      new Promise<void>((resolve) => {
        if (raw.closed) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          stuck.push('raw socket');
          resolve();
        }, CLOSE_TIMEOUT_MS);
        raw.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        raw.destroy();
      }),
  );
  await Promise.all([...closing, ...rawClosing]);
  openClients.clear();
  openRawSockets.clear();
  if (stuck.length > 0) throw new Error(`cleanup: clients did not close: ${stuck.join(', ')}`);
  await serverAtBaseline();
}

/**
 * Waits until every room the tests use is empty on both Workers and the hub
 * holds no link. A vanished client's link takes up to about 15 s to close.
 */
async function serverAtBaseline(): Promise<void> {
  const reads = ['/a/size', '/b/size', '/a/kept/size', '/b/kept/size', '/hub-count'];
  const deadline = Date.now() + 20_000;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = await Promise.all(reads.map(async (path) => (await text(path)).body));
    if (last.every((value) => value === '0')) return;
    await sleep(100);
  }
  throw new Error(
    `cleanup: server not at baseline: ${reads.map((r, i) => `${r}=${last[i]}`).join(' ')}`,
  );
}

/** A raw TCP connection to the front Worker, tracked for cleanup. */
function rawConnect(onConnect?: () => void): Socket {
  const socket =
    onConnect === undefined ? connect(port, '127.0.0.1') : connect(port, '127.0.0.1', onConnect);
  openRawSockets.add(socket);
  return socket;
}

/** Opens a WebSocket client on the front Worker. */
function client(path: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    openClients.add(socket);
    const got: string[] = [];
    socket.addEventListener('message', (event) => {
      got.push(String(event.data));
    });
    socket.addEventListener('open', () => {
      resolve({ socket, got });
    });
    socket.addEventListener('error', () => {
      reject(new Error(`could not open ${path}`));
    });
  });
}

/** GETs a front-Worker path as text. */
async function text(path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: response.status, body: await response.text() };
}

describe.skipIf(skip)('rooms on workerd across two Workers (V13-195, V13-196, V13-203)', () => {
  beforeAll(async () => {
    port = await freePort();
    dev = spawn(
      wrangler,
      [
        'dev',
        '-c',
        'front/wrangler.toml',
        '-c',
        'worker-a/wrangler.toml',
        '-c',
        'worker-b/wrangler.toml',
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      { cwd: fixture, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
    );
    dev.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    dev.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    await until(() => output.includes('Ready on'), 90_000, `wrangler dev:\n${output.slice(-3000)}`);
  }, CASE_TIMEOUT_MS);

  afterEach(async () => {
    await closeTracked();
  });

  afterAll(() => {
    if (dev?.pid !== undefined) {
      try {
        process.kill(-dev.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  });

  it(
    'delivers within a Worker and across Workers, from members and from a route',
    async () => {
      const a1 = await client('/a/chat');
      const a2 = await client('/a/chat');
      const b1 = await client('/b/chat');
      await sleep(300);

      a1.socket.send('from a1');
      await until(
        () => a2.got.includes('from a1') && b1.got.includes('from a1'),
        5000,
        'member broadcast',
      );
      const routed = await text('/b/broadcast', { method: 'POST', body: 'from a route' });
      await until(
        () => [a1, a2, b1].every((c) => c.got.includes('from a route')),
        5000,
        'route broadcast',
      );

      expect(routed.status).toBe(204);
      expect(a1.got).not.toContain('from a1');
      expect((await text('/a/size')).body).toBe('2');
      expect((await text('/b/size')).body).toBe('1');
      for (const c of [a1, a2, b1]) c.socket.close(1000);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'a 200-member room: 100 per Worker, every member hears a member and a route broadcast',
    async () => {
      const members: Client[] = [];
      for (let i = 0; i < 100; i++) members.push(await client('/a/chat'));
      for (let i = 0; i < 100; i++) members.push(await client('/b/chat'));
      await sleep(1000);

      members[0]?.socket.send('from member 0');
      await text('/a/broadcast', { method: 'POST', body: 'from the route' });
      await until(
        () =>
          members.slice(1).every((c) => c.got.includes('from member 0')) &&
          members.every((c) => c.got.includes('from the route')),
        20_000,
        'delivery to 200 members',
      );

      expect((await text('/a/size')).body).toBe('100');
      expect((await text('/b/size')).body).toBe('100');
      for (const c of members) c.socket.close(1000);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "keeps delivering after 25 turnovers, and the hub's sockets follow live members",
    async () => {
      await sleep(1500);
      const listener = await client('/b/chat');
      let current = await client('/a/chat');
      for (let i = 0; i < 25; i++) {
        current.socket.close(1000);
        current = await client('/a/chat');
      }
      await sleep(1500);

      current.socket.send('after turnovers');
      await until(() => listener.got.includes('after turnovers'), 5000, 'delivery after turnovers');
      // Request-bound mode opens no isolate socket: one hub socket per live member.
      await until(hubCountIs(2), 5000, 'hub socket count');
      listener.socket.close(1000);
      current.socket.close(1000);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'answers a clean close at once with 1000, and drops a client that vanished without one',
    async () => {
      const c = await client('/a/chat');
      const started = Date.now();
      const closed = new Promise<{ code: number; ms: number }>((resolve) => {
        c.socket.addEventListener('close', (event) => {
          resolve({ code: event.code, ms: Date.now() - started });
        });
      });
      c.socket.close(1000, 'bye');
      const result = await closed;
      expect(result.code).toBe(1000);
      expect(result.ms).toBeLessThan(1000);

      // A raw handshake whose socket is destroyed: no close frame at all.
      await sleep(1500);
      const before = Number((await text('/hub-count')).body);
      const raw = rawConnect();
      raw.write(
        'GET /a/chat HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
      await new Promise<void>((resolve) => raw.once('data', () => resolve()));
      await until(hubCountIs(before + 1), 5000, 'the raw client link');
      raw.destroy();
      await until(hubCountIs(before), 15_000, 'the vanished client link to close');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'isolates rooms across Workers: a member of room X never receives room Y traffic',
    async () => {
      const xa = await client('/a/chat?room=x');
      const xb = await client('/b/chat?room=x');
      const ya = await client('/a/chat?room=y');
      const yb = await client('/b/chat?room=y');
      await sleep(300);

      xa.socket.send('for x');
      yb.socket.send('for y');
      await until(
        () => xb.got.includes('for x') && ya.got.includes('for y'),
        5000,
        'room delivery',
      );
      await sleep(500);

      expect(xb.got).toEqual(['for x']);
      expect(ya.got).toEqual(['for y']);
      expect(xa.got).toEqual([]);
      expect(yb.got).toEqual([]);
      for (const c of [xa, xb, ya, yb]) c.socket.close(1000);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "runs every fixture at the scaffold's compatibility date, read the way wrangler reads it",
    async () => {
      const template = await readFile(
        join(here, '..', '..', '..', 'cli', 'src', 'templates', 'project-files.ts'),
        'utf8',
      );
      const scaffold = /compatibility_date = "([0-9-]+)"/.exec(template)?.[1];
      const { unstable_readConfig } = await import('wrangler');
      const configs = ['front', 'worker-a', 'worker-b']
        .map((name) => join(fixture, name, 'wrangler.toml'))
        .concat(join(here, 'fixtures', 'workerd-queue', 'wrangler.toml'));
      const dates = configs.map(
        (config) => unstable_readConfig({ config }, { hideWarnings: true }).compatibility_date,
      );

      expect(scaffold).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(dates).toEqual(configs.map(() => scaffold));
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "answers a client's handshake with no Sec-WebSocket-Key 400 through the gateway Worker",
    async () => {
      // Behind a gateway the edge refuses it: workerd builds a fresh handshake
      // for the subrequest, so Worker A sees a valid key whatever the client
      // sent and cannot refuse it itself (workerd-handshake.test.ts covers an
      // app that receives edge requests directly).
      const head = await new Promise<string>((resolve, reject) => {
        const socket = rawConnect(() => {
          socket.write(
            'GET /a/chat HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n' +
              'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n',
          );
        });
        let reply = '';
        socket.on('data', (chunk: Buffer) => {
          reply += chunk.toString('latin1');
          if (reply.includes('\r\n')) {
            socket.destroy();
            resolve(reply.slice(0, reply.indexOf('\r\n')));
          }
        });
        socket.on('error', reject);
      });

      expect(head).toBe('HTTP/1.1 400 Bad Request');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'opens a Worker-to-Worker socket over a service binding to another Worker: still 101 and onOpen',
    async () => {
      // workerd builds that handshake itself; the adapter's check is for
      // requests from the edge, which carry `cf` (V13-278 exemption).
      const before = Number((await text('/a/opens')).body);
      const answered = await text('/worker-to-worker');

      expect(answered.body).toBe('101');
      expect(Number((await text('/a/opens')).body)).toBe(before + 1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'a kept room object and ws.room(name) are one member set, once per connection',
    async () => {
      expect((await text('/a/kept/hold')).status).toBe(204);
      // Join through the kept object, then leave: the name empties.
      const first = await client('/a/kept/chat?via=kept');
      await sleep(300);
      first.socket.close(1000);
      await until(() => first.socket.readyState === WebSocket.CLOSED, 5000, 'first close');
      // The scenario needs the name emptied on the server, not only the client closed.
      let size = '';
      const emptied = Date.now() + 5000;
      while (size !== '0' && Date.now() < emptied) {
        size = (await text('/a/kept/size')).body;
        if (size !== '0') await sleep(50);
      }
      expect(size).toBe('0');
      // A fresh handle takes the name; another member joins through the kept one.
      const b = await client('/a/kept/chat?via=fresh');
      const c = await client('/a/kept/chat?via=kept');
      await sleep(300);

      // b joined through ws.room('kept'); its message is broadcast through the
      // kept object, so both handles must reach both members.
      b.socket.send('member');
      expect((await text('/a/kept/broadcast', { method: 'POST', body: 'route' })).status).toBe(204);
      await until(
        () => [b, c].every((x) => x.got.includes('member') && x.got.includes('route')),
        5000,
        'both broadcasts at both members',
      );
      await sleep(300);

      for (const x of [b, c]) {
        expect(x.got.filter((m) => m === 'member')).toHaveLength(1);
        expect(x.got.filter((m) => m === 'route')).toHaveLength(1);
      }
      expect((await text('/a/kept/size')).body).toBe('2');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'isolate-level publishes from concurrent requests all reach the hub, with no socket churn',
    async () => {
      // The hub's own socket hears every frame it fans out.
      const listener = await client('/hub-listen?topic=iso');
      const ids = ['a', 'b'].flatMap((w) => Array.from({ length: 20 }, (_, i) => `${w}-${i}`));

      const answers = await Promise.all(
        ids.map((id) => text(`/${id.slice(0, 1)}/iso/publish?id=${id}`, { method: 'POST' })),
      );
      await until(
        () => ids.every((id) => listener.got.some((m) => m.includes(`"data":"${id}"`))),
        10_000,
        'every frame at the hub',
      );
      const stats = async (w: string): Promise<IsoStats> =>
        JSON.parse((await text(`/${w}/iso/stats`)).body) as IsoStats;
      const a = await stats('a');
      const b = await stats('b');

      expect(answers.every((r) => r.status === 204)).toBe(true);
      expect(listener.got).toHaveLength(ids.length);
      for (const s of [a, b]) {
        expect(s.posts).toBe(20);
        // One receiving socket each: a publish from another request never
        // touches it, so nothing retires and reopens it.
        expect(s.opens).toBe(1);
        expect(s.warnings).toEqual([]);
      }

      // The receive side. A replica hears a frame only once its receiving socket
      // has joined the hub, so B may miss A's first frames (measured: it did);
      // A's socket belongs to one of the requests above, all of which have
      // answered. Does it still hear B afterwards?
      await sleep(2000);
      for (let i = 0; i < 5; i++) await text(`/b/iso/publish?id=late-${i}`, { method: 'POST' });
      const late = Array.from({ length: 5 }, (_, i) => `late-${i}`);
      let later = await stats('a');
      const deadline = Date.now() + 5000;
      while (!late.every((id) => later.received.includes(id)) && Date.now() < deadline) {
        await sleep(100);
        later = await stats('a');
      }
      // Locally, yes: the socket outlives the request that opened it.
      expect(later.received).toEqual(expect.arrayContaining(late));
      expect(later.opens).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'control: without the Durable Object arm, ws.room() answers the named error',
    async () => {
      const bare = await text('/a/rooms-without-arm');
      expect(bare).toEqual({ status: 500, body: 'WebSocketRoomsUnavailableError' });
    },
    CASE_TIMEOUT_MS,
  );
});

/** Latest hub count, refreshed by {@linkcode hubCountIs}. */
let hubCount = -1;

/**
 * A synchronous check over a hub count refreshed in the background, so
 * {@linkcode until} can poll it.
 */
function hubCountIs(expected: number): () => boolean {
  void text('/hub-count').then((r) => {
    hubCount = Number(r.body);
  });
  return () => {
    void text('/hub-count').then((r) => {
      hubCount = Number(r.body);
    });
    return hubCount === expected;
  };
}

/** What `/iso/stats` answers. */
interface IsoStats {
  readonly opens: number;
  readonly posts: number;
  readonly warnings: readonly string[];
  readonly received: readonly string[];
}
