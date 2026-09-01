/**
 * Bidirectional `AttributeValue` ⇄ JavaScript marshalling for the DynamoDB
 * adapter.
 *
 * The adapter owns marshalling deliberately (M80 plan §3.2 — the SDK's
 * `DocumentClient` is NOT used): automatic marshalling would hide both of the
 * measured hazards this module exists for. A JS `Date` is rejected outright by
 * DynamoDB (§1A F7), so the encoding a timestamp is stored under must be
 * declared, not guessed; and an `N` is an arbitrary-precision decimal whose
 * conversion through `Number()` silently degrades a 38-digit value to `1e+38`
 * (§1A N1).
 *
 * Read side (§3.15): `S`→string, `BOOL`→boolean, `NULL`→null, `B`→bytes and
 * `M`/`L` recursively, with `N`→number **only when the round trip is exact**
 * (`String(Number(n)) === n`) — otherwise the decimal string is preserved, so
 * the stored datum stays recoverable instead of quietly corrupted.
 *
 * Write side: the JSON scalars marshal to their single-member `AttributeValue`
 * forms, a `Date` marshals to the encoding the entity's mapping declares for
 * that attribute (`'iso'` → `S`, `'epochMs'` → `N`), and anything DynamoDB
 * cannot represent losslessly — `undefined` inside a list, a non-finite
 * number, a `bigint`, a `Map`, a non-`Uint8Array` view — is refused by name
 * (the package's `UnsupportedQueryFeatureError`) rather than silently
 * distorted.
 *
 * @module
 */
import type { DynamoAttributeMap, DynamoAttributeValue } from './dynamo-client-types.ts';
import type { DynamoDateEncoding } from './dynamo-mapping.ts';
import { UnsupportedQueryFeatureError } from '../../errors.ts';

/** The adapter name every marshaller refusal carries. */
const ADAPTER = 'dynamodb';

/**
 * Renders an attribute path for a refusal message.
 *
 * A value marshalled through {@linkcode marshalDynamoValue} has no attribute
 * context, so the suffix is empty; a value marshalled as part of an item
 * names its attribute (and, when nested, the full path into it).
 *
 * @param path - The attribute path, `''` at the value root
 * @returns `' at <path>'`, or `''` when there is no path to name
 */
function at(path: string): string {
  return path === '' ? '' : ` at '${path}'`;
}

/**
 * Decides whether an object marshals to a DynamoDB map (`M`) losslessly.
 *
 * Only plain records — object-literal shapes and `Object.create(null)` —
 * have a lossless `M` form. A `Map`, a `Set` or a class instance would
 * marshal to an empty or fabricated map under `Object.entries`, silently
 * dropping the caller's data, so those are refused instead.
 *
 * @param value - The object being marshalled
 * @returns `true` when the object is a plain record
 */
function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Assigns an attribute as an OWN property, never through a setter.
 *
 * A DynamoDB attribute may legitimately be named `__proto__` — the server
 * accepts and returns one (measured) — and a plain `obj[key] = value`
 * assignment for that key is **runtime-dependent**: on Node it invokes
 * `Object.prototype.__proto__`, silently dropping the attribute and replacing
 * the object's prototype, while on Deno it creates an own property. So the
 * naive form is a prototype-pollution vector for the Node and Bun consumers
 * this package publishes to, and no test running on Deno can observe it.
 * `defineProperty` behaves identically on every runtime.
 *
 * @param target - The record being populated
 * @param key - The attribute name, which is caller/remote data
 * @param value - The value to store
 */
function defineAttribute(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Marshals one JavaScript value to its `AttributeValue` form (the internal
 * recursive half of {@linkcode marshalDynamoValue}).
 *
 * @param value - The JS value to marshal
 * @param dateEncoding - The encoding declared for THIS attribute, when the
 *   value is a `Date`; deliberately not threaded into nested members, because
 *   the mapping's `dateAttributes` keys are flat attribute names and a nested
 *   `Date` has no declaration to read
 * @param path - The attribute path carried into refusal messages
 * @returns The DynamoDB attribute value
 * @throws {UnsupportedQueryFeatureError} When the value has no lossless
 *   DynamoDB representation — every case is named with the attribute path
 */
function marshalValue(
  value: unknown,
  dateEncoding: DynamoDateEncoding | undefined,
  path: string,
): DynamoAttributeValue {
  if (value === null) return { NULL: true };
  switch (typeof value) {
    case 'string':
      return { S: value };
    case 'number':
      // DynamoDB `N` is an arbitrary-precision DECIMAL: NaN and the
      // infinities have no representation, and writing them would surface as
      // a server-side ValidationException naming nothing.
      if (!Number.isFinite(value)) {
        throw new UnsupportedQueryFeatureError(
          'attribute-value',
          ADAPTER,
          `The number${
            at(path)
          } is not a finite decimal; NaN and Infinity have no DynamoDB N representation.`,
        );
      }
      return { N: String(value) };
    case 'boolean':
      return { BOOL: value };
    case 'object':
      return marshalObjectValue(value, dateEncoding, path);
    case 'undefined':
      throw new UnsupportedQueryFeatureError(
        'attribute-value',
        ADAPTER,
        `DynamoDB cannot store 'undefined'${at(path)}; omit the attribute or convert the value.`,
      );
    default:
      // Only 'bigint', 'function' and 'symbol' reach here.
      throw new UnsupportedQueryFeatureError(
        'attribute-value',
        ADAPTER,
        `Unsupported JS type '${typeof value}'${at(path)} for a DynamoDB attribute value.`,
      );
  }
}

/**
 * Marshals one JavaScript object-shaped value — a `Date`, binary view, list
 * or record — to its `AttributeValue` form.
 *
 * @param value - The object-shaped JS value to marshal
 * @param dateEncoding - The encoding declared for this attribute, honoured
 *   only when the value IS a `Date` at this exact path
 * @param path - The attribute path carried into refusal messages
 * @returns The DynamoDB attribute value
 * @throws {UnsupportedQueryFeatureError} Per {@linkcode marshalValue}, plus
 *   the declared-encoding refusal for an undeclared `Date` and the plain-record
 *   refusal for a `Map`/`Set`/class instance
 */
function marshalObjectValue(
  value: object,
  dateEncoding: DynamoDateEncoding | undefined,
  path: string,
): DynamoAttributeValue {
  if (value instanceof Date) {
    // An invalid Date must be refused HERE, by name. `toISOString()` throws a
    // bare `RangeError: Invalid time value` that names no attribute, and
    // `getTime()` yields `NaN`, which would be written as the DynamoDB number
    // `{ N: 'NaN' }` and rejected by the server with a message naming neither
    // the entity nor the attribute (both measured).
    if (Number.isNaN(value.getTime())) {
      throw new UnsupportedQueryFeatureError(
        'attribute-value',
        ADAPTER,
        `The Date${at(path)} is invalid (its time value is NaN), so it has no DynamoDB ` +
          `representation under either declared encoding.`,
      );
    }
    if (dateEncoding === 'iso') return { S: value.toISOString() };
    if (dateEncoding === 'epochMs') return { N: String(value.getTime()) };
    // DynamoDB has no date type (§1A F7), so the encoding is a declaration,
    // never a guess: storing a string where the reader expects epoch
    // milliseconds (or vice versa) would poison every ordered comparison
    // against the stored values.
    throw new UnsupportedQueryFeatureError(
      'date-encoding',
      ADAPTER,
      `A JS Date${
        at(path)
      } requires a declared DynamoDB encoding; DynamoDB has no date type, so declare the attribute under the mapping's 'dateAttributes' option ('iso' | 'epochMs').`,
    );
  }
  if (value instanceof Uint8Array) return { B: value };
  if (ArrayBuffer.isView(value)) {
    throw new UnsupportedQueryFeatureError(
      'attribute-value',
      ADAPTER,
      `Only Uint8Array marshals to a DynamoDB binary (B) value${
        at(path)
      }; received '${value.constructor.name}'.`,
    );
  }
  if (Array.isArray(value)) {
    return {
      L: value.map((element, index) => marshalValue(element, undefined, `${path}[${index}]`)),
    };
  }
  if (!isPlainRecord(value)) {
    throw new UnsupportedQueryFeatureError(
      'attribute-value',
      ADAPTER,
      `Only plain objects marshal to a DynamoDB map (M) value${
        at(path)
      }; received '${value.constructor.name}'.`,
    );
  }
  const members: Record<string, DynamoAttributeValue> = {};
  for (const [key, member] of Object.entries(value)) {
    // JSON semantics: an undefined member stores nothing, so the row read
    // back carries no key — never an `undefined` leaking through the wire.
    if (member === undefined) continue;
    defineAttribute(
      members as Record<string, unknown>,
      key,
      marshalValue(member, undefined, path === '' ? key : `${path}.${key}`),
    );
  }
  return { M: members };
}

/**
 * Marshals one JavaScript value to its DynamoDB `AttributeValue` form.
 *
 * The JSON scalars map to their single-member forms (`S`/`N`/`BOOL`/`NULL`/
 * `B`), a `Date` maps to the declared encoding, and composites recurse:
 * a plain object becomes `M` and an array becomes `L`. This is the primitive
 * the expression builder marshals filter values with, so it takes the
 * attribute's declared date encoding rather than a whole mapping.
 *
 * @param value - The JS value to marshal
 * @param dateEncoding - The encoding declared for the attribute this value
 *   belongs to, when that value is a `Date` (`'iso'` → `S` of the ISO-8601
 *   string, `'epochMs'` → `N` of epoch milliseconds)
 * @returns The DynamoDB attribute value
 * @throws {UnsupportedQueryFeatureError} When the value has no lossless
 *   DynamoDB representation: a `Date` without a declared encoding, `undefined`,
 *   a non-finite number, a `bigint`, a function, a symbol, a non-`Uint8Array`
 *   typed-array view, or a `Map`/`Set`/class instance
 * @since 0.1.0
 */
export function marshalDynamoValue(
  value: unknown,
  dateEncoding?: DynamoDateEncoding,
): DynamoAttributeValue {
  return marshalValue(value, dateEncoding, '');
}

/**
 * Marshals a repository row to a DynamoDB item.
 *
 * Attributes whose value is `undefined` are omitted — DynamoDB has no
 * undefined, and an absent attribute is the honest representation. A `Date`
 * attribute marshals to the encoding declared for it under `dateAttributes`;
 * a `Date` with no declaration is refused by name (§3.14 — the adapter cannot
 * know how the stored value is encoded, so it never guesses).
 *
 * @param row - The repository row to persist
 * @param dateAttributes - The entity mapping's declared date encodings,
 *   keyed by attribute name
 * @returns The DynamoDB item
 * @throws {UnsupportedQueryFeatureError} Per {@linkcode marshalDynamoValue},
 *   including the undeclared-`Date` refusal naming the attribute
 * @since 0.1.0
 */
export function marshalDynamoItem(
  row: Record<string, unknown>,
  dateAttributes?: Readonly<Record<string, DynamoDateEncoding>>,
): DynamoAttributeMap {
  const item: Record<string, DynamoAttributeValue> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    defineAttribute(
      item as Record<string, unknown>,
      key,
      marshalValue(value, dateAttributes?.[key], key),
    );
  }
  return item;
}

/**
 * Unmarshals one DynamoDB `AttributeValue` to its JavaScript form (§3.15).
 *
 * `N` becomes a number **only when the round trip is exact**
 * (`String(Number(n)) === n`); otherwise the arbitrary-precision decimal is
 * preserved as its string, because §1A N1 measured that a 38-digit value
 * silently degrades to `1e+38` through `Number()`. The set forms (`SS`/`NS`/
 * `BS`) unmarshal to arrays, with `NS` applying the same exactness rule
 * element-wise.
 *
 * @param value - The DynamoDB attribute value
 * @returns The JS value
 * @throws {UnsupportedQueryFeatureError} When the value carries no type
 *   member at all — DynamoDB never produces one, so reading it as `undefined`
 *   would silently corrupt a row
 * @since 0.1.0
 */
export function unmarshalDynamoValue(value: DynamoAttributeValue): unknown {
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) {
    const asNumber = Number(value.N);
    // The exactness test rather than a magnitude test, because it is the
    // property that actually matters: '42' round-trips, '007' and the
    // 38-digit decimal do not — and the string keeps those recoverable.
    return String(asNumber) === value.N ? asNumber : value.N;
  }
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL !== undefined) return null;
  if (value.B !== undefined) return value.B;
  if (value.M !== undefined) return unmarshalDynamoItem(value.M);
  if (value.L !== undefined) return value.L.map(unmarshalDynamoValue);
  if (value.SS !== undefined) return [...value.SS];
  if (value.NS !== undefined) {
    return value.NS.map((number) => unmarshalDynamoValue({ N: number }));
  }
  if (value.BS !== undefined) return [...value.BS];
  throw new UnsupportedQueryFeatureError(
    'attribute-value',
    ADAPTER,
    'Cannot unmarshal a DynamoDB AttributeValue with no type member.',
  );
}

/**
 * Unmarshals a DynamoDB item to a repository row.
 *
 * Every attribute is unmarshalled through {@linkcode unmarshalDynamoValue},
 * so nested maps and lists recurse and the lossy-`N` rule applies at every
 * depth.
 *
 * @param item - The DynamoDB item read back from a response
 * @returns The repository row
 * @since 0.1.0
 */
export function unmarshalDynamoItem(item: DynamoAttributeMap): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    defineAttribute(row, key, unmarshalDynamoValue(value));
  }
  return row;
}
