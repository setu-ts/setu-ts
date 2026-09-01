/**
 * Coverage for DynamoDB's native sort-key ordering and its named refusals.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NormalizedQuery } from '@setu-ts/common';
import { resolveDynamoAccessPath } from '../../src/adapters/dynamo/dynamo-access-path.ts';
import { resolveDynamoTarget } from '../../src/adapters/dynamo/dynamo-mapping.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';

/** Builds the normalised query shape driven by the access-path resolver. */
function query(partial: Partial<NormalizedQuery>): NormalizedQuery {
  return {
    where: partial.where ?? { tenantId: 'tenant-1' },
    ...(partial.filter === undefined ? {} : { filter: partial.filter }),
    orderBy: partial.orderBy ?? {},
    limit: partial.limit ?? -1,
    offset: partial.offset ?? 0,
    select: partial.select ?? [],
  };
}

/** Resolves the sort-keyed entity that has one native ordering field. */
function target() {
  return resolveDynamoTarget('Order', {
    Order: { table: 'orders', partitionKey: 'tenantId', sortKey: 'createdAt' },
  });
}

/** Captures the resolver's synchronous named refusal. */
function refusalOf(action: () => void): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('resolveDynamoAccessPath — orderBy', () => {
  it('maps ascending sort-key order to ScanIndexForward true', () => {
    const path = resolveDynamoAccessPath(
      'Order',
      target(),
      query({ orderBy: { createdAt: 'asc' } }),
    );

    expect(path.commandType).toBe('Query');
    expect(path.command).toMatchObject({ ScanIndexForward: true });
  });

  it('maps descending sort-key order to ScanIndexForward false', () => {
    const path = resolveDynamoAccessPath(
      'Order',
      target(),
      query({ orderBy: { createdAt: 'desc' } }),
    );

    expect(path.commandType).toBe('Query');
    expect(path.command).toMatchObject({ ScanIndexForward: false });
  });

  it('serves an empty orderBy without ScanIndexForward', () => {
    const path = resolveDynamoAccessPath('Order', target(), query({ orderBy: {} }));

    expect('ScanIndexForward' in path.command).toBe(false);
  });

  it('refuses a non-key orderBy by field and entity name', () => {
    const refusal = refusalOf(() =>
      resolveDynamoAccessPath('Order', target(), query({ orderBy: { status: 'asc' } }))
    );

    expect(refusal).toBeInstanceOf(UnsupportedQueryFeatureError);
    const error = refusal as UnsupportedQueryFeatureError;
    expect(error.feature).toBe('orderBy');
    expect(error.adapter).toBe('dynamodb');
    expect(error.message).toContain("entity 'Order'");
    expect(error.message).toContain("'status'");
    expect(error.message).toContain("'createdAt'");
  });

  it('refuses multi-field orderBy by naming every requested field', () => {
    const refusal = refusalOf(() =>
      resolveDynamoAccessPath(
        'Order',
        target(),
        query({ orderBy: { createdAt: 'asc', status: 'desc' } }),
      )
    );

    expect(refusal).toBeInstanceOf(UnsupportedQueryFeatureError);
    const error = refusal as UnsupportedQueryFeatureError;
    expect(error.message).toContain("'createdAt, status'");
    expect(error.message).toContain("entity 'Order'");
    expect(error.message).toContain("'createdAt'");
  });
});
