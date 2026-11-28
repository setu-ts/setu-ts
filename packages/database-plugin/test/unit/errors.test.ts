/**
 * Unit tests for {@linkcode UnsupportedQueryFeatureError}.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { UnknownPayloadFieldError, UnsupportedQueryFeatureError } from '../../src/errors.ts';
import {
  DatabaseTimeoutError,
  DatabaseUnavailableError,
  ForeignKeyViolationError,
  NotNullViolationError,
  SerializationConflictError,
} from '../../src/errors.ts';
import { httpStatusHintOf } from '@setu-ts/common';
import { errorProblems } from '../fixtures/error-problems.ts';

describe('database condition errors', () => {
  for (const [error, status, title, slug, problemTitle, detail] of errorProblems) {
    it(`${slug} has only the documented hint fields`, () => {
      expect(httpStatusHintOf(error)).toEqual({
        status,
        title,
        detail,
        problem: {
          type: `https://setu-ts.dev/errors/${slug}`,
          title: problemTitle,
        },
      });
      expect(httpStatusHintOf(error)).not.toHaveProperty('message');
    });
  }
  it('retains causes, entities and each explicit/default reason', () => {
    const cause = new Error('driver');
    for (const ErrorClass of [ForeignKeyViolationError, NotNullViolationError]) {
      const error = new ErrorClass('diagnostic', { entity: 'Account', cause });
      expect(error.entity).toBe('Account');
      expect(error.cause).toBe(cause);
      expect(error.message).toBe('diagnostic');
      expect(new ErrorClass('diagnostic').entity).toBeUndefined();
    }
    for (const reason of ['write-conflict', 'lock-timeout'] as const) {
      expect(new SerializationConflictError('diagnostic', { cause, reason }).reason).toBe(reason);
    }
    for (const reason of ['unreachable', 'pool-saturated'] as const) {
      expect(new DatabaseUnavailableError('diagnostic', { cause, reason }).reason).toBe(reason);
    }
    for (const reason of ['bound', 'connection-lost'] as const) {
      expect(new DatabaseTimeoutError('diagnostic', { cause, reason }).reason).toBe(reason);
    }
    expect(new SerializationConflictError('diagnostic').reason).toBe('write-conflict');
    expect(new DatabaseUnavailableError('diagnostic').reason).toBe('unreachable');
    expect(new DatabaseTimeoutError('diagnostic').reason).toBe('bound');
  });
});

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
