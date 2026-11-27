import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import type { ErrorFormat } from '@setu-ts/exceptions';
import { httpStatusHintOf, withHttpStatusHint } from '@setu-ts/common';
import { SerializationConflictError, VersionConflictError } from '../../src/index.ts';

async function response(error: Error, format: ErrorFormat): Promise<string | null> {
  const app = createApplication({ plugins: [RuntimePlugin()] });
  app.middleware.add(errorHandler({ format, logErrors: false }));
  app.router.get('/write', () => {
    throw error;
  });
  await app.start();
  try {
    return (await app.inject({ method: 'GET', url: '/write' })).body;
  } finally {
    await app.stop();
  }
}

describe('database problem types through errorHandler', () => {
  it('distinguishes reload from retry under rfc9457', async () => {
    for (const [error, slug, title, detail] of [
      [
        new VersionConflictError('private'),
        'version-conflict',
        'Version Conflict',
        'The record was changed after it was read. Reload it and try again.',
      ],
      [
        new SerializationConflictError('private'),
        'write-conflict',
        'Write Conflict',
        'The write conflicted with a concurrent transaction and was rolled back. It is safe to retry.',
      ],
    ] as const) {
      const body = await response(error, 'rfc9457');
      expect(typeof body).toBe('string');
      expect(JSON.parse(String(body))).toEqual({
        type: `https://setu-ts.dev/errors/${slug}`,
        title,
        status: 409,
        detail,
        instance: '/write',
      });
      expect(body).not.toContain('private');
    }
  });
  it('keeps default bodies byte-identical with and without problem', async () => {
    const error = new SerializationConflictError('private');
    const hint = httpStatusHintOf(error)!;
    const without = withHttpStatusHint(new Error('private'), {
      status: hint.status,
      title: hint.title,
      detail: hint.detail,
    });
    expect(await response(error, 'default')).toBe(await response(without, 'default'));
  });
});
