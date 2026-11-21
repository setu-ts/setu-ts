/**
 * The cloud secrets fault table (V13-217) and bound (V13-216): which
 * rejections are an outage (`503`), which name the provider, and the
 * reachability rule of the new probes (V13-215).
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { httpStatusHintOf } from '@setu-ts/common';
import { SecretProviderUnavailableError } from '../../src/errors.ts';
import {
  answered,
  answerOf,
  DEFAULT_SECRETS_REQUEST_TIMEOUT_MS,
  isSecretsOutage,
  resolveSecretsDeadline,
  runSecretsCall,
  SecretsDeadlineError,
  toSecretsError,
} from '../../src/providers/bounded-call.ts';

const shape = (fields: Record<string, unknown>): Error =>
  Object.assign(new Error('backend'), fields);

/** rejection, outage?, answered by the backend? */
const TABLE: readonly (readonly [string, unknown, boolean, boolean])[] = [
  ['expired bound', new SecretsDeadlineError('late'), true, false],
  ['connection refused', shape({ code: 'ECONNREFUSED' }), true, false],
  [
    'refused, as a cause',
    new Error('wrapped', { cause: shape({ code: 'ECONNREFUSED' }) }),
    true,
    false,
  ],
  ['AWS 503', shape({ $metadata: { httpStatusCode: 503 } }), true, false],
  ['AWS 500', shape({ $metadata: { httpStatusCode: 500 } }), true, false],
  ['AWS 400 (bad credential)', shape({ $metadata: { httpStatusCode: 400 } }), false, true],
  ['Azure 401', shape({ statusCode: 401 }), false, true],
  ['Azure 503', shape({ statusCode: 503 }), true, false],
  ['gRPC UNAVAILABLE (14)', shape({ code: 14 }), true, false],
  ['gRPC DEADLINE_EXCEEDED (4)', shape({ code: 4 }), true, false],
  ['gRPC PERMISSION_DENIED (7)', shape({ code: 7 }), false, true],
  ['gRPC NOT_FOUND (5)', shape({ code: 5 }), false, true],
  ['plain error', new Error('odd'), false, false],
  ['a string', 'odd', false, false],
];

describe('isSecretsOutage / toSecretsError (V13-217)', () => {
  for (const [name, error, outage] of TABLE) {
    it(`${name}: ${outage ? '503' : 'provider-named error'}`, () => {
      expect(isSecretsOutage(error)).toBe(outage);
      const thrown = toSecretsError(error, 'AwsKmsProvider', 'get');
      if (outage) {
        expect(thrown).toBeInstanceOf(SecretProviderUnavailableError);
        expect(httpStatusHintOf(thrown)?.status).toBe(503);
        expect((thrown as SecretProviderUnavailableError).provider).toBe('AwsKmsProvider');
      } else {
        expect(thrown.constructor).toBe(Error);
        expect(thrown.message.startsWith('AwsKmsProvider get failed: ')).toBe(true);
        expect(httpStatusHintOf(thrown)).toBeUndefined();
      }
      expect(thrown.cause).toBe(error);
    });
  }

  it('returns an already classified outage unchanged and cuts a long message', () => {
    const outage = new SecretProviderUnavailableError('X', new Error('down'));
    expect(toSecretsError(outage, 'Y', 'set')).toBe(outage);
    expect(toSecretsError(new Error('x'.repeat(900)), 'Y', 'set').message.length).toBeLessThan(400);
  });
});

describe('answerOf', () => {
  it('reads HTTP and gRPC answers, and nothing else', () => {
    expect(answerOf(shape({ $metadata: { httpStatusCode: 404 } }))).toEqual({
      kind: 'http',
      code: 404,
    });
    expect(answerOf(shape({ statusCode: 403 }))).toEqual({ kind: 'http', code: 403 });
    expect(answerOf(shape({ code: 7 }))).toEqual({ kind: 'grpc', code: 7 });
    expect(answerOf(shape({ code: 'ECONNREFUSED' }))).toBeUndefined();
    expect(answerOf(shape({ code: 404 }))).toBeUndefined();
    expect(answerOf(null)).toBeUndefined();
  });
});

describe('answered: the probes read reachability, not authorization (V13-215)', () => {
  for (const [name, error, , reached] of TABLE) {
    it(`${name} → ${reached}`, async () => {
      expect(await answered(() => Promise.reject(error))).toBe(reached);
    });
  }
  it('a resolved call is reachable', async () => {
    expect(await answered(() => Promise.resolve({}))).toBe(true);
  });
});

describe('resolveSecretsDeadline / runSecretsCall (V13-216)', () => {
  it('defaults to Vault’s 5 s and keeps the timer surface', () => {
    expect(DEFAULT_SECRETS_REQUEST_TIMEOUT_MS).toBe(5000);
    expect(resolveSecretsDeadline(undefined)).toEqual({ timeoutMs: 5000 });
    const timing = { setTimer: setTimeout, clearTimer: clearTimeout } as never;
    expect(resolveSecretsDeadline(0, timing)).toEqual({ timeoutMs: 0, timing });
  });

  for (const bad of [-1, Number.NaN, 2_147_483_648]) {
    it(`refuses ${bad}`, () => {
      expect(() => resolveSecretsDeadline(bad)).toThrow(/requestTimeoutMs/);
    });
  }

  it('expires with a SecretsDeadlineError naming the provider and aborts the signal', async () => {
    let seen: AbortSignal | undefined;
    const error = await runSecretsCall({ timeoutMs: 20 }, 'GcpSecretManagerProvider', (signal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretsDeadlineError);
    expect((error as Error).message).toBe('GcpSecretManagerProvider did not answer within 20 ms');
    expect(seen?.aborted).toBe(true);
  });
});

describe('a backend message cannot forge a log line', () => {
  it('control characters in the cause message are replaced', () => {
    expect(toSecretsError(new Error('no\nway'), 'X', 'get').message).toBe('X get failed: no way');
  });
});
