/**
 * The session stamp's digest and compare (M124 §3.3): what is recorded is a
 * SHA-256 digest, the compare is constant-time, and every failure answers "no
 * match" rather than falling back to the recorded value.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { IPrincipal } from '@setu-ts/common';
import { digestSessionStamp, sessionStampMatches } from '../../src/sign-in/session-stamp.ts';
import type { SessionStampCheck } from '../../src/sign-in/session-stamp.ts';

// `vi.mock` is hoisted above the imports, so the module under test sees the
// recording wrapper.

const compares = vi.hoisted(() => ({ calls: [] as [string, string][] }));
vi.mock('../../src/mfa/totp-codes.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mfa/totp-codes.ts')>();
  return {
    ...actual,
    constantTimeEquals: (a: string, b: string): boolean => {
      compares.calls.push([a, b]);
      return actual.constantTimeEquals(a, b);
    },
  };
});

const PRINCIPAL: IPrincipal = { id: 'u1' };
const digest = (value: string): string => createHash('sha256').update(value).digest('base64url');

function check(read: SessionStampCheck['read']): SessionStampCheck {
  return { read, subtle: crypto.subtle };
}

describe('digestSessionStamp', () => {
  it('digests a string, including the empty string and non-ASCII, as base64url SHA-256', async () => {
    for (const value of ['v1', '', '$2b$12$abcdefghijklmnopqrstuv', 'ünïcødé']) {
      expect(
        await digestSessionStamp(
          check(() => value),
          PRINCIPAL,
        ),
        value,
      ).toBe(digest(value));
    }
  });

  it('passes null through and awaits an async reader', async () => {
    expect(
      await digestSessionStamp(
        check(() => null),
        PRINCIPAL,
      ),
    ).toBeNull();
    expect(
      await digestSessionStamp(
        check(() => Promise.resolve('v2')),
        PRINCIPAL,
      ),
    ).toBe(digest('v2'));
  });

  it('refuses a value that is neither a string nor null, naming its type', async () => {
    const cases: readonly [unknown, string][] = [
      [undefined, 'undefined'],
      [7, 'number'],
      [{}, 'object'],
      [true, 'boolean'],
    ];
    for (const [value, type] of cases) {
      await expect(
        digestSessionStamp(
          check(() => value as string),
          PRINCIPAL,
        ),
        type,
      ).rejects.toThrow(`must return a string or null, got ${type}`);
    }
  });
});

describe('sessionStampMatches', () => {
  it('matches the same stamp through the constant-time compare', async () => {
    compares.calls.length = 0;
    expect(
      await sessionStampMatches(
        check(() => 'v1'),
        PRINCIPAL,
        digest('v1'),
      ),
    ).toBe(true);
    expect(
      await sessionStampMatches(
        check(() => 'v2'),
        PRINCIPAL,
        digest('v1'),
      ),
    ).toBe(false);
    expect(compares.calls).toEqual([
      [digest('v1'), digest('v1')],
      [digest('v2'), digest('v1')],
    ]);
  });

  it('matches two nulls, and never a null against a string', async () => {
    expect(
      await sessionStampMatches(
        check(() => null),
        PRINCIPAL,
        null,
      ),
    ).toBe(true);
    expect(
      await sessionStampMatches(
        check(() => null),
        PRINCIPAL,
        digest('v1'),
      ),
    ).toBe(false);
    expect(
      await sessionStampMatches(
        check(() => 'v1'),
        PRINCIPAL,
        null,
      ),
    ).toBe(false);
  });

  it('fails closed when the reader throws, rejects or returns a malformed value', async () => {
    const readers: SessionStampCheck['read'][] = [
      () => {
        throw new Error('store down');
      },
      () => Promise.reject(new Error('store down')),
      () => 7 as unknown as string,
    ];
    for (const read of readers) {
      expect(await sessionStampMatches(check(read), PRINCIPAL, digest('v1'))).toBe(false);
      expect(await sessionStampMatches(check(read), PRINCIPAL, null)).toBe(false);
    }
  });

  it('hands the reader the principal it was given', async () => {
    const seen: IPrincipal[] = [];
    await sessionStampMatches(
      check((principal) => {
        seen.push(principal);
        return null;
      }),
      PRINCIPAL,
      null,
    );
    expect(seen).toEqual([PRINCIPAL]);
  });
});
