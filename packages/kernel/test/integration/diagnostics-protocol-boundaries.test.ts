import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IWebSocketService, WebSocketUpgradeDecision } from '@setu-ts/common';

import { createApplication } from '../../src/application/application.ts';
import { runtimePlugin } from '../fixtures/runtime-plugin.ts';

function websocketPlugin(accept: boolean): IPlugin {
  // Structural double: the kernel's upgrade path reads ONLY `routeUpgrade`,
  // so the double carries exactly that member plus the full sink the accept
  // arm must supply. Cast through unknown — the omitted members are the
  // plugin's own concerns, not this boundary's. Header checking is the
  // service's routing decision, so the double mirrors it: no upgrade intent,
  // no claim.
  const service = {
    routeUpgrade: (request: Request): Promise<WebSocketUpgradeDecision | null> => {
      if (!request.headers.has('upgrade')) {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        accept
          ? {
            accept: true,
            sink: {
              onOpen: () => {},
              onMessage: () => {},
              onClose: () => {},
              onError: () => {},
            },
          }
          : { accept: false, status: 403 },
      );
    },
  } as unknown as IWebSocketService;
  return {
    name: 'fake-ws',
    version: '1.0.0',
    provides: [CAPABILITIES.WEBSOCKET],
    register(ctx) {
      ctx.services.register(CAPABILITIES.WEBSOCKET, service);
    },
  };
}

describe('diagnostics protocol boundaries', () => {
  it('a refused upgrade is recorded as a websocket-upgrade boundary, not an HTTP stage', async () => {
    const app = createApplication({
      plugins: [runtimePlugin(), websocketPlugin(false)],
      diagnostics: {},
    });
    await app.start();
    const response = await app.inject({
      method: 'GET',
      url: '/ws',
      headers: {
        upgrade: 'websocket',
        connection: 'upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    expect(response.statusCode).toBe(403);
    const events = app.diagnostics!.read(0).events;
    const boundary = events.find((event) => event.stage === 'websocket-upgrade');
    expect(boundary?.kind).toBe('handler');
    expect(boundary?.outcome).toBe('ok');
    expect(boundary?.statusCode).toBe(403);
    // No HTTP route node is claimed for a protocol dispatch.
    expect(boundary?.nodeId).toBeNull();
    await app.stop();
  });

  it('a gRPC dispatch boundary is recorded and claims no frame internals', async () => {
    const grpcPlugin: IPlugin = {
      name: 'fake-grpc',
      version: '1.0.0',
      provides: [CAPABILITIES.GRPC],
      register(ctx) {
        ctx.services.register(CAPABILITIES.GRPC, {
          available: true,
          claims: () => true,
          refuses: () => new Response('{"code":"refused"}', { status: 400 }),
        });
      },
    };
    const app = createApplication({
      plugins: [runtimePlugin(), grpcPlugin],
      diagnostics: {},
    });
    await app.start();
    const response = await app.inject({ method: 'POST', url: '/grpc/pkg.Svc/Method' });
    expect(response.statusCode).toBe(400);
    const boundary = app.diagnostics!.read(0).events.find(
      (event) => event.stage === 'grpc-dispatch',
    );
    expect(boundary?.kind).toBe('handler');
    expect(boundary?.outcome).toBe('ok');
    expect(boundary?.statusCode).toBe(400);
    await app.stop();
  });

  it('a protocol boundary that skips emits no record; streaming bodies are untouched', async () => {
    const grpcPlugin: IPlugin = {
      name: 'fake-grpc',
      version: '1.0.0',
      provides: [CAPABILITIES.GRPC],
      register(ctx) {
        ctx.services.register(CAPABILITIES.GRPC, {
          available: true,
          claims: () => false,
        });
      },
    };
    const app = createApplication({
      plugins: [runtimePlugin(), grpcPlugin, websocketPlugin(false)],
      diagnostics: {},
    });
    await app.start();
    // No upgrade headers and no gRPC claims: both boundaries decline and
    // neither records an executed record.
    const before = app.diagnostics!.read(0).events.filter(
      (event) => event.stage === 'websocket-upgrade' || event.stage === 'grpc-dispatch',
    );
    await app.inject({ method: 'GET', url: '/plain' });
    const events = app.diagnostics!.read(0).events;
    expect(before).toEqual([]);
    expect(events.some((event) => event.stage === 'websocket-upgrade')).toBe(false);
    expect(events.some((event) => event.stage === 'grpc-dispatch')).toBe(false);
    await app.stop();
  });

  it('a gRPC dispatch that THROWS records error and propagates the same failure', async () => {
    // The refusal path was covered and the throwing one was not, although it
    // is the arm that decides whether observation can alter a protocol
    // failure: `#tryGrpc` does not catch, so a rejecting `handleRequest`
    // reaches the observer's own catch.
    const grpcPlugin: IPlugin = {
      name: 'fake-grpc',
      version: '1.0.0',
      provides: [CAPABILITIES.GRPC],
      register(ctx) {
        ctx.services.register(CAPABILITIES.GRPC, {
          available: true,
          claims: () => true,
          refuses: () => null,
          handleRequest: () => Promise.reject(new Error('dispatch exploded')),
        });
      },
    };
    const app = createApplication({
      plugins: [runtimePlugin(), grpcPlugin],
      diagnostics: {},
    });
    await app.start();
    const response = await app.inject({ method: 'POST', url: '/grpc/pkg.Svc/Method' });
    // The rejection reached the kernel's own fallback, unchanged by observation.
    expect(response.statusCode).toBe(500);
    const boundary = app.diagnostics!.read(0).events.find(
      (event) => event.stage === 'grpc-dispatch',
    );
    expect(boundary?.outcome).toBe('error');
    // A thrown boundary produced no response of its own, so it claims none.
    expect(boundary?.statusCode).toBeUndefined();
    await app.stop();
  });

  it('an upgrade router that throws is recorded as a COMPLETED boundary carrying its 500', async () => {
    // `#tryUpgrade` catches a third-party routing failure, reports it, and
    // answers 500 itself — so the boundary CLAIMED the request and completed.
    // The record is therefore `ok` with `statusCode: 500`, not `error`: a
    // consumer spots this failure by the status, not by the outcome. Pinned
    // because nothing exercised it and the two readings are easy to confuse.
    const service = {
      routeUpgrade: (): Promise<WebSocketUpgradeDecision | null> =>
        Promise.reject(new Error('upgrade exploded')),
    } as unknown as IWebSocketService;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'fake-ws',
          version: '1.0.0',
          provides: [CAPABILITIES.WEBSOCKET],
          register(ctx) {
            ctx.services.register(CAPABILITIES.WEBSOCKET, service);
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    const response = await app.inject({
      method: 'GET',
      url: '/ws',
      headers: {
        upgrade: 'websocket',
        connection: 'upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    expect(response.statusCode).toBe(500);
    const boundary = app.diagnostics!.read(0).events.find(
      (event) => event.stage === 'websocket-upgrade',
    );
    expect(boundary?.outcome).toBe('ok');
    expect(boundary?.statusCode).toBe(500);
    await app.stop();
  });
});
