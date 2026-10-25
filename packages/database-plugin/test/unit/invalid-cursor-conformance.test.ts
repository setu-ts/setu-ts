import { describe, expect, it } from 'vitest';
import { encodeCursor, InvalidCursorError, sortFingerprint } from '@setu-ts/common';
import type { NormalizedQuery } from '@setu-ts/common';
import { sources } from '../fixtures/conditional-sources.ts';
import { CosmosAdapter } from '../../src/adapters/cosmos/cosmos-adapter.ts';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';

it('Cosmos binds cursors to entity names even when both entities share a container', async () => {
  const adapter = new CosmosAdapter({
    database: 'db',
    client: createFakeCosmosClient({
      containers: { users: { partitionKeyPaths: ['/id'] } },
      queryResults: [[{ id: '1' }, { id: '2' }], [{ id: '2' }]],
    }).client,
    containers: { First: { container: 'users' }, Second: { container: 'users' } },
  });
  await adapter.connect();
  try {
    const first = adapter.createDataSource('First');
    const second = adapter.createDataSource('Second');
    await first.create({ id: '1' });
    await first.create({ id: '2' });
    const query = { where: {}, orderBy: { id: 'asc' as const }, select: [], limit: 1, offset: 0 };
    const page = await first.findPage!(query);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = { ...query, cursor: page.nextCursor! };
    expect((await first.findPage!(next)).rows).toEqual([{ id: '2' }]);
    await expect(second.findPage!(next)).rejects.toBeInstanceOf(InvalidCursorError);
  } finally {
    await adapter.disconnect();
  }
});

for (const fixture of sources) {
  describe(`${fixture.name} cursor content`, () => {
    const orderBy = fixture.name === 'dynamodb' ? {} : { id: 'asc' as const };
    const scope = {
      entity: fixture.name === 'drizzle' ? 'user' : fixture.name === 'd1' ? 'users' : 'User',
      keyColumns: ['id'],
    };
    const fingerprint = sortFingerprint(orderBy, scope);
    const cases = [
      ['malformed', 'private-malformed-token'],
      [
        'fingerprint mismatch',
        encodeCursor({
          orderedValues: ['5'],
          keyValues: ['5'],
          sortFingerprint: 'private-sort-fingerprint',
        }),
      ],
      [
        'key shape mismatch',
        encodeCursor({
          orderedValues: ['5'],
          keyValues: [],
          sortFingerprint: fingerprint,
        }),
      ],
      [
        'ordered shape mismatch',
        encodeCursor({
          orderedValues: ['5', 'private-extra'],
          keyValues: ['5'],
          sortFingerprint: fingerprint,
        }),
      ],
      [
        'key kind mismatch',
        encodeCursor({
          orderedValues: [],
          keyValues: [new Date(10)],
          sortFingerprint: fingerprint,
        }),
      ],
    ];
    for (const [label, cursor] of cases.filter(
      ([label]) =>
        (label !== 'key kind mismatch' ||
          fixture.name === 'bigtable' ||
          fixture.name === 'dynamodb') &&
        (label !== 'ordered shape mismatch' ||
          (fixture.name !== 'bigtable' && fixture.name !== 'dynamodb')),
    )) {
      it(`rejects ${label} through a Promise without echoing cursor content`, async () => {
        const calls: string[] = [];
        const source = fixture.make(calls);
        calls.length = 0;
        const query: NormalizedQuery = {
          where: fixture.name === 'dynamodb' ? { id: '5' } : {},
          orderBy,
          limit: 2,
          offset: 0,
          select: [],
          cursor: cursor!,
        };
        let promise: ReturnType<NonNullable<typeof source.findPage>> | undefined;
        expect(() => {
          promise = source.findPage!(query);
        }).not.toThrow();
        const error: unknown = await promise!.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(InvalidCursorError);
        expect(calls).toEqual([]);
        expect((error as Error).message).not.toContain(cursor!);
        expect((error as Error).message).not.toContain('private-sort-fingerprint');
      });
    }
  });
}

for (const fixture of sources) {
  it(`${fixture.name} refuses a cursor minted for another entity with the same sort`, async () => {
    const calls: string[] = [];
    const source = fixture.make(calls);
    calls.length = 0;
    const orderBy = fixture.name === 'dynamodb' ? {} : { id: 'asc' as const };
    const cursor = encodeCursor({
      orderedValues: Object.keys(orderBy).map(() => '5'),
      keyValues: ['5'],
      sortFingerprint: sortFingerprint(orderBy, { entity: 'Other', keyColumns: ['id'] }),
    });
    await expect(
      source.findPage!({
        where: fixture.name === 'dynamodb' ? { id: '5' } : {},
        orderBy,
        offset: 0,
        limit: 2,
        select: [],
        cursor,
      }),
    ).rejects.toThrow(InvalidCursorError);
    expect(calls).toEqual([]);
  });
}
