import { describe, expect, it } from 'vitest';
import { normalizeResp3 } from '../../src/redis/resp3.ts';

describe('RESP3 reply normalization', () => {
  it.each([
    ['CONFIG', { policy: 'noeviction' }, ['policy', 'noeviction']],
    ['HGETALL', new Map([['a', 'b']]), ['a', 'b']],
    ['XINFO', [{ name: 'g', consumers: 1 }], [['name', 'g', 'consumers', 1]]],
    ['XINFO', [new Map([['name', 'g']])], [['name', 'g']]],
    ['XREADGROUP', { stream: [['1-0', ['a', 'b']]] }, [['stream', [['1-0', ['a', 'b']]]]]],
    ['xread', new Map([['s', [['1-0', ['a', 'b']]]]]), [['s', [['1-0', ['a', 'b']]]]]],
    ['CONFIG', { outer: { inner: 1 } }, ['outer', ['inner', 1]]],
    ['CONFIG', Object.assign(Object.create(null), { a: 'b' }), ['a', 'b']],
    ['GET', 'v', 'v'],
    ['INCR', 1, 1],
    ['GET', null, null],
    ['SCAN', ['0', ['a']], ['0', ['a']]],
    ['GET', undefined, undefined],
    ['GET', true, true],
    ['HGETALL', {}, []],
  ])('%s: %j → %j', (command, input, output) => {
    expect(normalizeResp3(input, command as string)).toEqual(output);
  });

  it('preserves buffers and other non-map objects', () => {
    const bytes = new Uint8Array([1, 2]);
    expect(normalizeResp3(bytes, 'GET')).toBe(bytes);
  });
});
