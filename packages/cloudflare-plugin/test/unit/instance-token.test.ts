import { WorkersResponse } from '../../../../test/node-helpers.ts';
import { afterAll, beforeAll } from 'vitest';
const nativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = WorkersResponse;
});
afterAll(() => {
  globalThis.Response = nativeResponse;
});
/**
 * One derivation, two consumers.
 *
 * The plugin derives the token it REGISTERS under and `createQueueHandler`
 * derives the token it RESOLVES. They used to be separate copies; a drift of
 * one character would have left the handler looking up a token nothing
 * registered, surfacing as a queue whose messages are never dispatched rather
 * than as a startup error.
 */

import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';

import { instanceToken } from '../../src/instance-token.ts';

describe('instanceToken', () => {
  it('claims the bare token for an omitted name', () => {
    expect(instanceToken(CAPABILITIES.QUEUE, undefined)).toBe(CAPABILITIES.QUEUE);
  });

  it("claims the bare token for an explicit 'default'", () => {
    expect(instanceToken(CAPABILITIES.CACHE, 'default')).toBe(CAPABILITIES.CACHE);
  });

  it('derives a dot-namespaced token for any other name', () => {
    expect(instanceToken(CAPABILITIES.QUEUE, 'reports')).toBe('queue.reports');
    expect(instanceToken(CAPABILITIES.CACHE, 'edge')).toBe('cache.edge');
    expect(instanceToken(CAPABILITIES.STORAGE, 'user-uploads')).toBe('storage.user-uploads');
  });

  it('rejects a name that would violate the committed token grammar', () => {
    // `createCapabilityToken` owns the grammar — lowercase kebab-case with dot
    // namespacing, colons illegal. Deriving through it is what makes a bad
    // instance name a startup error instead of an unresolvable token.
    expect(() => instanceToken(CAPABILITIES.QUEUE, 'Reports')).toThrow();
    expect(() => instanceToken(CAPABILITIES.QUEUE, 'a:b')).toThrow();
    expect(() => instanceToken(CAPABILITIES.QUEUE, '')).toThrow();
  });
});
