/**
 * Tests for mask-errors.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { isExposable, maskErrors } from '../../src/security/mask-errors.ts';

describe('mask-errors', () => {
  describe('isExposable', () => {
    it('returns true for error without originalError', () => {
      const error = new Error('Parse error');
      expect(isExposable(error)).toBe(true);
    });

    it('returns true for error with code in extensions', () => {
      const error = new Error('Coded error') as Error & { extensions?: { code: string } };
      error.extensions = { code: 'BAD_USER_INPUT' };
      expect(isExposable(error)).toBe(true);
    });

    it('returns false for error with originalError and no code', () => {
      const error = new Error('Internal error') as Error & {
        originalError?: Error;
        extensions?: { code: string };
      };
      error.originalError = new Error('Cause');
      error.extensions = {} as { code: string };
      expect(isExposable(error)).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isExposable(null)).toBe(false);
      expect(isExposable(undefined)).toBe(false);
    });
  });

  describe('maskErrors', () => {
    it('returns result unchanged if no errors', () => {
      const result = { data: { hello: 'world' } };
      const masked = maskErrors(result, { maskInternalErrors: true });
      expect(masked).toEqual(result);
    });

    it('masks internal errors when enabled', () => {
      const internalError = new Error('Internal') as Error & {
        message: string;
        originalError?: Error;
        extensions?: { code: string };
        path?: Array<string | number>;
      };
      internalError.originalError = new Error('Cause');
      internalError.extensions = {} as { code: string };

      const result = {
        data: null,
        errors: [internalError],
      };

      const masked = maskErrors(result, {
        maskInternalErrors: true,
        logger: { error: () => {} },
      });

      expect(masked.errors?.[0].message).toBe('Internal server error');
      expect(masked.errors?.[0].extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('exposes exposable errors', () => {
      const exposableError = new Error('Parse error') as Error & {
        message: string;
        originalError?: Error;
        extensions?: { code: string };
        path?: Array<string | number>;
      };
      // No originalError = exposable

      const result = {
        data: null,
        errors: [exposableError],
      };

      const masked = maskErrors(result, { maskInternalErrors: true });

      expect(masked.errors?.[0].message).toBe('Parse error');
    });

    it('formatError is deprecated (no longer applied)', () => {
      // Note: formatError option is deprecated - errors are no longer formatted
      // This test documents that formatError is ignored
      const error = new Error('Internal') as Error & {
        message: string;
        originalError?: Error;
        extensions?: { code: string };
      };
      error.originalError = new Error('Cause');
      error.extensions = {} as { code: string };

      const result = {
        data: null,
        errors: [error],
      };

      const masked = maskErrors(result, {
        maskInternalErrors: true,
        logger: { error: () => {} },
        formatError: (_e: unknown) => ({ customField: 'added' }),
      });

      // formatError is ignored - masked error should be the standard format
      expect(masked.errors?.[0].message).toBe('Internal server error');
      expect((masked.errors?.[0] as { customField?: string }).customField).toBeUndefined();
    });

    it('does not mask when disabled', () => {
      const error = new Error('Internal') as Error & {
        message: string;
        originalError?: Error;
        extensions?: { code: string };
      };
      error.originalError = new Error('Cause');
      error.extensions = {} as { code: string };

      const result = {
        data: null,
        errors: [error],
      };

      const masked = maskErrors(result, { maskInternalErrors: false });

      expect(masked.errors?.[0].message).toBe('Internal');
    });
  });
});
