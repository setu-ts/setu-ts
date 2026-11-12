import { createRuntimeServices } from '@setu-ts/runtime';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, ERROR_RESPONDER_STATE_KEY, withHttpStatusHint } from '@setu-ts/common';
import type { IErrorResponder } from '@setu-ts/common';
import { errorHandler, HttpError, notFound } from '../../src/index.ts';
import { createFakeContext, FakeLogger } from '../fixtures/fake-runtime.ts';

describe('errorHandler logging and pure status prediction', () => {
  for (const [error, status] of [
    [notFound('missing'), 404],
    [new Error('fault'), 500],
    ['fault', 500],
    [
      withHttpStatusHint(new Error('hint'), { status: 409, title: 'Conflict', detail: 'Conflict' }),
      409,
    ],
    ...[4004, NaN, 199, 600, 204, 205, 304, 404.5].map(
      (code) => [new HttpError(code, 'bad status'), 500] as const,
    ),
  ] as const) {
    it(`predicts and serves ${status} for ${String(error)}`, async () => {
      const logger = new FakeLogger();
      const { ctx, responseSnapshot } = createFakeContext({
        services: new Map([[CAPABILITIES.LOGGER, logger]]),
      });
      await errorHandler()(ctx, () => {
        const responder = ctx.state.get(ERROR_RESPONDER_STATE_KEY) as IErrorResponder;
        expect(responder.statusFor?.(error)).toBe(status);
        expect(logger.calls).toEqual([]);
        throw error;
      });
      expect(responseSnapshot().status).toBe(status);
      const diagnostic = logger.calls.filter(
        (call) =>
          call.message !==
          'An error response carried an unserveable status; answering 500 instead.',
      );
      expect(diagnostic).toHaveLength(1);
      expect(diagnostic[0]?.level).toBe(status < 500 ? 'warn' : 'error');
      expect(diagnostic[0]?.meta).not.toHaveProperty('stack');
      expect(logger.calls.length).toBe(
        error instanceof HttpError && error.statusCode !== status ? 2 : 1,
      );
    });
  }

  // M130 audit: the message reached the log with a connection password in it,
  // while the same record's cause was masked by the logger's redaction.
  for (const [label, thrown, status] of [
    ['a 5xx driver error', new Error('connect failed: postgres://u:canary-pw@db/x'), 500],
    ['a 4xx HttpError', new HttpError(409, 'conflict at https://u:canary-pw@api.test/v1'), 409],
  ] as const) {
    it(`masks URL userinfo in the logged message for ${label}`, async () => {
      const logger = new FakeLogger();
      const { ctx } = createFakeContext({ services: new Map([[CAPABILITIES.LOGGER, logger]]) });
      await errorHandler()(ctx, () => {
        throw thrown;
      });
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0]?.level).toBe(status < 500 ? 'warn' : 'error');
      expect(logger.calls[0]?.message).not.toContain('canary-pw');
      expect(logger.calls[0]?.message).toMatch(/:\/\/\*\*\*@(db|api\.test)/);
      expect(JSON.stringify(logger.calls[0]?.meta)).not.toContain('canary-pw');
    });
  }

  it('masks URL userinfo inside an aggregate cause', async () => {
    const logger = new FakeLogger();
    const { ctx } = createFakeContext({ services: new Map([[CAPABILITIES.LOGGER, logger]]) });
    const cause = new AggregateError(
      [new Error('replica down: postgres://u:canary-pw@replica/x')],
      'all replicas failed',
    );
    await errorHandler()(ctx, () => {
      throw new HttpError(503, 'unavailable', undefined, cause);
    });
    const meta = JSON.stringify(logger.calls[0]?.meta);
    expect(meta).toContain('postgres://***@replica/x');
    expect(meta).not.toContain('canary-pw');
  });

  it('masks URL userinfo in the runtime sink message', async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const { ctx } = createFakeContext();
    ctx.services.register(CAPABILITIES.RUNTIME, {
      ...createRuntimeServices(),
      reportError: (record: Readonly<Record<string, unknown>>) => records.push(record),
    });
    await errorHandler()(ctx, () => {
      throw new Error('connect failed: postgres://u:canary-pw@db/x');
    });
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).not.toContain('canary-pw');
    expect(records[0]?.['message']).toBe('connect failed: postgres://***@db/x');
  });

  for (const withLogger of [false, true]) {
    for (const status of [404, 500]) {
      it(`sink is exclusive to no-logger 5xx (${withLogger}, ${status})`, async () => {
        const records: Readonly<Record<string, unknown>>[] = [];
        const { ctx } = createFakeContext();
        ctx.services.register(CAPABILITIES.RUNTIME, {
          ...createRuntimeServices(),
          reportError: (record: Readonly<Record<string, unknown>>) => records.push(record),
        });
        if (withLogger) ctx.services.register(CAPABILITIES.LOGGER, new FakeLogger());
        await errorHandler()(ctx, () => {
          throw new HttpError(status, 'diagnostic');
        });
        expect(records).toHaveLength(!withLogger && status === 500 ? 1 : 0);
        if (records.length)
          expect(records[0]).toMatchObject({
            level: 'error',
            message: 'diagnostic',
            statusCode: 500,
            requestId: ctx.id,
            method: 'GET',
            path: '/',
          });
      });
    }
  }
});

it('M131b 3.4 serves and logs RequestBodyReadError safely at warn', async () => {
  const { RequestBodyReadError } = await import('@setu-ts/runtime');
  const logger = new FakeLogger();
  const { ctx, responseSnapshot } = createFakeContext({
    services: new Map([[CAPABILITIES.LOGGER, logger]]),
  });
  await errorHandler()(ctx, () => {
    throw new RequestBodyReadError(new Error('CANARY request data'));
  });
  expect(responseSnapshot().status).toBe(400);
  expect(String(responseSnapshot().body)).not.toContain('CANARY');
  expect(logger.calls).toHaveLength(1);
  expect(logger.calls[0]?.level).toBe('warn');
  expect(JSON.stringify(logger.calls)).not.toContain('CANARY');
});
