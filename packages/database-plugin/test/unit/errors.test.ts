/**
 * Unit tests for {@linkcode UnsupportedQueryFeatureError}.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';

describe('UnsupportedQueryFeatureError', () => {
  it('carries the feature, adapter and name', () => {
    const err = new UnsupportedQueryFeatureError(
      'composite-key',
      'drizzle',
      'composite keys are not supported by the drizzle adapter',
    );
    expect(err.feature).toBe('composite-key');
    expect(err.adapter).toBe('drizzle');
    expect(err.name).toBe('UnsupportedQueryFeatureError');
  });

  it('survives instanceof', () => {
    const err = new UnsupportedQueryFeatureError('cursor', 'memory', 'cursor paging unavailable');
    expect(err).toBeInstanceOf(UnsupportedQueryFeatureError);
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves the message', () => {
    const msg = 'composite keys are not supported by the drizzle adapter';
    const err = new UnsupportedQueryFeatureError('composite-key', 'drizzle', msg);
    expect(err.message).toBe(msg);
  });
});
