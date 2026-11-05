import { expect, it, vi } from 'vitest';
import { CAPABILITIES, HTTP_STATUS_HINT, withHttpStatusHint } from '@setu-ts/common';
import type { ILogger } from '@setu-ts/common';
import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { internalServerError, notFound } from '@setu-ts/exceptions';

for (const status of [400, 499, 503, undefined]) {
  for (const logger of [false, true]) {
    it(`M131b 3.4 fallback status ${status} logger=${logger}`, async () => {
      const fake = createFakeRuntime();
      const report = vi.fn();
      fake.runtime.reportError = report;
      const errorLog = vi.fn();
      const warnLog = vi.fn();
      const app = createApplication({
        plugins: [
          {
            name: 'runtime',
            version: '1.0.0',
            provides: [CAPABILITIES.RUNTIME],
            register(ctx) {
              ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
              if (logger)
                ctx.services.register(CAPABILITIES.LOGGER, {
                  error: errorLog,
                  warn: warnLog,
                } as unknown as ILogger);
            },
          },
        ],
      });
      const error = new Error('private message');
      if (status !== undefined)
        withHttpStatusHint(error, { status, title: 'Nonstandard title', detail: 'safe detail' });
      app.router.post('/', () => {
        throw error;
      });
      await app.start();
      try {
        const response = await app.inject({ method: 'POST', url: '/' });
        const client = status !== undefined && status < 500;
        expect(response.statusCode).toBe(client ? status : 500);
        expect(response.json()).toEqual(
          client
            ? // The hint's own title, as errorHandler serves it (buildErrorFromInit).
              { error: 'Nonstandard title', detail: 'safe detail' }
            : { error: 'Internal Server Error' },
        );
        if (logger) expect(client ? warnLog : errorLog).toHaveBeenCalledOnce();
        else
          expect(report).toHaveBeenCalledWith(
            expect.objectContaining({ level: client ? 'warn' : 'error' }),
          );
      } finally {
        await app.stop();
      }
    });
  }
}

it('M131b review: a hint that changes between reads still serves one consistent response', async () => {
  const fake = createFakeRuntime();
  fake.runtime.reportError = vi.fn();
  const app = createApplication({
    plugins: [
      {
        name: 'runtime',
        version: '1.0.0',
        provides: [CAPABILITIES.RUNTIME],
        register(ctx) {
          ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
        },
      },
    ],
  });
  // The first read of the carrier answers a 409; every later read a 503.
  const answers = [
    { status: 409, title: 'Conflict', detail: 'first read' },
    { status: 503, title: 'Unavailable', detail: 'later read' },
  ];
  let reads = 0;
  const error = new Error('private message');
  Object.defineProperty(error, HTTP_STATUS_HINT, {
    get: () => answers[Math.min(reads++, 1)],
  });
  app.router.post('/', () => {
    throw error;
  });
  await app.start();
  try {
    const response = await app.inject({ method: 'POST', url: '/' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Conflict', detail: 'first read' });
    expect(reads).toBe(1);
  } finally {
    await app.stop();
  }
});

// A 4xx HttpError carries the status hint, so the fallback answers it as the
// caller error it is — not as an opaque 500 — when no errorHandler is
// registered. A 5xx HttpError carries none and stays opaque.
for (const [thrown, status, body] of [
  [() => notFound('gone'), 404, { error: 'Not Found', detail: 'gone' }],
  [
    () => notFound('no row at postgres://app:s3cret@db.internal/orders'),
    404,
    { error: 'Not Found', detail: 'no row at postgres://***@db.internal/orders' },
  ],
  [() => internalServerError('db password=x'), 500, { error: 'Internal Server Error' }],
] as const) {
  it(`answers a thrown HttpError ${status} without errorHandler (${JSON.stringify(body)})`, async () => {
    const fake = createFakeRuntime();
    const report = vi.fn();
    fake.runtime.reportError = report;
    const app = createApplication({
      plugins: [
        {
          name: 'runtime',
          version: '1.0.0',
          provides: [CAPABILITIES.RUNTIME],
          register(ctx) {
            ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
          },
        },
      ],
    });
    app.router.get('/', () => {
      throw thrown();
    });
    await app.start();
    try {
      const response = await app.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual(body);
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ level: status < 500 ? 'warn' : 'error' }),
      );
    } finally {
      await app.stop();
    }
  });
}
