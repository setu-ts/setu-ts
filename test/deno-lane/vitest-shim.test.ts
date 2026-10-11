import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  afterAll,
  beforeAll,
  it as shimIt,
  test,
  translate,
  translateTest,
} from './vitest-shim.ts';

describe('Vitest-shaped Deno registration', () => {
  it('preserves the callback in both supported forms', () => {
    const fn = () => {};
    expect(translate('plain', fn)).toEqual({ name: 'plain', fn });
    expect(translate('guard', { skip: true }, fn)).toEqual({ name: 'guard', ignore: true, fn });
    expect(translate('active', { skip: false, timeout: 10 }, fn)).toEqual({
      name: 'active',
      ignore: false,
      fn,
    });
    expect(() => translate('missing', {})).toThrow('callback');
  });
});

describe('deadline enforcement and actual registration', () => {
  let started = false;
  let ran = 0;
  beforeAll(() => {
    started = true;
  });
  afterAll(() => {
    expect(ran).toBe(3);
  });
  shimIt('runs options-first callbacks', { skip: false, timeout: 100 }, () => {
    expect(started).toBe(true);
    ran++;
  });
  shimIt.skip('does not execute a skipped callback', () => {
    throw new Error('skipped');
  });
  shimIt.skipIf(true)('does not execute a guarded callback', () => {
    throw new Error('guarded');
  });
  shimIt.skipIf(false)('executes the positive guard', () => {
    ran++;
  });
  test('registers the test alias', () => {
    ran++;
  });
  it('enforces deadlines and preserves callback errors', async () => {
    await expect(translateTest('hung', { timeout: 1 }, () => new Promise(() => {})).fn()).rejects
      .toThrow('timed out');
    const failure = new Error('callback failure');
    await expect(
      translateTest('failed', { timeout: 100 }, () => {
        throw failure;
      }).fn(),
    ).rejects.toBe(failure);
    expect(() => translateTest('invalid', { timeout: 0 }, () => {})).toThrow(RangeError);
  });
});
