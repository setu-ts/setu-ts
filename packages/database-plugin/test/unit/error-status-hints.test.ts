/**
 * Which of this package's errors carry an `HttpStatusHint`, and which
 * deliberately do not (M89b, X19-1).
 *
 * Table-driven on purpose: an eighth error class added later shows up here as
 * a missing row rather than silently inheriting — or silently missing — the
 * `501`. The split is a decision, not an oversight, and each row states which
 * side it is on and why.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { httpStatusHintOf } from '@setu-ts/common';

import {
  BigtableTransactionScopeError,
  CosmosConcurrentModificationError,
  CosmosTransactionScopeError,
  MongoTransactionUnavailableError,
  UnsupportedFilterOperatorError,
  UnsupportedQueryFeatureError,
  UnsupportedRawQueryError,
} from '../../src/errors.ts';

/**
 * A diagnostic of the shape masking exists to stop reaching a caller: it
 * quotes a statement and a bound parameter value (X12-3). Every branded row
 * asserts this string is absent from the served `detail`.
 */
const DIAGNOSTIC = "SELECT * FROM users WHERE ssn = $1 -- ['SECRET-123']";

/** The three query-shape refusals, which describe the caller's own query. */
const BRANDED: readonly { name: string; error: Error; detail: string }[] = [
  {
    name: 'UnsupportedQueryFeatureError',
    error: new UnsupportedQueryFeatureError('order-by', 'dynamodb', DIAGNOSTIC),
    detail: "Query feature 'order-by' is not supported by the 'dynamodb' database adapter.",
  },
  {
    name: 'UnsupportedFilterOperatorError (connector known)',
    error: new UnsupportedFilterOperatorError('contains', 'sqlite', DIAGNOSTIC),
    detail: "Filter operator 'contains' is not supported on the 'sqlite' connector.",
  },
  {
    name: 'UnsupportedFilterOperatorError (connector undetermined)',
    error: new UnsupportedFilterOperatorError('contains', undefined, DIAGNOSTIC),
    detail: "Filter operator 'contains' is not supported by the active database connector.",
  },
  {
    name: 'UnsupportedRawQueryError',
    error: new UnsupportedRawQueryError('mongodb', DIAGNOSTIC),
    detail: "Raw queries are not supported by the 'mongodb' database adapter.",
  },
];

/**
 * The transaction and concurrency errors, which keep the masked `500`.
 *
 * They may legitimately quote backend state, and a concurrency conflict is
 * transient and retryable rather than permanent — a different contract
 * statement from `501 Not Implemented`, deserving its own decision rather
 * than riding a status chosen for a different reason.
 */
const UNBRANDED: readonly { name: string; error: Error }[] = [
  {
    name: 'MongoTransactionUnavailableError',
    error: new MongoTransactionUnavailableError(DIAGNOSTIC),
  },
  { name: 'CosmosTransactionScopeError', error: new CosmosTransactionScopeError(DIAGNOSTIC) },
  {
    name: 'CosmosConcurrentModificationError',
    error: new CosmosConcurrentModificationError(DIAGNOSTIC),
  },
  { name: 'BigtableTransactionScopeError', error: new BigtableTransactionScopeError(DIAGNOSTIC) },
];

describe('database error status hints', () => {
  it('brands every query-shape refusal with 501 and a caller-safe detail', () => {
    for (const { name, error, detail } of BRANDED) {
      const hint = httpStatusHintOf(error);
      expect(hint, name).toBeDefined();
      expect(hint?.status, name).toBe(501);
      expect(hint?.title, name).toBe('Not Implemented');
      expect(hint?.detail, name).toBe(detail);
    }
  });

  it('composes the detail from framework-chosen fields, never the message', () => {
    // This is what makes the masking exemption safe rather than a widening:
    // the served sentence is built from the feature, operator, connector and
    // adapter names THIS package chose, so it cannot carry driver output.
    for (const { name, error } of BRANDED) {
      const detail = httpStatusHintOf(error)?.detail ?? '';
      expect(detail, name).not.toContain('SECRET');
      expect(detail, name).not.toContain('SELECT');
      expect(detail, name).not.toBe(error.message);
    }
  });

  it('keeps the full diagnostic on the message, for the log', () => {
    // The brand adds a caller-facing sentence; it must not replace the
    // operator-facing one, which `errorHandler` logs.
    for (const { name, error } of BRANDED) {
      expect(error.message, name).toBe(DIAGNOSTIC);
    }
  });

  it('brands every caller-caused query-shape feature', () => {
    // The nine `feature` values that describe the query or payload the
    // application just sent. Each is answered `501`.
    for (
      const feature of [
        'attribute-value',
        'composite-key',
        'cursor-pagination',
        'key',
        'nested-path',
        'offset',
        // Both spellings ship: dynamo says `orderBy`, bigtable says `order-by`.
        'order-by',
        'orderBy',
        'row-key',
        'update',
      ]
    ) {
      const hint = httpStatusHintOf(
        new UnsupportedQueryFeatureError(feature, 'dynamodb', DIAGNOSTIC),
      );
      expect(hint?.status, feature).toBe(501);
      expect(hint?.detail, feature).toBe(
        `Query feature '${feature}' is not supported by the 'dynamodb' database adapter.`,
      );
    }
  });

  it('does NOT brand a configuration or deployment feature', () => {
    // `UnsupportedQueryFeatureError` is shared by two kinds of refusal (M89b
    // code review, Qodo finding 3). These four describe the DEPLOYMENT, not
    // the request, so they keep the masked `500` that is correct for an
    // internal fault. Branding them made a blank `columnFamily` answer every
    // request `501 "Query feature 'mapping' is not supported …"` — a lie
    // twice over, since nothing about the query was unsupported.
    for (const feature of ['mapping', 'endpoint', 'date-encoding', 'transaction']) {
      const error = new UnsupportedQueryFeatureError(feature, 'bigtable', DIAGNOSTIC);
      expect(httpStatusHintOf(error), feature).toBeUndefined();
      // Still the same class with the same structured fields — only the
      // caller-facing status changes.
      expect(error.feature, feature).toBe(feature);
    }
  });

  it('does NOT brand a feature value nobody has classified', () => {
    // The safe default, and the reason the allowlist is an allowlist: a
    // feature name added by a future adapter keeps the masked `500` it would
    // have had, rather than silently inventing a caller-facing status for
    // what might be an internal fault.
    const error = new UnsupportedQueryFeatureError('some-future-feature', 'dynamodb', DIAGNOSTIC);

    expect(httpStatusHintOf(error)).toBeUndefined();
  });

  it('leaves the transaction and concurrency errors unbranded', () => {
    for (const { name, error } of UNBRANDED) {
      expect(httpStatusHintOf(error), name).toBeUndefined();
    }
  });

  it('keeps the structured fields the detail is composed from', () => {
    // The detail is derived rather than stored, so a consumer branching with
    // `instanceof` still reads the identifiers directly.
    expect(new UnsupportedQueryFeatureError('offset', 'bigtable', 'x').feature).toBe('offset');
    expect(new UnsupportedQueryFeatureError('offset', 'bigtable', 'x').adapter).toBe('bigtable');
    expect(new UnsupportedFilterOperatorError('contains', 'sqlite', 'x').operator).toBe('contains');
    expect(new UnsupportedFilterOperatorError('contains', 'sqlite', 'x').connector).toBe('sqlite');
    expect(new UnsupportedRawQueryError('cosmos', 'x').adapter).toBe('cosmos');
  });
});
