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

  for (const withLogger of [false, true]) {
    for (const status of [404, 500]) {
      it(`sink is exclusive to no-logger 5xx (${withLogger}, ${status})`, async () => {
        const records: Readonly<Record<string, unknown>>[] = [];
        const { ctx } = createFakeContext();
        ctx.services.register(CAPABILITIES.RUNTIME, {
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
