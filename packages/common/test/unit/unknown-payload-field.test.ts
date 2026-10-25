import { describe, expect, it } from 'vitest';
import { UnknownPayloadFieldError, httpStatusHintOf } from '../../src/index.ts';

describe('UnknownPayloadFieldError', () => {
  it('preserves the field diagnostic', () => {
    expect(new UnknownPayloadFieldError('User', 'secret').message).toBe(
      'Entity \'User\' has no payload field "secret".',
    );
  });
  it('carries a fixed 400 detail, with no field or value in the hint', () => {
    const error = new UnknownPayloadFieldError('User', 'secret\n' + 'x'.repeat(80));
    expect(error.name).toBe('UnknownPayloadFieldError');
    expect(httpStatusHintOf(error)).toEqual({
      status: 400,
      title: 'Bad Request',
      detail: 'The request names a field this resource does not have.',
    });
    expect(error.message).toContain("Entity 'User'");
    expect(error.message).not.toContain('\n');
    expect(error.message).not.toContain('x'.repeat(80));
  });
});

it('bounds and renders names supplied by JavaScript callers', () => {
  for (const field of [null, 7, undefined, {}, 'short', 'x'.repeat(65)]) {
    const error = new UnknownPayloadFieldError('User', field as string);
    expect(error.message.length).toBeLessThan(120);
  }
});
