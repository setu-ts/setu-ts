import { describe, expect, it } from 'vitest';
import { httpStatusHintOf, StorageObjectNotFoundError } from '../../src/index.ts';

describe('StorageObjectNotFoundError', () => {
  it('names the key for the log and answers a fixed 404 that never quotes it', () => {
    const error = new StorageObjectNotFoundError('users/42/secret-report.pdf');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StorageObjectNotFoundError');
    expect(error.key).toBe('users/42/secret-report.pdf');
    expect(error.message).toBe('Storage object not found: users/42/secret-report.pdf');
    const hint = httpStatusHintOf(error);
    expect(hint).toEqual({
      status: 404,
      title: 'Not Found',
      detail: 'The requested object was not found.',
    });
    expect(hint?.detail).not.toContain('users/42');
  });
});
