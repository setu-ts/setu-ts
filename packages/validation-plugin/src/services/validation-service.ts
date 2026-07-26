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
    private readonly schemaPolicy: SchemaPolicy = {},
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
    // Applied once here, at middleware-construction (registration) time, so
    // both entry points — `service.middleware(...)` and the `validateBody(...)`
    // family, which delegate to it — honor the configured policy identically.
    return createValidationMiddleware(
      applySchemaPolicy(schema, this.schemaPolicy),
      target,
      this,
      this.formatter,
    );
  }
}

/**
 * Unknown-property policy resolved from the plugin's `whitelist` /
 * `forbidNonWhitelisted` options.
 *
 * @since 0.1.0
 */
export interface SchemaPolicy {
  /** Strip properties the schema does not declare. */
  readonly whitelist?: boolean;
  /** Reject payloads carrying properties the schema does not declare. */
  readonly forbidNonWhitelisted?: boolean;
}

/**
 * Structural shape of the unknown-key configuration a Zod-style object schema
 * exposes. Both methods return a NEW schema; neither mutates the original.
 */
interface UnknownKeyConfigurable {
  strip?: () => unknown;
  strict?: () => unknown;
}

/**
 * Applies the unknown-property policy to a schema, once, at registration time.
 *
 * `forbidNonWhitelisted` wins over `whitelist` when both are set: rejecting is
 * strictly stronger than stripping. A schema that does not expose the matching
 * method (a non-object schema, or a validator other than Zod) is returned
 * unchanged — the policy is best-effort by construction, since schemas are
 * duck-typed through `safeParse`.
 *
 * @param schema - The schema to configure
 * @param policy - The resolved unknown-property policy
 * @returns The configured schema, or the original when it cannot be configured
 * @since 0.1.0
 */
export function applySchemaPolicy(schema: unknown, policy: SchemaPolicy): unknown {
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }
  const configurable = schema as UnknownKeyConfigurable;
  if (policy.forbidNonWhitelisted === true && typeof configurable.strict === 'function') {
    return configurable.strict();
  }
  if (policy.whitelist === true && typeof configurable.strip === 'function') {
    return configurable.strip();
  }
  return schema;
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
