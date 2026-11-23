import { describe, expect, it } from 'vitest';
import { combineAddressFamilies } from '../../src/adapters/shared/address-families.ts';

const aError = Object.assign(new Error('missing'), { code: 'ENOTFOUND' });
const aaaaError = Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
const a: PromiseSettledResult<string[]> = { status: 'fulfilled', value: ['10.0.0.1'] };
const aaaa: PromiseSettledResult<string[]> = { status: 'fulfilled', value: ['::1'] };
const failedA: PromiseSettledResult<string[]> = { status: 'rejected', reason: aError };
const failedAAAA: PromiseSettledResult<string[]> = { status: 'rejected', reason: aaaaError };

describe('combineAddressFamilies', () => {
  it.each([
    { results: [a, aaaa], addresses: ['10.0.0.1', '::1'] },
    { results: [a, failedAAAA], addresses: ['10.0.0.1'] },
    { results: [failedA, aaaa], addresses: ['::1'] },
    {
      results: [
        { status: 'fulfilled', value: [] },
        { status: 'fulfilled', value: [] },
      ],
      addresses: [],
    },
  ] satisfies { results: PromiseSettledResult<string[]>[]; addresses: string[] }[])(
    'combines $addresses',
    ({ results, addresses }) => {
      expect(combineAddressFamilies(results, 'svc')).toEqual(addresses);
    },
  );
  it('keeps every failure in A-then-AAAA order', () => {
    expect(() => combineAddressFamilies([failedA, failedAAAA], 'svc')).toThrow(
      'DNS lookup failed for svc',
    );
    try {
      combineAddressFamilies([failedA, failedAAAA], 'svc');
      expect.fail('both families must fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const cause = (error as Error).cause;
      expect(cause).toBeInstanceOf(AggregateError);
      expect((cause as AggregateError).message).toBe('Every address lookup failed for svc');
      expect((cause as AggregateError).errors).toEqual([aError, aaaaError]);
    }
  });
});
