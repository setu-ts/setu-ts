/**
 * How each settled rejection is recorded by the per-origin circuit breaker.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { classifyBreakerOutcome } from '../../src/circuit-breaker/classify.ts';
import { HttpClientError } from '../../src/errors.ts';

const httpError = (status: number): HttpClientError =>
  new HttpClientError(`HTTP ${status}`, status, new Headers(), null);

describe('classifyBreakerOutcome', () => {
  it.each([
    { name: 'a 503', error: httpError(503), outcome: 'failure' },
    { name: 'a 500', error: httpError(500), outcome: 'failure' },
    { name: 'a 499', error: httpError(499), outcome: 'success' },
    { name: 'a 404', error: httpError(404), outcome: 'success' },
    {
      name: 'a DOMException abort',
      error: new DOMException('aborted', 'AbortError'),
      outcome: 'ignore',
    },
    {
      name: 'a caller abort with a plain object',
      error: { name: 'AbortError' },
      outcome: 'ignore',
    },
    { name: 'a transport TypeError', error: new TypeError('fetch failed'), outcome: 'failure' },
    { name: 'a thrown string', error: 'boom', outcome: 'failure' },
    { name: 'null', error: null, outcome: 'failure' },
  ])('$name is a $outcome', ({ error, outcome }) => {
    expect(classifyBreakerOutcome(error)).toBe(outcome);
  });
});
