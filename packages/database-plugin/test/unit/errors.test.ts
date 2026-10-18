/**
 * Unit tests for {@linkcode UnsupportedQueryFeatureError}.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { UnknownPayloadFieldError, UnsupportedQueryFeatureError } from '../../src/errors.ts';

describe('UnknownPayloadFieldError diagnostic', () => {
  it('JSON-quotes control characters without a raw newline', () => {
    const error = new UnknownPayloadFieldError('User', 'field\nforged\r\t"\\');
    expect(error.message).toBe(
      'Entity \'User\' has no payload field "field\\nforged\\r\\t\\"\\\\".',
    );
    expect(error.message).not.toContain('\n');
    expect(error.message).not.toContain('\r');
  });

  it('truncates a 200-character field to 64 code units before JSON quoting', () => {
    const error = new UnknownPayloadFieldError('User', 'x'.repeat(200));
    expect(error.message).toBe(`Entity 'User' has no payload field "${'x'.repeat(64)}"….`);
    expect(error.message).not.toContain('x'.repeat(65));
    expect(new UnknownPayloadFieldError('User', 'x'.repeat(64)).message).toBe(
      `Entity 'User' has no payload field "${'x'.repeat(64)}".`,
    );
    expect(new UnknownPayloadFieldError('User', '😀'.repeat(33)).message).toBe(
      `Entity 'User' has no payload field "${'😀'.repeat(32)}"….`,
    );
  });
});

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
