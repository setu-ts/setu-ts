import { describe, expect, it } from 'vitest';
import { isConnectionFault, isConnectionFaultCode } from '../../src/index.ts';

const CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
];

describe('isConnectionFaultCode', () => {
  it.each(CODES)('recognises %s', (code) => {
    expect(isConnectionFaultCode(code)).toBe(true);
  });

  it.each([null, undefined, 42, false, {}, ['ECONNREFUSED'], 'UNKNOWN', 'econnrefused'])(
    'refuses non-strings and unknown codes: %s',
    (code) => {
      expect(isConnectionFaultCode(code)).toBe(false);
    },
  );
});

describe('isConnectionFault', () => {
  it.each([
    'The client is closed',
    'The client is offline',
    'Socket closed unexpectedly',
    'Connection timeout',
    "Socket timeout timeout. Expecting data, but didn't receive any in 300ms.",
    "Socket timeout timeout. Expecting data, but didn't receive any in 1700ms.",
  ])('recognises measured node-redis outage: %s', (message) => {
    expect(isConnectionFault(new Error(message))).toBe(true);
    expect(isConnectionFault(new Error('wrapper', { cause: new Error(message) }))).toBe(true);
    expect(isConnectionFault(Object.assign(new Error(message), { name: 'SimpleError' }))).toBe(
      false,
    );
  });

  it.each([
    'prefix The client is closed',
    "Socket timeout timeout. Expecting data, but didn't receive any in 300ms.x",
    "Socket timeout timeout. Expecting data, but didn't receive any in -1ms.",
    "Socket timeout timeout. Expecting data, but didn't receive any in 1.5ms.",
    'WRONGTYPE Operation against a key holding the wrong kind of value',
  ])('refuses near-miss node-redis messages: %s', (message) => {
    expect(isConnectionFault(new Error(message))).toBe(false);
  });
  it.each(CODES)('recognises code and errno %s', (code) => {
    expect(isConnectionFault({ code })).toBe(true);
    expect(isConnectionFault({ errno: code })).toBe(true);
    expect(isConnectionFault(new Error('wrapper', { cause: { code } }))).toBe(true);
  });

  it.each([
    ['Error', 'Command timed out'],
    [
      'MaxRetriesPerRequestError',
      'Reached the max retries per request limit (which is 1). Refer to "maxRetriesPerRequest" option for details.',
    ],
    ['Error', 'Connection is closed.'],
    ['Error', "Stream isn't writeable and enableOfflineQueue options is false"],
  ])('recognises measured ioredis rejection %s / %s', (name, message) => {
    expect(isConnectionFault(Object.freeze(Object.assign(new Error(message), { name })))).toBe(
      true,
    );
  });

  it.each([
    null,
    undefined,
    3,
    'ECONNREFUSED',
    false,
    {},
    { code: 42, errno: 3 },
    new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
    new TypeError('Command timed out'),
    new Error('prefix Command timed out'),
  ])('does not classify unrelated values: %s', (value) => {
    expect(isConnectionFault(value)).toBe(false);
  });

  it('bounds cycles and long cause chains', () => {
    const a: { cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect(isConnectionFault(a)).toBe(false);
    let chain: unknown = { code: 'EPIPE' };
    for (let i = 0; i < 5; i++) chain = { cause: chain };
    expect(isConnectionFault(chain)).toBe(false);
  });

  it('contains throwing accessors', () => {
    const hostile = Object.defineProperty({}, 'code', {
      get: () => {
        throw new Error('getter');
      },
    });
    expect(isConnectionFault(hostile)).toBe(false);
  });
});
