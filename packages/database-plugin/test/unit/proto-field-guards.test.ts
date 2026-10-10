/**
 * Cosmos DB and DynamoDB refuse an own `__proto__` payload field and never let
 * a stored one inject a prototype or crash a read.
 *
 * Deno deletes `Object.prototype.__proto__`, so a plain assignment of that key
 * creates an own property there while Node and Bun replace the target's
 * prototype instead. `withNodeProtoSemantics` reinstalls Node's accessor for
 * the duration of a case, which is what makes these tests fail on Deno when a
 * read path assigns instead of defining.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { sources } from '../fixtures/conditional-sources.ts';
import { fromDocument, resolveCosmosTarget } from '../../src/adapters/cosmos/cosmos-mapping.ts';
import {
  marshalDynamoItem,
  unmarshalDynamoItem,
} from '../../src/adapters/dynamo/dynamo-marshal.ts';
import type { DynamoAttributeMap } from '../../src/adapters/dynamo/dynamo-client-types.ts';

/** Runs `fn` with Node's `Object.prototype.__proto__` accessor installed. */
async function withNodeProtoSemantics<T>(fn: () => Promise<T> | T): Promise<T> {
  const existing = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__');
  Object.defineProperty(Object.prototype, '__proto__', {
    configurable: true,
    get(this: object) {
      return Object.getPrototypeOf(this);
    },
    set(this: object, value: unknown) {
      if (typeof value === 'object' || value === null) Object.setPrototypeOf(this, value);
    },
  });
  try {
    return await fn();
  } finally {
    if (existing === undefined) {
      delete (Object.prototype as Record<string, unknown>)['__proto__'];
    } else {
      Object.defineProperty(Object.prototype, '__proto__', existing);
    }
  }
}

/** A JSON-borne payload carrying an own `__proto__` field. */
const protoPayload = (): Record<string, unknown> =>
  JSON.parse('{"name":"x","__proto__":{"isAdmin":"canary-admin"}}');

/** Settles `attempt`, reporting a synchronous throw separately from a rejection. */
async function settle(
  attempt: () => Promise<unknown>,
): Promise<{ sync: boolean; message: string | undefined }> {
  let pending: Promise<unknown>;
  try {
    pending = attempt();
  } catch (error) {
    return { sync: true, message: (error as Error).message };
  }
  return await pending.then(
    () => ({ sync: false, message: undefined }),
    (error: unknown) => ({ sync: false, message: (error as Error).message }),
  );
}

describe('Cosmos DB and DynamoDB __proto__ payload fields (M105)', () => {
  it('the node-semantics helper really does replace a prototype on assignment', async () => {
    // Guards the guard: if the helper stopped reproducing Node, every case
    // below would pass on Deno whether or not the code defines its keys.
    await withNodeProtoSemantics(() => {
      const target: Record<string, unknown> = {};
      target['__proto__'] = { injected: true };
      expect((target as { injected?: unknown }).injected).toBe(true);
    });
  });

  for (const name of ['cosmos', 'dynamodb']) {
    it(`${name}: create and update refuse an own __proto__ field without an echo`, async () => {
      const source = sources.find((entry) => entry.name === name)!.make();
      await source.create({ id: 'a', name: 'old' });
      for (
        const attempt of [
          () => source.create({ ...protoPayload(), id: 'b' }),
          () => source.update('a', protoPayload()),
        ]
      ) {
        const outcome = await settle(attempt);
        expect(outcome.sync).toBe(false);
        expect(outcome.message).toMatch(/__proto__/);
        expect(outcome.message).not.toContain('canary');
      }
      expect(await source.findById('a')).toMatchObject({ name: 'old' });
      expect(await source.findById('b')).toBeNull();
    });
  }

  it('cosmos: a stored __proto__ field reads back as data, never as a prototype', async () => {
    await withNodeProtoSemantics(() => {
      const document = JSON.parse(
        '{"id":"a","name":"foreign","__proto__":{"isAdmin":"canary-admin"},"_etag":"e"}',
      ) as Record<string, unknown>;
      const row = fromDocument(document, resolveCosmosTarget('Row', undefined));
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect((row as { isAdmin?: unknown }).isAdmin).toBeUndefined();
      expect(Object.keys(row)).toEqual(['id', 'name', '__proto__']);
    });
  });

  it('dynamodb: refuses a __proto__ attribute at any depth on the write path', () => {
    expect(() => marshalDynamoItem(protoPayload())).toThrow(/__proto__/);
    expect(() => marshalDynamoItem({ meta: JSON.parse('{"__proto__":{"x":1}}') })).toThrow(
      /__proto__/,
    );
    expect(marshalDynamoItem({ constructor: 'ok' })).toEqual({ constructor: { S: 'ok' } });
  });

  it('dynamodb: skips a stored __proto__ attribute, which the SDK returns without a value', async () => {
    await withNodeProtoSemantics(() => {
      // The shape the AWS SDK hands back for a `__proto__` attribute: the key
      // is present and its value is undefined (measured on DynamoDB Local).
      const item: Record<string, unknown> = { name: { S: 'foreign' } };
      Object.defineProperty(item, '__proto__', {
        value: undefined,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const row = unmarshalDynamoItem(item as DynamoAttributeMap);
      expect(row).toEqual({ name: 'foreign' });
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      // One that arrives WITH a value stays an own property, never a prototype.
      const valued = unmarshalDynamoItem(
        JSON.parse('{"__proto__":{"M":{"isAdmin":{"S":"canary"}}}}') as DynamoAttributeMap,
      );
      expect(Object.getPrototypeOf(valued)).toBe(Object.prototype);
      expect((valued as { isAdmin?: unknown }).isAdmin).toBeUndefined();
      expect(Object.keys(valued)).toEqual(['__proto__']);
    });
  });
});
