import { describe, expect, it } from 'vitest';
import { CONNECTION_FAULT_CODES, isConnectionFault } from '../../src/index.ts';

describe('isConnectionFault', () => {
  it.each([...CONNECTION_FAULT_CODES])('recognises code and errno %s', (code) => {
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
