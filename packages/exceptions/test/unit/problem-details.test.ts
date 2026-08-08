/**
 * Unit tests for the shared Problem Details assembly.
 *
 * `buildProblemDetails` is internal — it is not exported from `src/index.ts` —
 * but it is the single implementation both public formatters funnel through, so
 * its branches are unit-tested here directly rather than only through them.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  ABOUT_BLANK,
  buildProblemDetails,
  ERROR_TYPE_BASE,
  VALIDATION_TYPE,
} from '../../src/formatters/problem-details.ts';
import { HttpError } from '../../src/errors/http-error.ts';
import { notFound, validationError } from '../../src/errors/exceptions.ts';
import { createFakeContext } from '../fixtures/fake-runtime.ts';

/** A resolver that records what the core passed it. */
function recordingResolver(): {
  calls: Array<{ statusCode: number; hasErrors: boolean }>;
  resolve: (statusCode: number, hasErrors: boolean) => string;
} {
  const calls: Array<{ statusCode: number; hasErrors: boolean }> = [];
  return {
    calls,
    resolve: (statusCode: number, hasErrors: boolean): string => {
      calls.push({ statusCode, hasErrors });
      return 'test:type';
    },
  };
}

describe('buildProblemDetails', () => {
  describe('the resolveType strategy seam', () => {
    it('delegates the type member to the supplied resolver', () => {
      const body = buildProblemDetails(notFound('gone'), undefined, () => 'urn:example:custom');
      expect(body.type).toBe('urn:example:custom');
    });

    it('passes the resolved status code and a false hasErrors flag', () => {
      const { calls, resolve } = recordingResolver();
      buildProblemDetails(notFound('gone'), undefined, resolve);
      expect(calls).toEqual([{ statusCode: 404, hasErrors: false }]);
    });

    it('passes hasErrors true when the error carries a validation extension', () => {
      const { calls, resolve } = recordingResolver();
      buildProblemDetails(validationError([{ field: 'a', message: 'b' }]), undefined, resolve);
      expect(calls).toEqual([{ statusCode: 422, hasErrors: true }]);
    });

    it('reports 500 to the resolver for a generic Error', () => {
      const { calls, resolve } = recordingResolver();
      buildProblemDetails(new Error('boom'), undefined, resolve);
      expect(calls).toEqual([{ statusCode: 500, hasErrors: false }]);
    });
  });

  describe('instance member', () => {
    it('is the request path when a context is supplied', () => {
      const { ctx } = createFakeContext({ request: { path: '/orders/7' } });
      const body = buildProblemDetails(notFound('gone'), ctx, () => ABOUT_BLANK);
      expect(body.instance).toBe('/orders/7');
    });

    it('is omitted, not empty, when no context is supplied', () => {
      const body = buildProblemDetails(notFound('gone'), undefined, () => ABOUT_BLANK);
      expect('instance' in body).toBe(false);
    });
  });

  describe('errors extension', () => {
    it('is copied from details.errors when present', () => {
      const error = validationError([{ field: 'email', message: 'bad' }]);
      const body = buildProblemDetails(error, undefined, () => VALIDATION_TYPE);
      expect(body.errors).toEqual([{ field: 'email', message: 'bad' }]);
    });

    it('is omitted when details exist but carry no errors key', () => {
      const error = new HttpError(429, 'slow down', { retryAfter: 30 });
      const body = buildProblemDetails(error, undefined, () => ABOUT_BLANK);
      expect('errors' in body).toBe(false);
    });

    it('is omitted when the error carries no details at all', () => {
      const body = buildProblemDetails(notFound('gone'), undefined, () => ABOUT_BLANK);
      expect('errors' in body).toBe(false);
    });

    it('is omitted for a generic Error, which has no details to read', () => {
      const body = buildProblemDetails(new Error('x'), undefined, () => ABOUT_BLANK);
      expect('errors' in body).toBe(false);
    });
  });

  describe('exported constants', () => {
    it('composes the validation type from the error type base', () => {
      expect(VALIDATION_TYPE).toBe(`${ERROR_TYPE_BASE}/validation`);
    });

    it('spells the RFC 9457 default type exactly', () => {
      expect(ABOUT_BLANK).toBe('about:blank');
    });

    it('agrees with the literal validation-plugin emits for the same problem type', () => {
      // The two packages cannot share a constant (AI_GUIDELINES §2.2), so the
      // agreement is pinned here and by the mirror assertion in
      // validation-plugin's formatter tests. A drift on either side makes one
      // problem type report under two URIs.
      expect(VALIDATION_TYPE).toBe('https://setu-ts.dev/errors/validation');
    });
  });
});
