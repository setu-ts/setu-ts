/**
 * Expression building for the DynamoDB adapter — the one internal owner of
 * `ExpressionAttributeNames` / `ExpressionAttributeValues` for filters and
 * projections.
 *
 * **Every attribute name is aliased through a generated `#nN` placeholder,
 * unconditionally** — one alias per segment of a nested path
 * (`['profile','address','city']` → `#n0.#n1.#n2`) — and every value is a
 * `:vN` placeholder marshalled through {@linkcode marshalDynamoValue}. There
 * is deliberately NO maintained reserved-word list: DynamoDB's reserved list
 * is ~570 words and grows between releases (M80 plan §1A F1 measured that a
 * raw `status` is a `ValidationException`), so a list is a defect waiting for
 * the next AWS release and unconditional aliasing is the only stable rule.
 *
 * The seven portable `FilterOperator`s translate natively — `contains` and
 * `in` need no escaping because they are native operators over an unparsed
 * value (unlike SQL `LIKE`, M70b X12-1). An empty `in` list emits a
 * **match-nothing** condition rather than `IN ()`, which is a server-side
 * syntax error (§1A F5); the emitted form compares two statically distinct
 * value placeholders, measured against the live emulator to match zero items
 * (`:v0 = :v1` with `BOOL` `true`/`false`). An empty `and` group is the
 * boolean identity — no `FilterExpression` is emitted at all — and the
 * identities compose algebraically (`and` absorbs match-all children and
 * short-circuits on match-nothing; `or` mirrors it), so no dropped child ever
 * leaves an orphaned placeholder behind: DynamoDB rejects a value registered
 * in `ExpressionAttributeValues` but unused in the expressions, so aliases and
 * values are registered only while rendering the SURVIVING conditions.
 *
 * A `Date` in a comparison converts to the encoding the entity's mapping
 * declares for that attribute (`dateAttributes: { createdAt: 'iso' |
 * 'epochMs' }`); with no declaration the filter is refused by name — DynamoDB
 * has no date type (§1A F7), so the adapter never guesses how a stored
 * timestamp is encoded.
 *
 * @module
 */
import type { FilterComparison, FilterExpression } from '@setu-ts/common';
import type { DynamoAttributeMap, DynamoAttributeValue } from './dynamo-client-types.ts';
import type { DynamoDateEncoding } from './dynamo-mapping.ts';
import { marshalDynamoValue } from './dynamo-marshal.ts';
import { UnsupportedQueryFeatureError } from '../../errors.ts';

/** The adapter name every expression-builder refusal carries. */
const ADAPTER = 'dynamodb';

/** The ordered-comparison operators mapped onto DynamoDB comparator symbols. */
const COMPARATORS: Readonly<Record<'gt' | 'gte' | 'lt' | 'lte', string>> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/**
 * The symbolic result of translating a portable filter, before any alias or
 * value is registered.
 *
 * Translation is a pure pass: it decides the SHAPE of the emitted expression
 * (a concrete condition, the match-all identity, or the match-nothing
 * contradiction) without touching the builder, and only the SURVIVING
 * conditions are rendered afterwards. That two-pass split is what keeps
 * `ExpressionAttributeNames`/`Values` free of orphans when algebraic
 * simplification drops a child — an unused placeholder is a server-side
 * `ValidationException`.
 */
type TranslatedFilter =
  | { readonly kind: 'match-all' }
  | { readonly kind: 'match-nothing' }
  | {
    readonly kind: 'condition';
    /** Renders the condition text, registering aliases and values as it goes. */
    readonly render: (builder: DynamoExpressionBuilder) => string;
  };

/** The boolean identity: matches every item, so no filter need be emitted. */
const MATCH_ALL: TranslatedFilter = { kind: 'match-all' };

/**
 * The match-nothing contradiction, matching no item — the semantics M79
 * assigns to an empty `in` list and an empty `or` group.
 */
const MATCH_NOTHING: TranslatedFilter = { kind: 'match-nothing' };

/**
 * The accumulator one DynamoDB command reads its expression attributes from.
 *
 * Aliases are assigned in first-seen order, so a given query always produces
 * the same placeholders and the emitted expressions are assertable. A path
 * segment seen twice — as a whole field and inside a nested path, say —
 * reuses the alias it already has, which is safe because the alias map is
 * name → attribute.
 *
 * @since 0.1.0
 */
export interface DynamoExpressionBuilder {
  /**
   * Aliases an attribute path, one `#nN` placeholder per segment.
   *
   * @param field - The portable field: a flat attribute name, or a nested
   *   path whose segments each alias separately
   * @returns The aliased path, e.g. `#n0` or `#n0.#n1.#n2`
   * @throws {UnsupportedQueryFeatureError} When a path array carries no
   *   segments — the Mongo adapter refuses the same caller bug by name
   */
  aliasPath(field: string | readonly string[]): string;

  /**
   * Marshals one JavaScript value and registers it under the next `:vN`
   * placeholder.
   *
   * @param value - The JS value to marshal
   * @param dateEncoding - The encoding declared for the attribute the value
   *   belongs to, honoured when the value is a `Date`
   * @returns The placeholder, e.g. `:v0`
   * @throws {UnsupportedQueryFeatureError} When the value has no lossless
   *   DynamoDB representation (per {@linkcode marshalDynamoValue})
   */
  addValue(value: unknown, dateEncoding?: DynamoDateEncoding): string;

  /**
   * Folds the accumulated aliases and values into the command's expression
   * attributes, omitting either member when empty (the command shapes carry
   * both as optional).
   *
   * @returns The `ExpressionAttributeNames` / `ExpressionAttributeValues`
   *   members, each present only when non-empty
   */
  expressionAttributes(): {
    ExpressionAttributeNames?: Readonly<Record<string, string>>;
    ExpressionAttributeValues?: DynamoAttributeMap;
  };
}

/**
 * Creates the alias/value accumulator for one DynamoDB command.
 *
 * One builder per command: placeholders are numbered from zero in first-seen
 * order, so aliases are deterministic within a command and independent across
 * commands.
 *
 * @returns A fresh builder with no aliases and no values
 * @since 0.1.0
 */
export function createDynamoExpressionBuilder(): DynamoExpressionBuilder {
  const names: Record<string, string> = {};
  const values: Record<string, DynamoAttributeValue> = {};
  const segmentAliases = new Map<string, string>();
  let nameCount = 0;
  let valueCount = 0;

  const builder: DynamoExpressionBuilder = {
    aliasPath: (field: string | readonly string[]): string => {
      const path = Array.isArray(field) ? field : [field];
      if (path.length === 0) {
        throw new UnsupportedQueryFeatureError(
          'nested-path',
          ADAPTER,
          'DynamoDB adapter refused an empty path — a path array must carry at least one segment.',
        );
      }
      return path.map((segment) => {
        const existing = segmentAliases.get(segment);
        if (existing !== undefined) return existing;
        const placeholder = `#n${nameCount}`;
        nameCount += 1;
        segmentAliases.set(segment, placeholder);
        names[placeholder] = segment;
        return placeholder;
      }).join('.');
    },

    addValue: (value: unknown, dateEncoding?: DynamoDateEncoding): string => {
      const placeholder = `:v${valueCount}`;
      valueCount += 1;
      values[placeholder] = marshalDynamoValue(value, dateEncoding);
      return placeholder;
    },

    expressionAttributes: () => ({
      ...(nameCount > 0 ? { ExpressionAttributeNames: { ...names } } : {}),
      ...(valueCount > 0 ? { ExpressionAttributeValues: { ...values } } : {}),
    }),
  };
  return builder;
}

/**
 * Renders a comparison, registering its path alias and value placeholder(s).
 *
 * The declared encoding is resolved from `dateAttributes` by attribute name;
 * a nested path array has no declaration to read (the mapping's
 * `dateAttributes` keys are flat attribute names — the same stance
 * `dynamo-marshal.ts` records), so a `Date` there is refused. The refusal
 * happens here — where the attribute is known — rather than inside the
 * marshaller, so the error names the attribute.
 *
 * @param builder - The command's accumulator
 * @param field - The comparison's field
 * @param value - The comparison's value
 * @param dateAttributes - The entity mapping's declared date encodings
 * @returns The marshalled value's placeholder
 * @throws {UnsupportedQueryFeatureError} When the value is a `Date` and the
 *   attribute has no declared encoding
 */
function comparisonValue(
  builder: DynamoExpressionBuilder,
  field: string | readonly string[],
  value: unknown,
  dateAttributes: Readonly<Record<string, DynamoDateEncoding>>,
): string {
  const dateEncoding = typeof field === 'string' ? dateAttributes[field] : undefined;
  if (value instanceof Date && dateEncoding === undefined) {
    const path = Array.isArray(field) ? field.join('.') : field;
    throw new UnsupportedQueryFeatureError(
      'date-encoding',
      ADAPTER,
      `A Date filter on attribute '${path}' requires a declared encoding; DynamoDB has no date ` +
        `type, so declare the attribute under the mapping's 'dateAttributes' option ` +
        `('iso' | 'epochMs').`,
    );
  }
  return builder.addValue(value, dateEncoding);
}

/**
 * Renders one comparison condition.
 *
 * @param comparison - The comparison to render
 * @param builder - The command's accumulator
 * @param dateAttributes - The entity mapping's declared date encodings
 * @returns The condition text, e.g. `#n0 > :v0` or `contains(#n0, :v0)`
 */
function renderComparison(
  comparison: FilterComparison,
  builder: DynamoExpressionBuilder,
  dateAttributes: Readonly<Record<string, DynamoDateEncoding>>,
): string {
  const path = builder.aliasPath(comparison.field);
  switch (comparison.operator) {
    case 'eq':
      return `${path} = ${
        comparisonValue(builder, comparison.field, comparison.value, dateAttributes)
      }`;
    case 'contains':
      // A native operator over an unparsed value — no escaping, unlike SQL
      // `LIKE` (M70b X12-1); the value travels verbatim in its placeholder.
      return `contains(${path}, ${
        comparisonValue(builder, comparison.field, comparison.value, dateAttributes)
      })`;
    case 'in':
      return `${path} IN (${
        comparison.value
          .map((element) => comparisonValue(builder, comparison.field, element, dateAttributes))
          .join(', ')
      })`;
    default:
      return `${path} ${COMPARATORS[comparison.operator]} ${
        comparisonValue(builder, comparison.field, comparison.value, dateAttributes)
      }`;
  }
}

/**
 * Joins rendered conditions under one logical operator, parenthesizing each
 * operand.
 *
 * Parenthesization is load-bearing, not cosmetic: DynamoDB binds `AND`
 * tighter than `OR`, so an `or` nested inside an `and` — the shape a keyset
 * predicate conjoined with a caller filter takes — would silently reorder
 * without the parens. A single surviving child is returned unchanged: a
 * group with one condition is that condition.
 *
 * @param conditions - The surviving child conditions
 * @param separator - `' AND '` or `' OR '`
 * @returns The joined condition text
 */
function joinConditions(
  conditions: readonly ((builder: DynamoExpressionBuilder) => string)[],
  separator: ' AND ' | ' OR ',
): (builder: DynamoExpressionBuilder) => string {
  if (conditions.length === 1 && conditions[0] !== undefined) {
    return conditions[0];
  }
  return (builder) => conditions.map((child) => `(${child(builder)})`).join(separator);
}

/**
 * Translates a portable filter tree into its symbolic DynamoDB form — a pure
 * pass that registers nothing.
 *
 * The boolean identities compose algebraically: an empty `and` group is
 * match-all and an empty `or` group is match-nothing (the same semantics the
 * other adapters give them — Mongo via `$nor: [{}]`, Drizzle via its
 * tautology/contradiction pair); `and` absorbs match-all children and
 * short-circuits on a match-nothing child, and `or` mirrors it. An empty
 * `in` list is the match-nothing contradiction — `IN ()` is a server-side
 * syntax error (§1A F5).
 *
 * @param expression - The portable expression to translate
 * @param dateAttributes - The entity mapping's declared date encodings
 * @returns The symbolic result, ready for rendering through
 *   {@linkcode translateDynamoFilter}
 */
function translateFilter(
  expression: FilterExpression,
  dateAttributes: Readonly<Record<string, DynamoDateEncoding>>,
): TranslatedFilter {
  if (expression.type !== 'comparison') {
    if (expression.filters.length === 0) {
      return expression.type === 'and' ? MATCH_ALL : MATCH_NOTHING;
    }
    const children = expression.filters.map((child) => translateFilter(child, dateAttributes));
    if (expression.type === 'and') {
      if (children.some((child) => child.kind === 'match-nothing')) return MATCH_NOTHING;
      const conditions = children.filter((child): child is {
        kind: 'condition';
        render: (builder: DynamoExpressionBuilder) => string;
      } => child.kind === 'condition');
      if (conditions.length === 0) return MATCH_ALL;
      return {
        kind: 'condition',
        render: joinConditions(conditions.map((child) => child.render), ' AND '),
      };
    }
    if (children.some((child) => child.kind === 'match-all')) return MATCH_ALL;
    const conditions = children.filter((child): child is {
      kind: 'condition';
      render: (builder: DynamoExpressionBuilder) => string;
    } => child.kind === 'condition');
    if (conditions.length === 0) return MATCH_NOTHING;
    return {
      kind: 'condition',
      render: joinConditions(conditions.map((child) => child.render), ' OR '),
    };
  }
  // An empty `in` never becomes a condition — `IN ()` is invalid syntax, and
  // translating it as the contradiction lets an enclosing group absorb it
  // algebraically instead of emitting a dead operand.
  if (expression.operator === 'in' && expression.value.length === 0) {
    return MATCH_NOTHING;
  }
  return {
    kind: 'condition',
    render: (builder) => renderComparison(expression, builder, dateAttributes),
  };
}

/**
 * Renders the match-nothing contradiction through the builder.
 *
 * The form is measured, not assumed: DynamoDB has no literal `false`, so the
 * contradiction compares two value placeholders carrying statically distinct
 * values (`BOOL` `true` vs `false`). Driven against the live
 * `amazon/dynamodb-local` emulator, the emitted condition matched zero items
 * on a two-item table — while the tempting self-comparison `#n0 <> #n0` was
 * rejected outright ("The first operand must be distinct from the remaining
 * operands"), which is why the attribute-free form is the one emitted.
 *
 * @param builder - The command's accumulator
 * @returns The contradiction text, e.g. `:v0 = :v1`
 */
function matchNothing(builder: DynamoExpressionBuilder): string {
  const truthy = builder.addValue(true);
  const falsy = builder.addValue(false);
  return `${truthy} = ${falsy}`;
}

/**
 * Translates a portable filter onto a DynamoDB condition expression,
 * registering the surviving conditions' aliases and values on the builder.
 *
 * Translation is two-pass: the tree is simplified symbolically first, and
 * only the conditions that survive are rendered — so a dropped child never
 * leaves a placeholder that the server would reject as unused.
 *
 * @param filter - The portable filter tree
 * @param builder - The command's accumulator
 * @param dateAttributes - The entity mapping's declared date encodings
 * @returns The `FilterExpression` text, or `undefined` when the filter is
 *   the match-all identity (an empty `and` group) and no filter need be sent
 * @throws {UnsupportedQueryFeatureError} When a path array is empty, or a
 *   `Date` filter names an attribute with no declared encoding
 * @since 0.1.0
 */
export function translateDynamoFilter(
  filter: FilterExpression,
  builder: DynamoExpressionBuilder,
  dateAttributes: Readonly<Record<string, DynamoDateEncoding>>,
): string | undefined {
  const translated = translateFilter(filter, dateAttributes);
  if (translated.kind === 'match-all') return undefined;
  if (translated.kind === 'match-nothing') return matchNothing(builder);
  return translated.render(builder);
}

/**
 * Builds a DynamoDB projection expression from a query's `select` list,
 * aliasing every field name.
 *
 * Aliasing is unconditional here too — a projected field named `status` is as
 * reserved as a filtered one. An empty select projects nothing: the command
 * omits `ProjectionExpression` and DynamoDB returns every attribute by
 * default.
 *
 * @param select - The projected field names
 * @param builder - The command's accumulator
 * @returns The `ProjectionExpression` text, e.g. `#n0, #n1`, or `undefined`
 *   when nothing is projected
 * @since 0.1.0
 */
export function buildDynamoProjection(
  select: readonly string[],
  builder: DynamoExpressionBuilder,
): string | undefined {
  if (select.length === 0) return undefined;
  return select.map((field) => builder.aliasPath(field)).join(', ');
}
