import { expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/**
 * With no logger registered, the kernel reports an unhandled error straight to
 * `runtime.reportError` — stderr in production — where no LoggerPlugin
 * redaction runs. URL userinfo must be masked there as it is on the wire and
 * through LoggerPlugin: in the message, the stack and every serialized cause.
 */
async function report(thrown: Error): Promise<Record<string, unknown>> {
  const fake = createFakeRuntime();
  const reportError = vi.fn();
  fake.runtime.reportError = reportError;
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
  app.router.get('/boom', () => {
    throw thrown;
  });
  await app.start();
  try {
    await app.inject({ method: 'GET', url: '/boom' });
  } finally {
    await app.stop();
  }
  expect(reportError).toHaveBeenCalledOnce();
  return reportError.mock.calls[0]![0] as Record<string, unknown>;
}

it('masks URL userinfo in the message, stack and cause of a logger-less report', async () => {
  const cause = new Error('dial redis://default:causeS3cret@cache:6379 refused');
  const record = await report(
    new Error('connect postgres://app:topS3cret@db.internal/orders failed', { cause }),
  );

  const raw = JSON.stringify(record);
  expect(raw).not.toContain('topS3cret');
  expect(raw).not.toContain('causeS3cret');
  expect(record.message).toBe('connect postgres://***@db.internal/orders failed');
  expect(String(record.stack)).toContain('postgres://***@db.internal/orders');
  expect((record.cause as { message: string }).message).toBe('dial redis://***@cache:6379 refused');
});

it('leaves a record with no URL userinfo unchanged and keeps every field', async () => {
  const record = await report(new Error('plain failure at https://db.internal/orders'));

  expect(record).toMatchObject({
    level: 'error',
    msg: 'Unhandled request error',
    name: 'Error',
    message: 'plain failure at https://db.internal/orders',
    method: 'GET',
    path: '/boom',
  });
  expect(typeof record.requestId).toBe('string');
  expect(String(record.stack)).toContain('plain failure at https://db.internal/orders');
});
