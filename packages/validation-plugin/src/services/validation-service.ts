/**
 * ValidationService — default implementation of {@link IValidationService}.
 *
 * Duck-types the schema via a structural `safeParse` interface (no hard Zod
 * dependency). Maps validator issues to the framework-standard
 * {@link ValidationIssue} shape.
 *
 * The error formatter is injected at construction time (hoisted by the plugin
 * so it is resolved once, not per-request).
 *
 * @module
 */
import type { Result } from '@hono-enterprise/common';
import type {
  IValidationService,
  MiddlewareFunction,
  ValidationIssue,
  ValidationTarget,
} from '@hono-enterprise/common';

import type { ValidationErrorFormatter } from '../formatters/error-formatter.ts';
import { createValidationMiddleware } from '../middleware/validation-middleware.ts';

/**
 * Minimal structural interface matching a subset of Zod's schema API.
 *
 * Consumers supply a Zod schema (or any object that exposes this shape)
 * without the validation plugin importing Zod directly.
 *
 * @since 0.1.0
 */
interface SafeParseSchema {
  /**
   * Safely parse and validate `data`.
   *
   * @param data - The value to validate
   * @returns An object with a `success` discriminant
   */
  safeParse(
    data: unknown,
  ):
    | { success: true; data: unknown }
    | {
      success: false;
      error: {
        /**
         * Validator-specific issue array. Each element is expected to carry
         * at least a `message` and optionally a `path` and `code`.
         */
        issues: readonly SafeParseIssue[];
      };
    };
}

/**
 * Structural shape expected from each validator issue element.
 *
 * @since 0.1.0
 */
interface SafeParseIssue {
  /** Dot-separated field path (e.g. `["address","zip"]`). */
  path?: readonly (string | number)[];
  /** Human-readable failure message. */
  message: string;
  /** Optional machine-readable error code. */
  code?: string;
}

// ---------------------------------------------------------------------------
// ValidationService
// ---------------------------------------------------------------------------

/**
 * Default validation service.
 *
 * The error formatter is resolved once at plugin construction time and passed
 * in here, avoiding per-request formatter resolution.
 *
 * @since 0.1.0
 */
export class ValidationService implements IValidationService {
  constructor(
    private readonly formatter: ValidationErrorFormatter,
  ) {}

  /**
   * Validate `data` against the given schema.
   *
   * The schema is expected to expose a `safeParse` method (Zod-compatible).
   * On success the parsed value is returned wrapped in `ok()`; on failure
   * the validator issues are mapped to {@link ValidationIssue} elements and
   * returned via `err()`.
   *
   * @typeParam T - The validated output type
   * @param schema - The schema object (must have `safeParse`)
   * @param data - The value to validate
   * @returns `Ok` with the parsed value or `Err` with the issues
   * @throws {TypeError} When the schema does not expose a `safeParse` method
   */
  validate<T>(schema: unknown, data: unknown): Result<T, readonly ValidationIssue[]> {
    const parsed = safeParseSchema(schema, data);

    if (parsed.success) {
      return { success: true, value: parsed.data as T };
    }

    const issues: ValidationIssue[] = parsed.error.issues.map((issue) => ({
      path: issue.path?.join('.') ?? '',
      message: issue.message,
      ...(issue.code !== undefined && { code: issue.code }),
    }));

    return { success: false, error: issues as readonly ValidationIssue[] };
  }

  /**
   * Creates validation middleware for the given request target.
   *
   * Uses the formatter resolved at plugin construction time.
   *
   * @param schema - The schema (Zod schema by default)
   * @param target - Which request part to validate
   * @returns The validation middleware
   */
  middleware(schema: unknown, target: ValidationTarget): MiddlewareFunction {
    return createValidationMiddleware(schema, target, this, this.formatter);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call `safeParse` on a duck-typed schema.
 *
 * @param schema - The schema object (expected to have `safeParse`)
 * @param data - The value to validate
 * @returns The safeParse result
 * @throws {TypeError} When the schema does not expose `safeParse`
 */
function safeParseSchema(
  schema: unknown,
  data: unknown,
):
  | { success: true; data: unknown }
  | { success: false; error: { issues: readonly SafeParseIssue[] } } {
  if (
    schema !== null &&
    typeof schema === 'object' &&
    typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  ) {
    const result = (schema as SafeParseSchema).safeParse(data);

    if (result.success) {
      return { success: true, data: result.data };
    }

    return { success: false, error: { issues: result.error.issues } };
  }

  throw new TypeError(
    'Schema must expose a `safeParse` method (Zod-compatible).',
  );
}
