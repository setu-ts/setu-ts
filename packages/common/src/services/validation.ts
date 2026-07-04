/**
 * Validation contract, fulfilled by the ValidationPlugin under
 * `CAPABILITIES.VALIDATION`.
 *
 * Schemas are `unknown` at this layer so `common` carries no validator
 * dependency; the validation plugin narrows them (Zod by default).
 *
 * @module
 */
import type { Result } from '../result.ts';
import type { MiddlewareFunction } from '../http.ts';

/**
 * The request part a validation middleware targets.
 *
 * @since 0.1.0
 */
export type ValidationTarget = 'body' | 'query' | 'params' | 'headers' | 'cookies';

/**
 * A single validation failure.
 *
 * @since 0.1.0
 */
export interface ValidationIssue {
  /** Dot-path of the offending field (e.g. `"address.zip"`). */
  readonly path: string;
  /** Human-readable description of the failure. */
  readonly message: string;
  /** Machine-readable failure code, when the validator provides one. */
  readonly code?: string;
}

/**
 * Data validation service.
 *
 * @example
 * ```typescript
 * const validation = ctx.services.get<IValidationService>(CAPABILITIES.VALIDATION);
 * const result = validation.validate<User>(UserSchema, ctx.state.get('rawBody'));
 * if (result.success) {
 *   save(result.value);
 * }
 * ```
 * @since 0.1.0
 */
export interface IValidationService {
  /**
   * Validates data against a schema.
   *
   * @typeParam T - The validated output type
   * @param schema - The schema (Zod schema by default)
   * @param data - The value to validate
   * @returns `Ok` with the parsed value, or `Err` with the issues
   */
  validate<T>(schema: unknown, data: unknown): Result<T, readonly ValidationIssue[]>;
  /**
   * Creates middleware that validates one part of the request and stores
   * the parsed value in request state.
   *
   * @param schema - The schema (Zod schema by default)
   * @param target - Which request part to validate
   * @returns The validation middleware
   */
  middleware(schema: unknown, target: ValidationTarget): MiddlewareFunction;
}
