/**
 * Coverage for the per-entity DynamoDB key mapping and its resolution into
 * the internal build target (`dynamo-mapping.ts`).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as dynamoMapping from '../../src/adapters/dynamo/dynamo-mapping.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';

const { resolveDynamoTarget } = dynamoMapping;

describe('resolveDynamoTarget — defaults', () => {
  it('an unmapped entity uses its own name as the table and the default partition key', () => {
    const target = resolveDynamoTarget('Widget', undefined);
    expect(target).toStrictEqual({
      table: 'Widget',
      partitionKey: 'id',
      keyColumns: ['id'],
      indexes: {},
      dateAttributes: {},
    });
  });

  it('a mapping record that does not name the entity still resolves the defaults', () => {
    const target = resolveDynamoTarget('Widget', { User: { partitionKey: 'userId' } });
    expect(target.table).toBe('Widget');
    expect(target.partitionKey).toBe('id');
    expect(target.keyColumns).toEqual(['id']);
  });

  it('a mapped entity without overrides still gets the partition-key default absent', () => {
    // A MAPPED entity states its partition key explicitly — DynamoDB has no
    // implicit key to guess — so this case only exists for the type checker;
    // at runtime an entry like this resolves exactly what it declares.
    const target = resolveDynamoTarget('Order', { Order: { partitionKey: 'pk' } });
    expect(target.partitionKey).toBe('pk');
  });
});

describe('resolveDynamoTarget — key-column normalisation', () => {
  it('a partition-only mapping produces a ONE-element key-column array', () => {
    const target = resolveDynamoTarget('Order', { Order: { partitionKey: 'pk' } });
    expect(target.keyColumns).toEqual(['pk']);
    expect(target.keyColumns).toHaveLength(1);
    expect(target.keyColumns[0]).toBe(target.partitionKey);
  });

  it('a sort-keyed mapping produces a TWO-element array, partition then sort', () => {
    const target = resolveDynamoTarget('Order', {
      Order: { partitionKey: 'tenantId', sortKey: 'orderId' },
    });
    expect(target.keyColumns).toEqual(['tenantId', 'orderId']);
    expect(target.keyColumns).toHaveLength(2);
    expect(target.keyColumns[0]).toBe('tenantId');
    expect(target.keyColumns[1]).toBe('orderId');
  });

  it('the resolved target carries no optional sort-key member to branch on', () => {
    // The key schema is represented once, as keyColumns. A `sortKey` property
    // on the target — present or `undefined` — would put a
    // `sortKey === undefined` branch in every builder, the exact place a
    // composite key silently degrades to its partition half.
    const withSort = resolveDynamoTarget('Order', {
      Order: { partitionKey: 'pk', sortKey: 'sk' },
    });
    const withoutSort = resolveDynamoTarget('Widget', { Widget: { partitionKey: 'pk' } });
    expect(Object.hasOwn(withSort, 'sortKey')).toBe(false);
    expect(Object.hasOwn(withoutSort, 'sortKey')).toBe(false);
  });
});

describe('resolveDynamoTarget — overrides', () => {
  it('honours table and partitionKey overrides (partition-only)', () => {
    const target = resolveDynamoTarget('User', {
      User: { table: 'users', partitionKey: 'pk' },
    });
    expect(target).toStrictEqual({
      table: 'users',
      partitionKey: 'pk',
      keyColumns: ['pk'],
      indexes: {},
      dateAttributes: {},
    });
  });

  it('honours a table override on a sort-keyed entity', () => {
    const target = resolveDynamoTarget('Order', {
      Order: { table: 'orders', partitionKey: 'pk', sortKey: 'sk' },
    });
    expect(target.table).toBe('orders');
    expect(target.keyColumns).toEqual(['pk', 'sk']);
  });

  it('carries configured indexes through to the target', () => {
    const target = resolveDynamoTarget('Order', {
      Order: {
        partitionKey: 'pk',
        indexes: { gsi1: { partitionKey: 'customerId', sortKey: 'createdAt' } },
      },
    });
    expect(target.indexes).toEqual({
      gsi1: { partitionKey: 'customerId', sortKey: 'createdAt' },
    });
  });

  it('carries declared date encodings through to the target', () => {
    const target = resolveDynamoTarget('Order', {
      Order: {
        partitionKey: 'pk',
        dateAttributes: { createdAt: 'iso', updatedAt: 'epochMs' },
      },
    });
    expect(target.dateAttributes).toEqual({ createdAt: 'iso', updatedAt: 'epochMs' });
  });

  it('resolves empty index and date maps when the mapping declares neither', () => {
    const target = resolveDynamoTarget('Order', {
      Order: { partitionKey: 'pk', sortKey: 'sk' },
    });
    expect(target.indexes).toEqual({});
    expect(target.dateAttributes).toEqual({});
  });
});

describe('dynamo-mapping module surface', () => {
  it('exports the resolver and nothing else at runtime — DynamoTarget stays internal', () => {
    // `DynamoEntityMapping` and its field types are erased at runtime; the
    // resolved `DynamoTarget` is deliberately NOT exported, so the namespace
    // object must carry exactly the one value export.
    expect(Object.keys(dynamoMapping).sort()).toEqual(['resolveDynamoTarget']);
  });
});

describe('resolveDynamoTarget — blank identifiers', () => {
  // A PRESENT but empty identifier is a configuration mistake, and DynamoDB
  // reports it without naming the entity or the option that caused it. Each
  // of the five mapped identifiers is refused here, because the message names
  // the option path and a wrong path is as unhelpful as no message at all.
  const cases: readonly (readonly [string, string, Record<string, unknown>])[] = [
    ['table', 'table', { table: '  ' }],
    ['partitionKey', 'partitionKey', { partitionKey: '' }],
    ['sortKey', 'sortKey', { partitionKey: 'pk', sortKey: ' ' }],
    ['a index partition key', 'indexes.byOwner.partitionKey', {
      partitionKey: 'pk',
      indexes: { byOwner: { partitionKey: '' } },
    }],
    ['a index sort key', 'indexes.byOwner.sortKey', {
      partitionKey: 'pk',
      indexes: { byOwner: { partitionKey: 'owner', sortKey: '\t' } },
    }],
  ];

  for (const [label, option, override] of cases) {
    it(`refuses ${label} that is present but blank, naming the option`, () => {
      let refusal: unknown;
      try {
        resolveDynamoTarget('Order', { Order: override } as never);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(UnsupportedQueryFeatureError);
      expect((refusal as Error).message).toContain(`'${option}'`);
      expect((refusal as Error).message).toContain("entity 'Order'");
    });
  }

  it('leaves an absent identifier to the defaulting path rather than refusing it', () => {
    // `undefined` is "not configured", which is the zero-config path — only a
    // blank string is a mistake.
    const target = resolveDynamoTarget('Order', { Order: { partitionKey: 'pk' } });
    expect(target.keyColumns).toEqual(['pk']);
    expect(target.table).toBe('Order');
  });
});
