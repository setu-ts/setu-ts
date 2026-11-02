/**
 * A backend fault reaches the client as a 503 or a 504, never a masked 500
 * (M131a X88-5).
 *
 * `toBackendFault` (common) wraps a thrown driver error in
 * `BackendUnavailableError` (the request was not applied) or
 * `BackendOutcomeUnknownError` (it may have been). This drives each through
 * `errorHandler` and reads the SERVED body field by field under both formats:
 * the fixed `detail` is served, the driver error stays the `cause` for the log
 * and none of its text reaches the client.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createTestApp } from '@setu-ts/testing';
import type { IKernelApplication } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import { toBackendFault } from '@setu-ts/common';

import { errorHandler } from '../../src/middleware/error-handler.ts';
import type { ErrorFormat } from '../../src/formatters/error-formatter.ts';

/** A driver error whose text must never be served. */
function driverError(message: string, code?: string): Error {
  const error = new Error(`${message} (key=secret-order-42)`);
  if (code !== undefined) Object.assign(error, { code });
  return error;
}

/** Measured driver shape → the status and fixed detail a client must read. */
const TABLE: ReadonlyArray<{
  readonly label: string;
  readonly thrown: () => Error;
  readonly status: number;
  readonly title: string;
  readonly detail: string;
}> = [
  {
    label: 'a refused connection',
    thrown: () => driverError('connect ECONNREFUSED 127.0.0.1:6379', 'ECONNREFUSED'),
    status: 503,
    title: 'Service Unavailable',
    detail: 'The request was not applied.',
  },
  {
    label: 'a command with no answer',
    thrown: () => new Error('Command timed out'),
    status: 504,
    title: 'Gateway Timeout',
    detail: 'The backend did not answer; the request may have been applied.',
  },
];

async function appThrowing(format: ErrorFormat, error: Error): Promise<IKernelApplication> {
  const app = await createTestApp({ plugins: [RuntimePlugin()], autoStart: false });
  app.middleware.add(errorHandler({ format, logErrors: false }), {
    priority: 0,
    name: 'error-handler',
  });
  app.router.get('/enqueue', () => {
    throw error;
  });
  await app.start();
  return app;
}

async function served(
  format: ErrorFormat,
  error: Error,
): Promise<{ readonly status: number; readonly type: string; readonly text: string }> {
  const app = await appThrowing(format, error);
  try {
    const response = await app.fetch(new Request('http://test.local/enqueue'));
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      text: await response.text(),
    };
  } finally {
    await app.stop();
  }
}

describe('backend faults are served as 503/504 (M131a X88-5)', () => {
  it.each(TABLE)('$label → $status under rfc9457', async ({ thrown, status, title, detail }) => {
    const fault = toBackendFault(thrown(), 'queue-plugin: redis adapter');
    expect(fault).toBeDefined();
    const response = await served('rfc9457', fault!);
    expect(response.status).toBe(status);
    expect(response.type).toContain('application/problem+json');
    const body = JSON.parse(response.text) as Record<string, unknown>;
    expect(body.status).toBe(status);
    expect(body.title).toBe(title);
    expect(body.detail).toBe(detail);
    // Problem Details carries `detail`, never `message`.
    expect(body).not.toHaveProperty('message');
    // Neither the driver's text nor the source label reaches the client.
    expect(response.text).not.toContain('secret-order-42');
    expect(response.text).not.toContain('Command timed out');
    expect(response.text).not.toContain('queue-plugin');
  });

  it.each(TABLE)('$label → $status under the default format', async ({ thrown, status, title }) => {
    const response = await served(
      'default',
      toBackendFault(thrown(), 'queue-plugin: redis adapter')!,
    );
    expect(response.status).toBe(status);
    const body = JSON.parse(response.text) as Record<string, unknown>;
    expect(body.message).toBe(title);
    expect(response.text).not.toContain('secret-order-42');
  });

  it('an unrecognised driver error is not classified and stays a masked 500', async () => {
    const thrown = driverError('WRONGTYPE Operation against a key holding the wrong kind of value');
    expect(toBackendFault(thrown, 'queue-plugin: redis adapter')).toBeUndefined();
    const response = await served('rfc9457', thrown);
    expect(response.status).toBe(500);
    expect(response.text).not.toContain('secret-order-42');
  });
});
