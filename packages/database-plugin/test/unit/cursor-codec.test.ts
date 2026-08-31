/**
 * Keyset-predicate behaviour, evaluated against REAL rows.
 *
 * The codec itself (`encodeCursor`/`decodeCursor` round-trips, Unicode, and
 * malformed-token handling) is owned by
 * `packages/common/test/unit/cursor-codec.test.ts`, where the implementation
 * lives — this file used to restate all of it, which is the duplication
 * AI_GUIDELINES §11.1 forbids and two copies that would inevitably drift.
 *
 * What is NOT duplicated, and is the reason this file exists, is running the
 * predicate through `matchesFilter`: `keysetPredicate` returns a portable
 * `FilterExpression`, and asserting its SHAPE proves only that the tree was
 * built. Evaluating it against real rows proves the tree selects the right
 * ones — which is what the P11 row-loss defect turned on.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { keysetPredicate } from '@setu-ts/common';
import type { FilterExpression } from '@setu-ts/common';
import { matchesFilter } from '../../src/query/query-builder.ts';

describe('keysetPredicate', () => {
  it('produces a single or-comparison for desc sort when key matches orderBy', () => {
    // When the key column is the sort's only field, no tiebreaker is appended
    // — the single leg already covers the "after this row" semantics.
    const pred: FilterExpression = keysetPredicate([5], [5], { id: 'desc' }, ['id']);
    expect(pred).toEqual({
      type: 'or',
      filters: [{ type: 'comparison', field: 'id', operator: 'lt', value: 5 }],
    });
  });

  it('produces a single or-comparison for asc sort when key matches orderBy', () => {
    const pred: FilterExpression = keysetPredicate([5], [5], { id: 'asc' }, ['id']);
    expect(pred).toEqual({
      type: 'or',
      filters: [{ type: 'comparison', field: 'id', operator: 'gt', value: 5 }],
    });
  });

  it('emits the lexicographic or(gt, and(eq, gt)) tree', () => {
    // orderBy on `name` only; `id` is appended as the ascending tiebreaker.
    // Leg 1: strictly greater name. Leg 2: same name, strictly greater id —
    // plan §3.8's `or(lt(createdAt), and(eq(createdAt), gt(id)))` shape, with
    // asc directions.
    const pred: FilterExpression = keysetPredicate(['alice', 5], [5], { name: 'asc' }, ['id']);
    expect(pred).toEqual({
      type: 'or',
      filters: [
        { type: 'comparison', field: 'name', operator: 'gt', value: 'alice' },
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'name', operator: 'eq', value: 'alice' },
            { type: 'comparison', field: 'id', operator: 'gt', value: 5 },
          ],
        },
      ],
    });
  });

  it('does not duplicate a key column already present in orderBy', () => {
    // orderBy ends with `id`; it already is a sort position, so no tiebreaker
    // is appended — but the legs stay lexicographic: a later leg pins every
    // earlier field to its cursor value. orderedValues mirrors the sort:
    // [nameValue, idValue].
    const pred: FilterExpression = keysetPredicate([42, 5], [5], { name: 'asc', id: 'asc' }, [
      'id',
    ]);
    expect(pred).toEqual({
      type: 'or',
      filters: [
        // Position 0: field `name`, gt orderedValues[0] = 42.
        { type: 'comparison', field: 'name', operator: 'gt', value: 42 },
        // Position 1: name pinned to 42, field `id` gt orderedValues[1] = 5.
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'name', operator: 'eq', value: 42 },
            { type: 'comparison', field: 'id', operator: 'gt', value: 5 },
          ],
        },
      ],
    });
  });

  it('pins earlier sort fields with eq in each later leg', () => {
    // Empty keyColumns means no tiebreaker; the legs are still lexicographic.
    const pred: FilterExpression = keysetPredicate(['b', 2], [1], { a: 'asc', b: 'desc' }, []);
    expect(pred).toEqual({
      type: 'or',
      filters: [
        // Position 0: field `a` (asc), gt orderedValues[0] = 'b'.
        { type: 'comparison', field: 'a', operator: 'gt', value: 'b' },
        // Position 1: a pinned to 'b', field `b` (desc), lt orderedValues[1] = 2.
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'a', operator: 'eq', value: 'b' },
            { type: 'comparison', field: 'b', operator: 'lt', value: 2 },
          ],
        },
      ],
    });
  });

  it('indexes each tiebreaker key column by its keyValues position', () => {
    // `tenantId` and `id` are both appended (neither is in orderBy); each
    // takes ITS OWN keyValues entry — tenantId → keyValues[0], id →
    // keyValues[1] — never a shared keyValues[0] fallback.
    const pred: FilterExpression = keysetPredicate(['alice'], [88, 99], { name: 'asc' }, [
      'tenantId',
      'id',
    ]);
    expect(pred).toEqual({
      type: 'or',
      filters: [
        { type: 'comparison', field: 'name', operator: 'gt', value: 'alice' },
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'name', operator: 'eq', value: 'alice' },
            { type: 'comparison', field: 'tenantId', operator: 'gt', value: 88 },
          ],
        },
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'name', operator: 'eq', value: 'alice' },
            { type: 'comparison', field: 'tenantId', operator: 'eq', value: 88 },
            { type: 'comparison', field: 'id', operator: 'gt', value: 99 },
          ],
        },
      ],
    });
  });

  it('reads key columns positionally when orderBy is empty', () => {
    // With empty orderBy every key column becomes an ascending tiebreaker,
    // each indexed by its own keyValues position (a → 1, b → 2).
    const pred: FilterExpression = keysetPredicate([], [1, 2], {}, ['a', 'b']);
    expect(pred).toEqual({
      type: 'or',
      filters: [
        { type: 'comparison', field: 'a', operator: 'gt', value: 1 },
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'a', operator: 'eq', value: 1 },
            { type: 'comparison', field: 'b', operator: 'gt', value: 2 },
          ],
        },
      ],
    });
  });

  it('returns a bare or when there are no key columns and no orderBy', () => {
    const pred: FilterExpression = keysetPredicate([], [], {}, []);
    expect(pred).toEqual({ type: 'or', filters: [] });
  });

  it('uses keyValues for tiebreakers even when orderedValues[0] differs', () => {
    // Critical test: orderedValues carries non-key field values; keyValues
    // carries the primary-key values. When a key column is absent from
    // orderBy (pure tiebreaker), the predicate must use keyValues, not
    // orderedValues[0], which would be the non-key field value.
    //
    // Example: orderBy = { score: 'asc' }, keyColumns = ['id'].
    // orderedValues = [2] (the score of the last row), keyValues = ['y'] (the id).
    // The tiebreaker leg's id comparison must use 'y', not 2.
    const pred: FilterExpression = keysetPredicate([2], ['y'], { score: 'asc' }, ['id']);
    expect(pred).toEqual({
      type: 'or',
      filters: [
        { type: 'comparison', field: 'score', operator: 'gt', value: 2 },
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'score', operator: 'eq', value: 2 },
            { type: 'comparison', field: 'id', operator: 'gt', value: 'y' },
          ],
        },
      ],
    });
  });

  it('keeps only rows strictly after the cursor', () => {
    // Behavioral control, evaluated with the SAME matchesFilter the memory
    // walk uses, for the T1 defect the shared predicate replaces: the old
    // `and(or(strict…), or(eq key…))` tree matched only rows whose key equaled
    // the cursor row's key, and a flat `or(strict…)` even matched rows BEFORE
    // the cursor. Sort (a asc, b asc) with an `id` tiebreaker; cursor row
    // (a=2, b=1, id=5):
    const pred: FilterExpression = keysetPredicate([2, 1], [5], { a: 'asc', b: 'asc' }, ['id']);
    // A row before the cursor must NOT match — the old flat strict-or matched
    // it because b=9 > 1.
    expect(matchesFilter({ a: 1, b: 9, id: 5 }, pred)).toBe(false);
    // A row after on the first sort field matches.
    expect(matchesFilter({ a: 3, b: 0, id: 5 }, pred)).toBe(true);
    // A row after on the second sort field matches (same a, greater b).
    expect(matchesFilter({ a: 2, b: 7, id: 5 }, pred)).toBe(true);
    // A row tied on both sort fields matches through the id tiebreaker leg —
    // the P11 class the tiebreaker exists for.
    expect(matchesFilter({ a: 2, b: 1, id: 9 }, pred)).toBe(true);
    // The cursor row itself does not match (strictly after, not at-or-after).
    expect(matchesFilter({ a: 2, b: 1, id: 5 }, pred)).toBe(false);
  });

  it('matches a later row whose key differs from the cursor key', () => {
    // The measured T9 defect: with a pure-tiebreaker key the old tree
    // required eq(id, cursorKey), so a row with a different id NEVER matched.
    const pred: FilterExpression = keysetPredicate(['alice'], [5], { name: 'asc' }, ['id']);
    expect(matchesFilter({ name: 'bob', id: 9 }, pred)).toBe(true);
    expect(matchesFilter({ name: 'aaron', id: 9 }, pred)).toBe(false);
  });
});
