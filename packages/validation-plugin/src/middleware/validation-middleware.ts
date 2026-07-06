/**
 * Validation middleware — extracts data from the HTTP request, validates it
 * against a schema, and either continues the pipeline or short-circuits with
 * a 400 response.
 *
 * Exports both the core factory {@linkcode createValidationMiddleware} and
 * convenience helpers {@linkcode validateBody}, {@linkcode validateQuery},
 * {@linkcode validateParams}, {@linkcode validateHeaders},
 * {@linkcode validateCookies}.
 *
 * @module
 */
import type {
  IRequestContext,
  IValidationService,
  MiddlewareFunction,
  ValidationIssue,
  ValidationTarget,
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

import type { ValidationErrorFormatter } from '../formatters/error-formatter.ts';

// ---------------------------------------------------------------------------
// Target extraction
// ---------------------------------------------------------------------------

/** Private sentinel for JSON parse failures — never leaks outside this module. */
class JsonParseError extends Error {}

/**
 * Extract raw data from the request based on the target.
 *
 * @param ctx - The request context
 * @param target - Which request part to extract
 * @returns The extracted data
 * @throws {JsonParseError} When body JSON is invalid
 */
async function extractTarget(
  ctx: IRequestContext,
  target: ValidationTarget,
): Promise<unknown> {
  switch (target) {
    case 'body': {
      try {
        return await ctx.request.json();
      } catch {
        throw new JsonParseError();
      }
    }

    case 'query':
      return ctx.query;

    case 'params':
      return ctx.params;

    case 'headers': {
      const record: Record<string, string> = {};
      for (const [key, value] of ctx.request.headers.entries()) {
        record[key] = value;
      }
      return record;
    }

    case 'cookies': {
      const cookieHeader = ctx.request.headers.get('cookie');
      if (!cookieHeader) {
        return {};
      }
      const record: Record<string, string> = {};
      for (const pair of cookieHeader.split(';')) {
        const trimmed = pair.trim();
        if (!trimmed) {
          continue;
        }
        const eqIndex = trimmed.indexOf('=');
        const rawValue = eqIndex === -1 ? '' : trimmed.slice(eqIndex + 1);
        let value = rawValue;
        try {
          value = decodeURIComponent(rawValue);
        } catch { /* keep raw when malformed */ }
        record[eqIndex === -1 ? trimmed : trimmed.slice(0, eqIndex)] = value;
      }
      return record;
    }

    default:
      throw new TypeError(`Unknown validation target: "${target}"`);
  }
}

// ---------------------------------------------------------------------------
// Core factory
// ---------------------------------------------------------------------------

/**
 * Create a validation middleware function.
 *
 * The middleware extracts data from the specified request target, validates it
 * via the provided validation service, and either stores the validated value
 * in `ctx.state` and continues the pipeline, or short-circuits with a 400
 * response containing the formatted validation errors.
 *
 * @param schema - The schema (must expose `safeParse`)
 * @param target - Which request part to validate (`'body'`, `'query'`, etc.)
 * @param service - The validation service to use
 * @param formatter - Error formatter (resolved once at registration time)
 * @returns A middleware function
 */
export function createValidationMiddleware(
  schema: unknown,
  target: ValidationTarget,
  service: IValidationService,
  formatter: ValidationErrorFormatter,
): MiddlewareFunction {
  return async (ctx, next) => {
    let rawData: unknown;
    try {
      rawData = await extractTarget(ctx, target);
    } catch (e) {
      if (e instanceof JsonParseError) {
        const issues: readonly ValidationIssue[] = [
          { path: '', message: 'Invalid JSON in request body' },
        ];
        return ctx.response.status(400).json(formatter(issues, ctx));
      }
      throw e;
    }

    const result = service.validate(schema, rawData);

    if (result.success) {
      ctx.state.set(`validated:${target}`, result.value);
      await next();
      return;
    }

    return ctx.response.status(400).json(formatter(result.error, ctx));
  };
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Validate the request body against a schema.
 *
 * Delegates to the configured {@linkcode IValidationService} so the error
 * format matches the plugin registration (e.g. `'rfc7807'`).
 *
 * @param schema - The schema (must expose `safeParse`)
 * @returns A middleware function
 */
export function validateBody(schema: unknown): MiddlewareFunction {
  return bindHelper('body', schema);
}

/**
 * Validate query parameters against a schema.
 *
 * Delegates to the configured {@linkcode IValidationService} so the error
 * format matches the plugin registration.
 *
 * @param schema - The schema (must expose `safeParse`)
 * @returns A middleware function
 */
export function validateQuery(schema: unknown): MiddlewareFunction {
  return bindHelper('query', schema);
}

/**
 * Validate path parameters against a schema.
 *
 * Delegates to the configured {@linkcode IValidationService} so the error
 * format matches the plugin registration.
 *
 * @param schema - The schema (must expose `safeParse`)
 * @returns A middleware function
 */
export function validateParams(schema: unknown): MiddlewareFunction {
  return bindHelper('params', schema);
}

/**
 * Validate request headers against a schema.
 *
 * Delegates to the configured {@linkcode IValidationService} so the error
 * format matches the plugin registration.
 *
 * @param schema - The schema (must expose `safeParse`)
 * @returns A middleware function
 */
export function validateHeaders(schema: unknown): MiddlewareFunction {
  return bindHelper('headers', schema);
}

/**
 * Validate cookies against a schema.
 *
 * Delegates to the configured {@linkcode IValidationService} so the error
 * format matches the plugin registration.
 *
 * @param schema - The schema (must expose `safeParse`)
 * @returns A middleware function
 */
export function validateCookies(schema: unknown): MiddlewareFunction {
  return bindHelper('cookies', schema);
}

// ---------------------------------------------------------------------------
// Internal: helper binder
// ---------------------------------------------------------------------------

/**
 * Shared implementation for the convenience helpers. Each helper delegates to
 * the service's own {@linkcode IValidationService.middleware} so the error
 * formatter is the one the plugin registered with (not a fallback).
 *
 * @param target - The validation target
 * @param schema - The schema to validate against
 * @returns A middleware function
 */
function bindHelper(target: ValidationTarget, schema: unknown): MiddlewareFunction {
  return async (ctx, next) => {
    const service = ctx.services.get<IValidationService>(CAPABILITIES.VALIDATION);
    await service.middleware(schema, target)(ctx, next);
  };
}
