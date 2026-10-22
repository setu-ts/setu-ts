import { expect, it } from 'vitest';
import { InvalidCursorError, httpStatusHintOf } from '../../src/index.ts';

it('brands an invalid cursor with a fixed caller-safe 400 detail', () => {
  const error = new InvalidCursorError("Entity 'User': malformed cursor token.");
  expect(error.name).toBe('InvalidCursorError');
  expect(error.message).toContain('malformed cursor');
  expect(httpStatusHintOf(error)).toEqual({
    status: 400,
    title: 'Bad Request',
    detail: 'The pagination cursor is not valid for this query.',
  });
});
