import { describe, expect, it } from 'vitest';
import { InvalidFieldValueError, httpStatusHintOf } from '../../src/index.ts';

describe('InvalidFieldValueError', () => {
  it('carries a fixed 400 detail, with no field or value in the hint', () => {
    const error = new InvalidFieldValueError('User');
    expect(error.name).toBe('InvalidFieldValueError');
    expect(httpStatusHintOf(error)).toEqual({
      status: 400,
      title: 'Bad Request',
      detail: 'A supplied value does not fit the type of its field.',
    });
    expect(error.message).toBe(
      "Entity 'User': the database refused a supplied value for its field type.",
    );
    expect(error.message).not.toContain('\n');
    expect(error.message).not.toContain('x'.repeat(80));
  });
});
