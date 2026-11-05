/**
 * Tests for mask-errors.ts
 */

import { describe, expect, it } from 'vitest';
import { withHttpStatusHint } from '@setu-ts/common';
import {
  CALLER_ERROR_CODES,
  DEFAULT_CALLER_ERROR_CODE,
  isExposable,
  maskErrors,
} from '../../src/security/mask-errors.ts';

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

    it('applies formatError after masking (B7)', () => {
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

      const traceId = 'trace-123';
      const masked = maskErrors(result, {
        maskInternalErrors: true,
        logger: { error: () => {} },
        formatError: (e) => ({
          ...(e as { message: string; extensions?: { code?: string } }),
          traceId,
        }),
      });

      // B7: formatError is applied after masking
      expect(masked.errors?.[0].message).toBe('Internal server error');
      expect((masked.errors?.[0] as { traceId?: string }).traceId).toBe(traceId);
    });

    it('applies formatError to exposed errors (B7)', () => {
      const exposableError = new Error('Parse error') as Error & {
        message: string;
        originalError?: Error;
        extensions?: { code: string };
      };

      const result = {
        data: null,
        errors: [exposableError],
      };

      const masked = maskErrors(result, {
        maskInternalErrors: true,
        formatError: (e) => ({ ...(e as { message: string }), customField: 'custom' }),
      });

      // B7: formatError is applied to exposed errors too
      expect(masked.errors?.[0].message).toBe('Parse error');
      expect((masked.errors?.[0] as { customField?: string }).customField).toBe('custom');
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

/** A graphql-js located error wrapping what a resolver threw. */
function located(thrown: unknown, extensions?: Record<string, unknown>) {
  const error = new Error(thrown instanceof Error ? thrown.message : 'x') as Error & {
    originalError?: unknown;
    path?: Array<string | number>;
    locations?: Array<{ line: number; column: number }>;
    extensions?: Record<string, unknown>;
  };
  error.originalError = thrown;
  error.path = ['order'];
  error.locations = [{ line: 1, column: 3 }];
  if (extensions !== undefined) error.extensions = extensions;
  return error;
}

function hinted(status: number, detail: string): Error {
  return withHttpStatusHint(new Error('driver says: relation "orders" leaked'), {
    status,
    title: 'Caller Error',
    detail,
  });
}

describe('maskErrors — caller errors', () => {
  // The table is the contract: every listed status, plus one unlisted 4xx.
  const CASES: ReadonlyArray<[number, string]> = [
    ...Object.entries(CALLER_ERROR_CODES).map(([s, c]): [number, string] => [Number(s), c]),
    [410, DEFAULT_CALLER_ERROR_CODE],
  ];

  for (const [status, code] of CASES) {
    it(`shows a ${status} hint as ${code} with the hint's detail only`, () => {
      const logged: unknown[] = [];
      const masked = maskErrors(
        { data: { order: null }, errors: [located(hinted(status, 'No such order'))] },
        { maskInternalErrors: true, logger: { error: (m) => logged.push(m) } },
      );
      expect(masked.errors).toEqual([
        {
          message: 'No such order',
          extensions: { code },
          locations: [{ line: 1, column: 3 }],
          path: ['order'],
        },
      ]);
      expect(JSON.stringify(masked)).not.toContain('driver says');
      expect(logged).toEqual([]);
    });
  }

  it('keeps a 5xx hint masked and logged', () => {
    const logged: unknown[] = [];
    const masked = maskErrors(
      { errors: [located(hinted(503, 'Down for maintenance'))] },
      { maskInternalErrors: true, logger: { error: (m) => logged.push(m) } },
    );
    expect(masked.errors?.[0]).toEqual({
      message: 'Internal server error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
      path: ['order'],
    });
    expect(logged).toHaveLength(1);
  });

  // An explicit code is kept, but the message is still the hint's detail: the
  // error's own message is the operator diagnostic the hint keeps off the wire.
  it('keeps an explicit extensions.code but shows only the hint detail', () => {
    const masked = maskErrors(
      { errors: [located(hinted(404, 'No such order'), { code: 'ORDER_GONE', extra: 'x' })] },
      { maskInternalErrors: true },
    );
    expect(masked.errors?.[0]).toEqual({
      message: 'No such order',
      extensions: { code: 'ORDER_GONE' },
      locations: [{ line: 1, column: 3 }],
      path: ['order'],
    });
    expect(JSON.stringify(masked)).not.toContain('driver says');
  });

  it('ignores a non-string extensions.code and uses the table', () => {
    const masked = maskErrors(
      { errors: [located(hinted(403, 'Not your order'), { code: 42 })] },
      { maskInternalErrors: true },
    );
    expect(masked.errors?.[0]?.extensions).toEqual({ code: 'FORBIDDEN' });
  });

  it('masks URL userinfo in the served detail', () => {
    const masked = maskErrors(
      { errors: [located(hinted(400, 'Bad callback https://user:secret@hooks.example/x'))] },
      { maskInternalErrors: true },
    );
    expect(masked.errors?.[0]?.message).not.toContain('secret');
    expect(masked.errors?.[0]?.message).toContain('hooks.example/x');
  });

  it('maps a caller error with maskInternalErrors off too', () => {
    const masked = maskErrors(
      { errors: [located(hinted(403, 'Not your order'))] },
      { maskInternalErrors: false },
    );
    expect(masked.errors?.[0]).toMatchObject({
      message: 'Not your order',
      extensions: { code: 'FORBIDDEN' },
    });
  });

  it('hands the mapped error to formatError', () => {
    const seen: unknown[] = [];
    maskErrors(
      { errors: [located(hinted(404, 'No such order'))] },
      {
        maskInternalErrors: true,
        formatError: (e) => {
          seen.push(e);
          return e;
        },
      },
    );
    expect(seen).toEqual([
      expect.objectContaining({ message: 'No such order', extensions: { code: 'NOT_FOUND' } }),
    ]);
  });

  it('omits locations and path when graphql supplied none', () => {
    const error = new Error('x') as Error & { originalError?: unknown };
    error.originalError = hinted(404, 'No such order');
    const masked = maskErrors({ errors: [error] }, { maskInternalErrors: true });
    expect(masked.errors?.[0]).toEqual({
      message: 'No such order',
      extensions: { code: 'NOT_FOUND' },
    });
  });
});
