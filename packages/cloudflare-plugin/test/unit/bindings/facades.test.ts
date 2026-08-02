/**
 * The facades are hand-written rather than imported from
 * `@cloudflare/workers-types`, so their assignability against a real-shaped
 * binding is asserted here rather than assumed, along with the shape guards
 * the plugin validates configured bindings with.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IKvNamespace, IR2Bucket } from '../../../src/index.ts';
import { isKvNamespace, isR2Bucket } from '../../../src/index.ts';
import { FakeKv, FakeR2 } from '../../fakes.ts';

describe('binding facades', () => {
  it('accepts a full KV-shaped object as an IKvNamespace', () => {
    // A compile-time assertion: the fake declares `implements IKvNamespace`,
    // and this widening pins that a structurally-complete object satisfies it
    // without a cast, which is what a real KVNamespace does.
    const namespace: IKvNamespace = new FakeKv();
    expect(typeof namespace.get).toBe('function');
  });

  it('accepts a full R2-shaped object as an IR2Bucket', () => {
    const bucket: IR2Bucket = new FakeR2();
    expect(typeof bucket.head).toBe('function');
  });
});

describe('isKvNamespace', () => {
  it('accepts a KV-shaped binding', () => {
    expect(isKvNamespace(new FakeKv())).toBe(true);
  });

  it('rejects a binding missing any KV method', () => {
    expect(isKvNamespace({ get: () => {}, put: () => {}, delete: () => {} })).toBe(false);
    expect(isKvNamespace({ get: () => {}, put: () => {}, list: () => {} })).toBe(false);
  });

  it('rejects an R2 bucket handed to a KV option by mistake', () => {
    expect(isKvNamespace(new FakeR2())).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isKvNamespace(null)).toBe(false);
    expect(isKvNamespace(undefined)).toBe(false);
    expect(isKvNamespace('a string binding')).toBe(false);
    expect(isKvNamespace(42)).toBe(false);
  });
});

describe('isR2Bucket', () => {
  it('accepts an R2-shaped binding', () => {
    expect(isR2Bucket(new FakeR2())).toBe(true);
  });

  it('rejects a KV namespace handed to an R2 option by mistake', () => {
    // KV has get/put/delete but no head, which is the distinguishing member.
    expect(isR2Bucket(new FakeKv())).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isR2Bucket(null)).toBe(false);
    expect(isR2Bucket({ head: 'not a function' })).toBe(false);
  });
});
