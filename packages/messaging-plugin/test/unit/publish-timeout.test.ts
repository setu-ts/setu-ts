import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUBLISH_TIMEOUT_MS,
  resolvePublishTimeoutMs,
} from '../../src/brokers/publish-timeout.ts';

describe('publish timeout policy', () => {
  it('defaults to 15 seconds and accepts zero and the timer ceiling', () => {
    expect(DEFAULT_PUBLISH_TIMEOUT_MS).toBe(15000);
    expect(resolvePublishTimeoutMs(undefined)).toBe(15000);
    for (const value of [0, 25, 2147483647]) expect(resolvePublishTimeoutMs(value)).toBe(value);
  });
  it.each([-1, NaN, Infinity, 2147483648])('refuses %s naming publishTimeoutMs', (value) => {
    expect(() => resolvePublishTimeoutMs(value)).toThrow(RangeError);
    expect(() => resolvePublishTimeoutMs(value)).toThrow('publishTimeoutMs');
  });
});
