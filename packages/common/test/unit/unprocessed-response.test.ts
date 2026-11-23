import { describe, expect, it } from 'vitest';
import { UNPROCESSED_HEADER, UNPROCESSED_SHUTDOWN } from '../../src/index.ts';

describe('unprocessed response contract', () => {
  it('exports the exact reserved lowercase name and shutdown value', () => {
    expect(UNPROCESSED_HEADER).toBe('x-setu-unprocessed');
    expect(UNPROCESSED_HEADER).toBe(UNPROCESSED_HEADER.toLowerCase());
    expect(UNPROCESSED_SHUTDOWN).toBe('shutdown');
  });
});
