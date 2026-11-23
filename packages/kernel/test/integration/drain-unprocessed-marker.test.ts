import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  brandErrorResponder,
  UNPROCESSED_HEADER,
  UNPROCESSED_SHUTDOWN,
} from '@setu-ts/common';
import type { IPlugin, MiddlewareFunction } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import { createApplication } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

type Entry = 'inject' | 'dispatch' | 'fetch';
async function request(app: ReturnType<typeof createApplication>, entry: Entry, path: string) {
  if (entry === 'inject') {
    const response = await app.inject({ method: 'GET', url: path });
    return { status: response.statusCode, headers: response.headers, body: response.body };
  }
  const raw = new Request(`http://localhost${path}`);
  const response = entry === 'fetch' ? await app.fetch(raw) : await app.dispatch!(raw);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

function setup(entry: Entry, responder: 'none' | 'problem' | 'other') {
  const fake = createFakeRuntime();
  const plugin: IPlugin = {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
      ctx.services.register(CAPABILITIES.HTTP_ADAPTER, fake.adapter);
    },
  };
  const app = createApplication({ plugins: [entry === 'fetch' ? RuntimePlugin() : plugin] });
  const ran: string[] = [];
  if (responder === 'problem')
    app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }));
  if (responder === 'other') {
    const middleware: MiddlewareFunction = (_ctx, next) => next();
    brandErrorResponder(middleware, {
      respond(target) {
        target.response
          .status(429)
          .header(UNPROCESSED_HEADER, 'application-value')
          .json({ custom: true });
      },
    });
    app.middleware.add(middleware);
  }
  app.register({
    name: 'request-observer',
    version: '1.0.0',
    register(ctx) {
      ctx.lifecycle.onRequest(() => {
        ran.push('hook');
      });
    },
  });
  app.middleware.add((_ctx, next) => {
    ran.push('middleware');
    return next();
  });
  app.router.get('/own', (ctx) => {
    ran.push('handler');
    return ctx.response.status(503).text('own');
  });
  app.router.get('/reserved', (ctx) =>
    ctx.response.header(UNPROCESSED_HEADER, UNPROCESSED_SHUTDOWN).text('claimed by application'),
  );
  return { app, fake, ran };
}

describe.each(['inject', 'dispatch', 'fetch'] as const)('drain marker through %s', (entry) => {
  it.each(['none', 'problem', 'other'] as const)(
    'marks a pre-pipeline refusal with responder %s',
    async (responder) => {
      const { app, fake, ran } = setup(entry, responder);
      await app.start();
      // Positive control for the absence assertions below: a normal request runs every stage.
      expect((await request(app, entry, '/own')).status).toBe(503);
      expect(ran).toEqual(['hook', 'middleware', 'handler']);
      ran.length = 0;
      const stopping = app.stop();
      try {
        const response = await request(app, entry, '/own');
        expect(response.headers.get(UNPROCESSED_HEADER)).toBe(UNPROCESSED_SHUTDOWN);
        expect(response.status).toBe(responder === 'other' ? 429 : 503);
        expect(ran).toEqual([]);
        if (responder === 'problem') {
          expect(response.headers.get('content-type')).toBe('application/problem+json');
          expect(JSON.parse(response.body!)).toMatchObject({
            status: 503,
            title: 'Service Unavailable',
            type: 'about:blank',
          });
        }
      } finally {
        fake.tick(20_000);
        await stopping;
      }
    },
  );
  it('leaves ordinary handler 503s unmarked and preserves an application-written marker', async () => {
    const { app, fake } = setup(entry, 'none');
    await app.start();
    try {
      expect((await request(app, entry, '/own')).headers.has(UNPROCESSED_HEADER)).toBe(false);
      expect((await request(app, entry, '/reserved')).headers.get(UNPROCESSED_HEADER)).toBe(
        UNPROCESSED_SHUTDOWN,
      );
    } finally {
      const stopping = app.stop();
      fake.tick(20_000);
      await stopping;
    }
  });
  it('never marks a request admitted before the drain, even when it finishes with 503', async () => {
    const { app, fake } = setup(entry, 'none');
    let entered!: () => void;
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.router.get('/pending', async (ctx) => {
      entered();
      await gate;
      return ctx.response.status(503).text('processed');
    });
    await app.start();
    const pending = request(app, entry, '/pending');
    await admitted;
    const stopping = app.stop();
    try {
      // This positive control proves the application is actually draining.
      expect((await request(app, entry, '/own')).headers.get(UNPROCESSED_HEADER)).toBe(
        UNPROCESSED_SHUTDOWN,
      );
    } finally {
      release();
    }
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.body).toBe('processed');
    expect(response.headers.has(UNPROCESSED_HEADER)).toBe(false);
    fake.tick(50);
    await stopping;
  });
});
