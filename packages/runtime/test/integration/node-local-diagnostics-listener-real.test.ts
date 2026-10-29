import { createServer } from 'node:http';
import { createServer as createTcpServer, createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '../../../kernel/src/index.ts';
import { RuntimePlugin } from '../../src/index.ts';
import {
  createDiagnosticsClient,
  DiagnosticsPlugin,
} from '../../../diagnostics-plugin/src/index.ts';
import {
  NodeLocalDiagnosticsListenerFactory,
  NODE_LISTENER_SERVER_OPTIONS,
  PARSER_REFUSAL_BYTES,
} from '../../src/diagnostics/node-local-diagnostics-listener.ts';
import type { NodeListenerHost } from '../../src/diagnostics/node-local-diagnostics-listener.ts';
import { SINGLETON_HEADER_NAMES } from '../../src/diagnostics/local-diagnostics-listener.ts';
import { unusedPort } from '../../../../test/node-helpers.ts';
import { diagnosticsResponse } from '../fixtures/diagnostics-response.ts';
import { exchangeDiagnosticsWire } from '../fixtures/diagnostics-wire.ts';

function connected(port: number): Promise<Socket> {
  const socket = createConnection({ host: '127.0.0.1', port });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function start() {
  const port = await unusedPort();
  const factory = new NodeLocalDiagnosticsListenerFactory({
    createServer: (options, handler) => createServer(options, handler),
    writeStderr() {},
  });
  const listener = await factory.listen({ port, handler: () => diagnosticsResponse() });
  return { port, factory, listener };
}

/** Counts usable server sockets after synchronous connection admission has run. */
function countedConnections() {
  const sockets = new Set<Socket>();
  const arrivals: Socket[] = [];
  const full = Promise.withResolvers<void>();
  let peak = 0;
  const open = (): number => [...sockets].filter((socket) => !socket.destroyed).length;
  const sample = (): void => {
    peak = Math.max(peak, open());
  };
  const host: NodeListenerHost = {
    createServer(options, handler) {
      const server = createServer(options, handler);
      server.on('connection', (socket) => {
        sockets.add(socket);
        arrivals.push(socket);
        socket.once('close', () => {
          sockets.delete(socket);
          sample();
        });
        // destroy() closes a socket synchronously; its close event follows later.
        // Observe after the listener's admission callback, excluding destroyed
        // sockets awaiting close, rather than counting them as still open.
        queueMicrotask(sample);
        if (arrivals.length === 32) full.resolve();
      });
      return server;
    },
    writeStderr() {},
  };
  return { host, arrivals, full: full.promise, open, peak: () => peak };
}

describe('Node diagnostics listener — real sockets', () => {
  it('binds only IPv4 loopback and exposes exactly close', async () => {
    let address: unknown;
    const factory = new NodeLocalDiagnosticsListenerFactory({
      createServer(options, handler) {
        const server = createServer(options, handler);
        server.once('listening', () => {
          address = server.address();
        });
        return server;
      },
    });
    const port = await unusedPort();
    const listener = await factory.listen({
      port,
      handler: () => diagnosticsResponse(),
      onListen() {},
    });
    try {
      expect(address).toMatchObject({ address: '127.0.0.1', port });
      expect(Object.keys(listener)).toEqual([]);
      const response = await exchangeDiagnosticsWire(
        port,
        `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
      expect(response.status).toBe(200);
      expect(response.body).toBe('served');
      expect(response.headers.get('content-length')).toBe('6');
    } finally {
      await listener.close();
    }
  });

  it('rejects EADDRINUSE through the factory and fails DiagnosticsPlugin startup closed', async () => {
    const occupant = createTcpServer();
    await new Promise<void>((resolve, reject) => {
      occupant.once('error', reject);
      occupant.listen(0, '127.0.0.1', resolve);
    });
    const address = occupant.address();
    if (address === null || typeof address === 'string') throw new Error('Missing TCP address');
    const port = address.port;
    const factory = new NodeLocalDiagnosticsListenerFactory();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port,
          sessionId: 'a'.repeat(32),
          sessionKey: new Uint8Array(32),
        }),
      ],
      diagnostics: {},
    });
    try {
      await expect(
        factory.listen({ port, handler: () => diagnosticsResponse() }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      await expect(app.start()).rejects.toThrow();
      expect(occupant.address()).toEqual(address);
    } finally {
      await factory.closeActive();
      await app.stop();
      await new Promise<void>((resolve, reject) =>
        occupant.close((error) => (error ? reject(error) : resolve())),
      );
    }
    // A rejected bind releases the factory slot and permits a real retry.
    await (
      await factory.listen({ port, handler: () => diagnosticsResponse(), onListen() {} })
    ).close();
  });

  for (const name of SINGLETON_HEADER_NAMES) {
    it(`refuses duplicate raw ${name} lines before the handler`, async () => {
      let calls = 0;
      const port = await unusedPort();
      const factory = new NodeLocalDiagnosticsListenerFactory();
      const listener = await factory.listen({
        port,
        onListen() {},
        handler: () => {
          calls++;
          return diagnosticsResponse();
        },
      });
      try {
        const headers =
          name === 'host'
            ? `Host: 127.0.0.1:${port}\r\nHOST: CANARY`
            : `Host: 127.0.0.1:${port}\r\n${name}: a\r\n${name.toUpperCase()}: CANARY`;
        const result = await exchangeDiagnosticsWire(
          port,
          `GET /v1/status HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`,
        );
        expect(result.status).toBe(400);
        expect(result.body).toBe('{"version":1,"error":"invalid-request"}');
        expect(result.raw).not.toContain('CANARY');
        expect(calls).toBe(0);
      } finally {
        await listener.close();
      }
    });
  }

  for (const event of ['connect', 'upgrade'] as const) {
    it(`refuses native ${event} dispatch and closes a peer that sends no EOF`, async () => {
      const port = await unusedPort();
      let called = false;
      const factory = new NodeLocalDiagnosticsListenerFactory();
      const listener = await factory.listen({
        port,
        onListen() {},
        handler: () => {
          called = true;
          return diagnosticsResponse();
        },
      });
      try {
        const request =
          event === 'connect'
            ? `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`
            : `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`;
        const response = await exchangeDiagnosticsWire(port, request);
        expect(response.status).toBe(400);
        expect(response.body).toBe('{"version":1,"error":"invalid-request"}');
        expect(called).toBe(false);
      } finally {
        await listener.close();
      }
    });
  }

  for (const [name, request] of [
    ['garbage', () => 'CANARY invalid\r\n\r\n'],
    [
      'dual Content-Length',
      (p: number) =>
        `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n`,
    ],
    [
      'TE/CL',
      (p: number) =>
        `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n0\r\n\r\n`,
    ],
    [
      'oversize headers',
      (p: number) =>
        `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nX-Canary: ${'CANARY'.padEnd(20_000, 'x')}\r\n\r\n`,
    ],
  ] as const) {
    it(`returns the fixed bare parser refusal for ${name}`, async () => {
      const { port, listener } = await start();
      try {
        expect((await exchangeDiagnosticsWire(port, request(port))).raw).toBe(PARSER_REFUSAL_BYTES);
      } finally {
        await listener.close();
      }
    });
  }

  it('bounds a partial-header slowloris by headersTimeout plus the checking interval', async () => {
    const { port, listener } = await start();
    const bound =
      NODE_LISTENER_SERVER_OPTIONS.headersTimeout +
      NODE_LISTENER_SERVER_OPTIONS.connectionsCheckingInterval +
      1_000;
    const began = performance.now();
    try {
      const response = await exchangeDiagnosticsWire(
        port,
        `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Canary: CANARY`,
        bound + 500,
      );
      expect(response.raw).toBe(PARSER_REFUSAL_BYTES);
      expect(performance.now() - began).toBeLessThanOrEqual(bound);
    } finally {
      await listener.close();
    }
  });

  it('closes in under one second with idle keep-alive and partial-header sockets', async () => {
    const { port, listener } = await start();
    const idle = await connected(port);
    const partial = await connected(port);
    try {
      await new Promise<void>((resolve, reject) => {
        idle.once('data', () => resolve());
        idle.once('error', reject);
        idle.write(
          `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`,
        );
      });
      partial.write(`GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Canary: `);
      const closed = [idle, partial].map(
        (socket) => new Promise<void>((resolve) => socket.once('close', () => resolve())),
      );
      const began = performance.now();
      await listener.close();
      await Promise.all(closed);
      expect(performance.now() - began).toBeLessThan(1_000);
    } finally {
      idle.destroy();
      partial.destroy();
      await listener.close();
    }
  });

  it('evicts the oldest idle socket and serves the 33rd connection without exceeding 32 open sockets', async () => {
    const port = await unusedPort();
    const counted = countedConnections();
    const factory = new NodeLocalDiagnosticsListenerFactory(counted.host);
    const listener = await factory.listen({
      port,
      handler: () => diagnosticsResponse(),
      onListen() {},
    });
    const sockets: Socket[] = [];
    try {
      for (let index = 0; index < 32; index++) {
        const socket = await connected(port);
        socket.resume();
        sockets.push(socket);
      }
      await counted.full;
      expect(counted.open()).toBe(32);
      const oldestClosed = new Promise<void>((resolve) =>
        sockets[0]!.once('close', () => resolve()),
      );
      const served = await exchangeDiagnosticsWire(
        port,
        `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
      await oldestClosed;
      expect(served.status).toBe(200);
      expect(served.body).toBe('served');
      expect(sockets[0]!.destroyed).toBe(true);
      expect(sockets.slice(1).every((socket) => !socket.destroyed)).toBe(true);
      expect(counted.arrivals).toHaveLength(33);
      expect(counted.peak()).toBe(32);
    } finally {
      await listener.close();
      for (const socket of sockets) socket.destroy();
    }
  });

  it('serves eight consecutive real-client snapshots through DiagnosticsPlugin while 32 partial requests are held', async () => {
    const counted = countedConnections();
    const factory = new NodeLocalDiagnosticsListenerFactory(counted.host);
    const port = await unusedPort();
    const sessionId = 'a'.repeat(32);
    const sessionKey = new Uint8Array(32).map((_, index) => index);
    const app = createApplication({
      diagnostics: {},
      plugins: [
        RuntimePlugin(),
        {
          name: 'flood-counted-local-listener',
          version: '1.0.0',
          register(ctx) {
            ctx.services.register(CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER, factory, {
              override: true,
            });
            ctx.lifecycle.onClose(() => factory.closeActive());
          },
        },
        DiagnosticsPlugin({ enabled: true, port, sessionId, sessionKey, ttlMs: 30_000 }),
      ],
    });
    const client = createDiagnosticsClient({
      endpoint: `http://127.0.0.1:${port}`,
      sessionId,
      sessionKey,
      subtle: crypto.subtle,
      fetch,
      timing: { setTimeout, clearTimeout },
    });
    const held: Socket[] = [];
    try {
      await app.start();
      for (let index = 0; index < 32; index++) {
        const socket = await connected(port);
        socket.resume();
        socket.write(`GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
        held.push(socket);
      }
      await counted.full;
      expect(counted.open()).toBe(32);
      for (let index = 0; index < 8; index++) {
        expect((await client.snapshot()).state, `snapshot ${index + 1} of 8`).toBe('running');
      }
      expect(counted.arrivals.length).toBeGreaterThan(32);
      expect(counted.arrivals[0]!.destroyed).toBe(true);
      expect(counted.peak()).toBe(32);
      expect(counted.open()).toBeLessThanOrEqual(32);
    } finally {
      client.close();
      for (const socket of held) socket.destroy();
      await app.stop();
      await factory.closeActive();
    }
  });

  it('pairs, snapshots, reads and renews through the real client with peak connections at most 16', async () => {
    let active = 0;
    let peak = 0;
    const host: NodeListenerHost = {
      createServer(options, handler) {
        const server = createServer(options, handler);
        server.on('connection', (socket) => {
          active++;
          peak = Math.max(peak, active);
          socket.once('close', () => {
            active--;
          });
        });
        return server;
      },
    };
    const factory = new NodeLocalDiagnosticsListenerFactory(host);
    const port = await unusedPort();
    const sessionId = 'a'.repeat(32);
    const sessionKey = new Uint8Array(32).map((_, i) => i);
    const app = createApplication({
      diagnostics: {},
      plugins: [
        RuntimePlugin(),
        {
          name: 'counted-local-listener',
          version: '1.0.0',
          register(ctx) {
            ctx.services.register(CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER, factory, {
              override: true,
            });
            ctx.lifecycle.onClose(() => factory.closeActive());
          },
        },
        {
          name: 'observed-route',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/observed', (c) => c.response.text('observed'));
          },
        },
        DiagnosticsPlugin({
          enabled: true,
          port,
          sessionId,
          sessionKey,
          ttlMs: 10_000,
          maxSessionLifetimeMs: 30_000,
        }),
      ],
    });
    const client = createDiagnosticsClient({
      endpoint: `http://127.0.0.1:${port}`,
      sessionId,
      sessionKey,
      subtle: crypto.subtle,
      fetch,
      timing: { setTimeout, clearTimeout },
    });
    try {
      await app.start();
      expect((await client.session()).renewal).not.toBeNull();
      expect((await client.snapshot()).state).toBe('running');
      expect((await app.inject({ method: 'GET', url: '/observed' })).statusCode).toBe(200);
      expect((await client.read(0)).events.length).toBeGreaterThan(0);
      expect((await client.renew()).expiresInMs).toBeGreaterThan(0);
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(16);
    } finally {
      client.close();
      await app.stop();
      await factory.closeActive();
    }
  });
});
