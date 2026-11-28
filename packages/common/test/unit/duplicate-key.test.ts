import { describe, expect, it } from 'vitest';
import { DuplicateKeyError, httpStatusHintOf } from '../../src/index.ts';

describe('DuplicateKeyError', () => {
  it('keeps its diagnostic and entity private and carries the duplicate-key identity', () => {
    const cause = new Error('private-driver');
    for (const options of [undefined, { entity: 'private-entity', cause }, { cause: undefined }]) {
      const error = new DuplicateKeyError('private-message', options);
      expect(error.name).toBe('DuplicateKeyError');
      expect(error.message).toBe('private-message');
      expect(error.entity).toBe(options?.entity);
      expect(error.cause).toBe(options?.cause);
      expect(httpStatusHintOf(error)).toEqual({
        status: 409,
        title: 'Conflict',
        detail:
          'A record with the same unique key already exists. The conflicting write was rejected.',
        problem: { type: 'https://setu-ts.dev/errors/duplicate-key', title: 'Duplicate Key' },
      });
      expect(httpStatusHintOf(error)).not.toHaveProperty('message');
    }
  });
});
