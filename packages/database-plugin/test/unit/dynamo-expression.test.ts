/**
 * Coverage for DynamoDB expression building (`dynamo-expression.ts`):
 * unconditional name aliasing (M80 plan §3.13 — including the measured
 * reserved word `status`, §1A F1, and per-segment nested paths, §1A F2), the
 * `:vN` value placeholders, all seven portable `FilterOperator`s asserted on
 * the emitted expressions, the empty-`in` match-nothing form (§1A F5 — never
 * `IN ()`), the group identities and their algebraic composition, and the
 * declared-encoding / undeclared-`Date` refusal (§3.14, §1A F6/F7).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { FilterExpression } from '@setu-ts/common';
import {
  buildDynamoProjection,
  createDynamoExpressionBuilder,
  translateDynamoFilter,
} from '../../src/adapters/dynamo/dynamo-expression.ts';
import type { DynamoDateEncoding } from '../../src/adapters/dynamo/dynamo-mapping.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';

/** §1A F6's shape: one timestamp every date arm converts. */
const DATE = new Date('2024-06-01T12:34:56.789Z');
/** The ISO-8601 text `toISOString()` yields for {@linkcode DATE}. */
const DATE_ISO = '2024-06-01T12:34:56.789Z';
/** The epoch-milliseconds number `getTime()` yields for {@linkcode DATE}. */
const DATE_EPOCH_MS = DATE.getTime();

/**
 * Renders a filter through a fresh builder — the way one command assembles.
 *
 * @param filter - The portable filter tree
 * @param dateAttributes - Declared date encodings, empty by default
 * @returns The emitted expression and the builder carrying its aliases
 */
function render(
  filter: FilterExpression,
  dateAttributes: Readonly<Record<string, DynamoDateEncoding>> = {},
): {
  expression: string | undefined;
  attributes: ReturnType<ReturnType<typeof createDynamoExpressionBuilder>['expressionAttributes']>;
} {
  const builder = createDynamoExpressionBuilder();
  const expression = translateDynamoFilter(filter, builder, dateAttributes);
  return { expression, attributes: builder.expressionAttributes() };
}

/** Captures a synchronous refusal from a pure translation function. */
function refusalOf(action: () => void): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('DynamoExpressionBuilder — aliasing', () => {
  it('aliases a flat attribute name as #n0 and records it', () => {
    const builder = createDynamoExpressionBuilder();
    expect(builder.aliasPath('open')).toBe('#n0');
    expect(builder.expressionAttributes()).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'open' },
    });
  });

  it('numbers aliases in first-seen order across calls', () => {
    const builder = createDynamoExpressionBuilder();
    expect(builder.aliasPath('tenantId')).toBe('#n0');
    expect(builder.aliasPath('orderId')).toBe('#n1');
    expect(builder.aliasPath('tenantId')).toBe('#n0');
    expect(builder.expressionAttributes()).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'tenantId', '#n1': 'orderId' },
    });
  });

  it('aliases a DynamoDB reserved word exactly like any other name', () => {
    // §1A F1: `status` used raw is a ValidationException, and the reserved
    // list is ~570 words that grows between AWS releases — so aliasing is
    // unconditional and NO reserved-word list exists to consult. The
    // assertion is that a reserved word aliases through the same #nN path.
    const builder = createDynamoExpressionBuilder();
    expect(builder.aliasPath('status')).toBe('#n0');
    expect(builder.aliasPath('size')).toBe('#n1');
    expect(builder.expressionAttributes()).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'status', '#n1': 'size' },
    });
  });

  it('aliases each segment of a nested path', () => {
    // §1A F2: M79's nested-path member translates natively, one alias per
    // segment, joined with dots.
    const builder = createDynamoExpressionBuilder();
    expect(builder.aliasPath(['profile', 'address', 'city'])).toBe('#n0.#n1.#n2');
    expect(builder.expressionAttributes()).toStrictEqual({
      ExpressionAttributeNames: {
        '#n0': 'profile',
        '#n1': 'address',
        '#n2': 'city',
      },
    });
  });

  it('reuses a segment alias when the same attribute appears in two paths', () => {
    const builder = createDynamoExpressionBuilder();
    expect(builder.aliasPath(['profile', 'city'])).toBe('#n0.#n1');
    expect(builder.aliasPath(['address', 'city'])).toBe('#n2.#n1');
    expect(builder.expressionAttributes()).toStrictEqual({
      ExpressionAttributeNames: {
        '#n0': 'profile',
        '#n1': 'city',
        '#n2': 'address',
      },
    });
  });

  it('refuses an empty path array by name', () => {
    // The Mongo adapter refuses the same caller bug by name.
    const builder = createDynamoExpressionBuilder();
    const refusal = refusalOf(() => builder.aliasPath([]));
    expect(refusal).toBeInstanceOf(UnsupportedQueryFeatureError);
    const error = refusal as UnsupportedQueryFeatureError;
    expect(error.feature).toBe('nested-path');
    expect(error.adapter).toBe('dynamodb');
  });
});

describe('DynamoExpressionBuilder — values', () => {
  it('registers values as sequential :vN placeholders', () => {
    const builder = createDynamoExpressionBuilder();
    expect(builder.addValue('open')).toBe(':v0');
    expect(builder.addValue(42)).toBe(':v1');
    expect(builder.addValue(true)).toBe(':v2');
    expect(builder.addValue(null)).toBe(':v3');
    expect(builder.expressionAttributes()).toStrictEqual({
      ExpressionAttributeValues: {
        ':v0': { S: 'open' },
        ':v1': { N: '42' },
        ':v2': { BOOL: true },
        ':v3': { NULL: true },
      },
    });
  });

  it('folds to an empty object while nothing is registered', () => {
    const builder = createDynamoExpressionBuilder();
    expect(builder.expressionAttributes()).toStrictEqual({});
  });

  it('folds both members only when each is non-empty', () => {
    const builder = createDynamoExpressionBuilder();
    builder.aliasPath('status');
    expect(builder.expressionAttributes()).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'status' },
    });
  });
});

describe('translateDynamoFilter — the seven operators', () => {
  it('renders eq as an aliased equality', () => {
    const { expression, attributes } = render({
      type: 'comparison',
      field: 'status',
      operator: 'eq',
      value: 'open',
    });
    expect(expression).toBe('#n0 = :v0');
    expect(attributes).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'status' },
      ExpressionAttributeValues: { ':v0': { S: 'open' } },
    });
  });

  it('renders contains natively with the value unescaped', () => {
    // §1A F3: contains is a native operator over an unparsed value, so
    // unlike SQL `LIKE` (M70b X12-1) nothing escapes the pattern.
    const { expression, attributes } = render({
      type: 'comparison',
      field: 'summary',
      operator: 'contains',
      value: '50% off _today_',
    });
    expect(expression).toBe('contains(#n0, :v0)');
    expect(attributes).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'summary' },
      ExpressionAttributeValues: { ':v0': { S: '50% off _today_' } },
    });
  });

  it('renders gt, gte, lt and lte as their comparator symbols', () => {
    const ordered = (operator: 'gt' | 'gte' | 'lt' | 'lte', value: number): string => {
      const { expression } = render({
        type: 'comparison',
        field: 'total',
        operator,
        value,
      });
      return expression ?? '';
    };
    expect(ordered('gt', 10)).toBe('#n0 > :v0');
    expect(ordered('gte', 10.5)).toBe('#n0 >= :v0');
    expect(ordered('lt', -3)).toBe('#n0 < :v0');
    expect(ordered('lte', 0)).toBe('#n0 <= :v0');
  });

  it('renders a non-empty in list as the native IN operator', () => {
    // §1A F4: `#s IN (:a, :b)` is served natively.
    const { expression, attributes } = render({
      type: 'comparison',
      field: 'status',
      operator: 'in',
      value: ['open', 'shipped'],
    });
    expect(expression).toBe('#n0 IN (:v0, :v1)');
    expect(attributes).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'status' },
      ExpressionAttributeValues: { ':v0': { S: 'open' }, ':v1': { S: 'shipped' } },
    });
  });

  it('emits a match-nothing condition for an empty in list, never IN ()', () => {
    // §1A F5: `IN ()` is a server-side syntax error, and M79 defines an
    // empty `in` as matching nothing. The emitted form compares two
    // statically distinct value placeholders — measured against the live
    // emulator to match zero items — and aliases no attribute at all.
    const { expression, attributes } = render({
      type: 'comparison',
      field: 'status',
      operator: 'in',
      value: [],
    });
    expect(expression).toBe(':v0 = :v1');
    expect(expression).not.toContain('IN');
    expect(attributes).toStrictEqual({
      ExpressionAttributeValues: { ':v0': { BOOL: true }, ':v1': { BOOL: false } },
    });
  });
});

describe('translateDynamoFilter — Date values (§3.14)', () => {
  it("converts a Date in an ordered comparison under the declared 'iso' encoding", () => {
    // §1A F6: ISO-8601 strings sort chronologically, so the range compares
    // correctly against the stored strings.
    const { expression, attributes } = render({
      type: 'comparison',
      field: 'createdAt',
      operator: 'gt',
      value: DATE,
    }, { createdAt: 'iso' });
    expect(expression).toBe('#n0 > :v0');
    expect(attributes).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'createdAt' },
      ExpressionAttributeValues: { ':v0': { S: DATE_ISO } },
    });
  });

  it("converts a Date under the declared 'epochMs' encoding", () => {
    const { expression, attributes } = render({
      type: 'comparison',
      field: 'createdAt',
      operator: 'lte',
      value: DATE,
    }, { createdAt: 'epochMs' });
    expect(expression).toBe('#n0 <= :v0');
    expect(attributes).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'createdAt' },
      ExpressionAttributeValues: { ':v0': { N: String(DATE_EPOCH_MS) } },
    });
  });

  it('converts a Date in an eq comparison under the declared encoding too', () => {
    const { expression, attributes } = render({
      type: 'comparison',
      field: 'createdAt',
      operator: 'eq',
      value: DATE,
    }, { createdAt: 'iso' });
    expect(expression).toBe('#n0 = :v0');
    expect(attributes).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'createdAt' },
      ExpressionAttributeValues: { ':v0': { S: DATE_ISO } },
    });
  });

  it('refuses a Date with no declared encoding, naming the attribute', () => {
    // §1A F7: DynamoDB has no date type, so the adapter never guesses how a
    // stored timestamp is encoded — it refuses, naming the attribute and the
    // `dateAttributes` option that fixes it.
    const refusal = refusalOf(() =>
      render({ type: 'comparison', field: 'createdAt', operator: 'gte', value: DATE })
    );
    expect(refusal).toBeInstanceOf(UnsupportedQueryFeatureError);
    const error = refusal as UnsupportedQueryFeatureError;
    expect(error.feature).toBe('date-encoding');
    expect(error.adapter).toBe('dynamodb');
    expect(error.message).toContain('createdAt');
    expect(error.message).toContain('dateAttributes');
  });

  it('refuses a Date eq the same way — the refusal is arm-independent', () => {
    const refusal = refusalOf(() =>
      render({ type: 'comparison', field: 'createdAt', operator: 'eq', value: DATE })
    );
    expect(refusal).toBeInstanceOf(UnsupportedQueryFeatureError);
  });

  it('refuses a Date on a nested path, naming the joined path', () => {
    // The mapping's dateAttributes keys are flat attribute names, so a
    // nested path has no declaration to read — the same stance the
    // marshaller records.
    const refusal = refusalOf(() =>
      render({
        type: 'comparison',
        field: ['profile', 'joinedAt'],
        operator: 'lt',
        value: DATE,
      })
    );
    expect(refusal).toBeInstanceOf(UnsupportedQueryFeatureError);
    expect((refusal as UnsupportedQueryFeatureError).message).toContain('profile.joinedAt');
  });

  it('refuses a Date inside an in list with no declaration', () => {
    const refusal = refusalOf(() =>
      render({
        type: 'comparison',
        field: 'createdAt',
        operator: 'in',
        value: [DATE, DATE],
      })
    );
    expect(refusal).toBeInstanceOf(UnsupportedQueryFeatureError);
    expect((refusal as UnsupportedQueryFeatureError).message).toContain('createdAt');
  });

  it('converts Date elements of an in list under the declared encoding', () => {
    const { expression, attributes } = render({
      type: 'comparison',
      field: 'checkpoints',
      operator: 'in',
      value: [DATE, DATE],
    }, { checkpoints: 'epochMs' });
    expect(expression).toBe('#n0 IN (:v0, :v1)');
    expect(attributes).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'checkpoints' },
      ExpressionAttributeValues: {
        ':v0': { N: String(DATE_EPOCH_MS) },
        ':v1': { N: String(DATE_EPOCH_MS) },
      },
    });
  });
});

describe('translateDynamoFilter — groups and identities', () => {
  it('joins an and group, parenthesizing each operand', () => {
    const { expression, attributes } = render({
      type: 'and',
      filters: [
        { type: 'comparison', field: 'tenantId', operator: 'eq', value: 't1' },
        { type: 'comparison', field: 'status', operator: 'eq', value: 'open' },
      ],
    });
    expect(expression).toBe('(#n0 = :v0) AND (#n1 = :v1)');
    expect(attributes).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'tenantId', '#n1': 'status' },
      ExpressionAttributeValues: { ':v0': { S: 't1' }, ':v1': { S: 'open' } },
    });
  });

  it('joins an or group the same way', () => {
    const { expression } = render({
      type: 'or',
      filters: [
        { type: 'comparison', field: 'status', operator: 'eq', value: 'open' },
        { type: 'comparison', field: 'region', operator: 'eq', value: 'eu' },
      ],
    });
    expect(expression).toBe('(#n0 = :v0) OR (#n1 = :v1)');
  });

  it('parenthesizes a nested or inside an and so precedence survives', () => {
    // DynamoDB binds AND tighter than OR, so the parens are load-bearing.
    // Both or-legs compare `status`, so the segment alias is shared — the
    // dedup the builder documents.
    const { expression } = render({
      type: 'and',
      filters: [
        {
          type: 'or',
          filters: [
            { type: 'comparison', field: 'status', operator: 'eq', value: 'open' },
            { type: 'comparison', field: 'status', operator: 'eq', value: 'shipped' },
          ],
        },
        { type: 'comparison', field: 'total', operator: 'gt', value: 100 },
      ],
    });
    expect(expression).toBe('((#n0 = :v0) OR (#n0 = :v1)) AND (#n1 > :v2)');
  });

  it('emits no filter for an empty and group — the boolean identity', () => {
    // `FilterExpression` permits an empty group and normalizeQuery forwards
    // it unchanged; the identity matches every item, so no FilterExpression
    // is sent — and no alias or value leaks into the command.
    const { expression, attributes } = render({ type: 'and', filters: [] });
    expect(expression).toBeUndefined();
    expect(attributes).toStrictEqual({});
  });

  it('emits the match-nothing condition for an empty or group', () => {
    const { expression, attributes } = render({ type: 'or', filters: [] });
    expect(expression).toBe(':v0 = :v1');
    expect(attributes).toStrictEqual({
      ExpressionAttributeValues: { ':v0': { BOOL: true }, ':v1': { BOOL: false } },
    });
  });

  it('short-circuits an and on a match-nothing child without orphaned values', () => {
    // The dropped sibling's placeholder must never reach the command: the
    // server rejects a value registered but unused in the expressions.
    const { expression, attributes } = render({
      type: 'and',
      filters: [
        { type: 'comparison', field: 'status', operator: 'eq', value: 'open' },
        { type: 'comparison', field: 'color', operator: 'in', value: [] },
      ],
    });
    expect(expression).toBe(':v0 = :v1');
    expect(attributes).toStrictEqual({
      ExpressionAttributeValues: { ':v0': { BOOL: true }, ':v1': { BOOL: false } },
    });
  });

  it('drops a match-all child of an and and serves the survivor unwrapped', () => {
    const { expression } = render({
      type: 'and',
      filters: [
        { type: 'and', filters: [] },
        { type: 'comparison', field: 'status', operator: 'eq', value: 'open' },
      ],
    });
    expect(expression).toBe('#n0 = :v0');
  });

  it('reduces an and of only match-all children to no filter', () => {
    const { expression, attributes } = render({
      type: 'and',
      filters: [{ type: 'and', filters: [] }],
    });
    expect(expression).toBeUndefined();
    expect(attributes).toStrictEqual({});
  });

  it('absorbs a match-all child of an or into no filter', () => {
    const { expression, attributes } = render({
      type: 'or',
      filters: [
        { type: 'and', filters: [] },
        { type: 'comparison', field: 'status', operator: 'eq', value: 'open' },
      ],
    });
    expect(expression).toBeUndefined();
    expect(attributes).toStrictEqual({});
  });

  it('drops a match-nothing child of an or and serves the survivor unwrapped', () => {
    const { expression, attributes } = render({
      type: 'or',
      filters: [
        { type: 'comparison', field: 'color', operator: 'in', value: [] },
        { type: 'comparison', field: 'status', operator: 'eq', value: 'open' },
      ],
    });
    expect(expression).toBe('#n0 = :v0');
    expect(attributes).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'status' },
      ExpressionAttributeValues: { ':v0': { S: 'open' } },
    });
  });

  it('reduces an or of only match-nothing children to the contradiction', () => {
    const { expression, attributes } = render({
      type: 'or',
      filters: [{ type: 'comparison', field: 'color', operator: 'in', value: [] }],
    });
    expect(expression).toBe(':v0 = :v1');
    expect(attributes).toStrictEqual({
      ExpressionAttributeValues: { ':v0': { BOOL: true }, ':v1': { BOOL: false } },
    });
  });
});

describe('buildDynamoProjection', () => {
  it('returns undefined for an empty select so every attribute is returned', () => {
    const builder = createDynamoExpressionBuilder();
    expect(buildDynamoProjection([], builder)).toBeUndefined();
    expect(builder.expressionAttributes()).toStrictEqual({});
  });

  it('aliases every projected field name', () => {
    const builder = createDynamoExpressionBuilder();
    expect(buildDynamoProjection(['tenantId', 'total'], builder)).toBe('#n0, #n1');
    expect(builder.expressionAttributes()).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'tenantId', '#n1': 'total' },
    });
  });

  it('aliases a reserved projected field exactly like any other', () => {
    const builder = createDynamoExpressionBuilder();
    expect(buildDynamoProjection(['status'], builder)).toBe('#n0');
    expect(builder.expressionAttributes()).toStrictEqual({
      ExpressionAttributeNames: { '#n0': 'status' },
    });
  });
});
