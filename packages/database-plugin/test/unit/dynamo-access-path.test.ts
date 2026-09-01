/**
 * Coverage for DynamoDB access-path selection: table query, configured GSI
 * query and scan, including the key-condition/filter split.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NormalizedQuery } from '@setu-ts/common';
import { resolveDynamoAccessPath } from '../../src/adapters/dynamo/dynamo-access-path.ts';
import { resolveDynamoTarget } from '../../src/adapters/dynamo/dynamo-mapping.ts';

/** Builds a fully normalised query with only the test's relevant fields changed. */
function query(partial: Partial<NormalizedQuery>): NormalizedQuery {
  return {
    where: partial.where ?? {},
    ...(partial.filter === undefined ? {} : { filter: partial.filter }),
    orderBy: partial.orderBy ?? {},
    limit: partial.limit ?? -1,
    offset: partial.offset ?? 0,
    select: partial.select ?? [],
  };
}

/** Resolves the sort-keyed order target used by table, GSI and scan tests. */
function target() {
  return resolveDynamoTarget('Order', {
    Order: {
      table: 'orders',
      partitionKey: 'tenantId',
      sortKey: 'orderId',
      indexes: { 'customer-created': { partitionKey: 'customerId', sortKey: 'createdAt' } },
    },
  });
}

describe('resolveDynamoAccessPath', () => {
  it('selects a table Query and folds its partition and sort predicates into KeyConditionExpression', () => {
    const path = resolveDynamoAccessPath(
      'Order',
      target(),
      query({
        where: { tenantId: 'tenant-1' },
        filter: {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'orderId', operator: 'gte', value: 10 },
            { type: 'comparison', field: 'status', operator: 'eq', value: 'open' },
          ],
        },
      }),
    );

    expect(path.commandType).toBe('Query');
    expect(path.logPath).toBe('Query');
    expect(path.command).toStrictEqual({
      TableName: 'orders',
      KeyConditionExpression: '#n0 = :v0 AND #n1 >= :v1',
      FilterExpression: '#n2 = :v2',
      ExpressionAttributeNames: { '#n0': 'tenantId', '#n1': 'orderId', '#n2': 'status' },
      ExpressionAttributeValues: {
        ':v0': { S: 'tenant-1' },
        ':v1': { N: '10' },
        ':v2': { S: 'open' },
      },
    });
    expect(path.keyColumns).toEqual(['tenantId', 'orderId']);
    expect(path.cursorKeyColumns).toEqual(['tenantId', 'orderId']);
  });

  it('selects a configured GSI Query when its partition key is constrained', () => {
    const path = resolveDynamoAccessPath(
      'Order',
      target(),
      query({
        where: { customerId: 'customer-1' },
        filter: { type: 'comparison', field: 'createdAt', operator: 'lt', value: '2025-01-01' },
      }),
    );

    expect(path.commandType).toBe('Query');
    expect(path.logPath).toBe('customer-created');
    expect(path.command).toStrictEqual({
      TableName: 'orders',
      IndexName: 'customer-created',
      KeyConditionExpression: '#n0 = :v0 AND #n1 < :v1',
      ExpressionAttributeNames: { '#n0': 'customerId', '#n1': 'createdAt' },
      ExpressionAttributeValues: { ':v0': { S: 'customer-1' }, ':v1': { S: '2025-01-01' } },
    });
    expect(path.keyColumns).toEqual(['customerId', 'createdAt']);
    expect(path.cursorKeyColumns).toEqual(['customerId', 'createdAt', 'tenantId', 'orderId']);
  });

  it('selects Scan without a mapped partition equality and leaves the predicate as a filter', () => {
    const path = resolveDynamoAccessPath(
      'Order',
      target(),
      query({ where: { status: 'open' } }),
    );

    expect(path.commandType).toBe('Scan');
    expect(path.logPath).toBe('Scan');
    expect(path.command).toStrictEqual({
      TableName: 'orders',
      FilterExpression: '#n0 = :v0',
      ExpressionAttributeNames: { '#n0': 'status' },
      ExpressionAttributeValues: { ':v0': { S: 'open' } },
    });
    expect('KeyConditionExpression' in path.command).toBe(false);
    expect(path.cursorKeyColumns).toEqual(['tenantId', 'orderId']);
  });

  it('scans without a FilterExpression when the query has no predicates', () => {
    const path = resolveDynamoAccessPath('Order', target(), query({}));

    expect(path.command).toStrictEqual({ TableName: 'orders' });
  });

  it('queries a partition-only table without inventing a sort key', () => {
    const partitionOnly = resolveDynamoTarget('Audit', {
      Audit: { table: 'audit-log', partitionKey: 'requestId' },
    });
    const path = resolveDynamoAccessPath(
      'Audit',
      partitionOnly,
      query({ where: { requestId: 'request-1' } }),
    );

    expect(path.command).toStrictEqual({
      TableName: 'audit-log',
      KeyConditionExpression: '#n0 = :v0',
      ExpressionAttributeNames: { '#n0': 'requestId' },
      ExpressionAttributeValues: { ':v0': { S: 'request-1' } },
    });
    expect(path.keyColumns).toEqual(['requestId']);
  });

  it('uses a conjunctive filter partition equality to select a Query', () => {
    const path = resolveDynamoAccessPath(
      'Order',
      target(),
      query({
        filter: {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'tenantId', operator: 'eq', value: 'tenant-1' },
            { type: 'comparison', field: 'status', operator: 'eq', value: 'open' },
          ],
        },
      }),
    );

    expect(path.command).toStrictEqual({
      TableName: 'orders',
      KeyConditionExpression: '#n0 = :v0',
      FilterExpression: '#n1 = :v1',
      ExpressionAttributeNames: { '#n0': 'tenantId', '#n1': 'status' },
      ExpressionAttributeValues: { ':v0': { S: 'tenant-1' }, ':v1': { S: 'open' } },
    });
  });

  it('does not treat an equality inside an or group as a Query key condition', () => {
    const path = resolveDynamoAccessPath(
      'Order',
      target(),
      query({
        filter: {
          type: 'or',
          filters: [
            { type: 'comparison', field: 'tenantId', operator: 'eq', value: 'tenant-1' },
            { type: 'comparison', field: 'status', operator: 'eq', value: 'open' },
          ],
        },
      }),
    );

    expect(path.commandType).toBe('Scan');
    expect(path.command).toStrictEqual({
      TableName: 'orders',
      FilterExpression: '(#n0 = :v0) OR (#n1 = :v1)',
      ExpressionAttributeNames: { '#n0': 'tenantId', '#n1': 'status' },
      ExpressionAttributeValues: { ':v0': { S: 'tenant-1' }, ':v1': { S: 'open' } },
    });
  });

  it('folds each supported ordered comparison and leaves unsupported sort predicates as filters', () => {
    for (
      const [operator, keyCondition] of [
        ['gt', '#n0 = :v0 AND #n1 > :v1'],
        ['lte', '#n0 = :v0 AND #n1 <= :v1'],
      ] as const
    ) {
      const path = resolveDynamoAccessPath(
        'Order',
        target(),
        query({
          where: { tenantId: 'tenant-1' },
          filter: { type: 'comparison', field: 'orderId', operator, value: 10 },
        }),
      );
      expect(path.command).toMatchObject({ KeyConditionExpression: keyCondition });
    }

    const unsupported = resolveDynamoAccessPath(
      'Order',
      target(),
      query({
        where: { tenantId: 'tenant-1' },
        filter: { type: 'comparison', field: 'orderId', operator: 'contains', value: '1' },
      }),
    );
    expect(unsupported.command).toMatchObject({
      KeyConditionExpression: '#n0 = :v0',
      FilterExpression: 'contains(#n1, :v1)',
    });
  });
});

describe('resolveDynamoAccessPath select push-down', () => {
  it('pushes a Query select down as a ProjectionExpression aliasing every field', () => {
    const path = resolveDynamoAccessPath(
      'Order',
      target(),
      query({ where: { tenantId: 't1' }, select: ['status', 'total'] }),
    );
    // Without push-down the command carries no ProjectionExpression at all and
    // the server returns whole items for a projected read.
    expect(path.command.ProjectionExpression).toBe('#n1, #n2');
    expect(path.command.ExpressionAttributeNames).toMatchObject({
      '#n1': 'status',
      '#n2': 'total',
    });
  });

  it('pushes a Scan select down as a ProjectionExpression', () => {
    const path = resolveDynamoAccessPath(
      'Order',
      target(),
      query({ where: { status: 'open' }, select: ['total'] }),
    );
    expect(path.commandType).toBe('Scan');
    expect(path.command.ProjectionExpression).toBe('#n1');
  });

  it('omits ProjectionExpression entirely for an empty select', () => {
    const path = resolveDynamoAccessPath(
      'Order',
      target(),
      query({ where: { tenantId: 't1' } }),
    );
    expect(path.command.ProjectionExpression).toBeUndefined();
  });

  it('drops an empty select field rather than pushing an empty attribute name down', () => {
    // Measured against DynamoDB Local: an empty attribute name is refused with
    // `ExpressionAttributeNames contains invalid value: Empty attribute name`.
    // Before push-down such a select never reached the wire and the row was
    // simply projected to `{}` client-side, so emitting it would turn a
    // succeeding query into a server-side failure.
    const withEmptyOnly = resolveDynamoAccessPath(
      'Order',
      target(),
      query({ where: { tenantId: 't1' }, select: [''] }),
    );
    expect(withEmptyOnly.command.ProjectionExpression).toBeUndefined();
    expect(withEmptyOnly.command.ExpressionAttributeNames).not.toHaveProperty('#n1');

    const withRealField = resolveDynamoAccessPath(
      'Order',
      target(),
      query({ where: { tenantId: 't1' }, select: ['', 'status'] }),
    );
    expect(withRealField.command.ProjectionExpression).toBe('#n1');
    expect(withRealField.command.ExpressionAttributeNames).toMatchObject({ '#n1': 'status' });
  });

  it('collapses a repeated select field, which DynamoDB rejects as overlapping paths', () => {
    // Measured against DynamoDB Local: `#n0, #n0` — and even two DISTINCT
    // aliases naming one attribute — is refused with "Two document paths
    // overlap with each other", so the duplicate must never reach the wire.
    const path = resolveDynamoAccessPath(
      'Order',
      target(),
      query({ where: { tenantId: 't1' }, select: ['status', 'status'] }),
    );
    expect(path.command.ProjectionExpression).toBe('#n1');
  });
});
