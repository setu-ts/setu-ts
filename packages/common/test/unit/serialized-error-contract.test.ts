/** Type-level compatibility contract for the additive SerializedError members. @module */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { SerializedError } from '../../src/index.ts';

describe('SerializedError compatibility contract', () => {
  it('allows a consumer to read the original name and message shape unchanged', () => {
    const error: SerializedError = { name: 'Error', message: 'transaction failed' };
    const legacyConsumer = (value: Pick<SerializedError, 'name' | 'message'>): string =>
      `${value.name}: ${value.message}`;

    expect(legacyConsumer(error)).toBe('Error: transaction failed');
  });
});
