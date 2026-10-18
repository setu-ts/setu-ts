import { describe, expect, it } from 'vitest';
import { encodeCursor, InvalidCursorError, sortFingerprint } from '@setu-ts/common';
import type { NormalizedQuery } from '@setu-ts/common';
import { sources } from '../fixtures/conditional-sources.ts';

for (const fixture of sources) {
  describe(`${fixture.name} cursor content`, () => {
    const orderBy = fixture.name === 'dynamodb' ? {} : { id: 'asc' as const };
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
          sortFingerprint: sortFingerprint(orderBy),
        }),
      ],
      [
        'ordered shape mismatch',
        encodeCursor({
          orderedValues: ['5', 'private-extra'],
          keyValues: ['5'],
          sortFingerprint: sortFingerprint(orderBy),
        }),
      ],
      [
        'key kind mismatch',
        encodeCursor({
          orderedValues: [],
          keyValues: [new Date(10)],
          sortFingerprint: sortFingerprint(orderBy),
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
