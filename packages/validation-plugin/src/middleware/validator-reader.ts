/** Instance-bound readers for validated request values. @module */
import type {
  IRequestContext,
  IValidationService,
  MiddlewareFunction,
  ValidationTarget,
} from '@setu-ts/common';
import { validatedStateKey } from '@setu-ts/common';

/**
 * The parsed output of a Zod-compatible schema, including defaults and coercions.
 * Schemas without an output type resolve to `unknown`.
 *
 * @typeParam S - The schema whose parsed output is inferred
 * @example
 * ```ts
 * const body = validateBody(Schema);
 * const handler = (ctx: IRequestContext): void => {
 *   const value: ValidatedOutput<typeof Schema> = body.value(ctx);
 *   ctx.response.json(value);
 * };
 * ```
 * @since 0.10.0
 */
export type ValidatedOutput<S> = S extends { readonly _output: infer O } ? O : unknown;

/**
 * Validation middleware with a reader bound to this middleware instance.
 * The reader returns the parsed value only after this instance validates the
 * request successfully and before another validator overwrites that target.
 *
 * @typeParam T - The parsed value produced by this validator
 * @example
 * ```ts
 * const body = validateBody(Schema);
 * router.post('/items', {
 *   middleware: [body],
 *   handler: (ctx) => ctx.response.json(body.value(ctx)),
 * });
 * ```
 * @since 0.10.0
 */
export type ValidatorMiddleware<T> = MiddlewareFunction & {
  /**
   * Read the parsed output produced by this validator for the current request.
   *
   * @param ctx - The request context validated by this middleware instance
   * @returns This instance's successfully validated output
   * @throws {TypeError} If this validator has not run successfully or another
   * validator has overwritten the same request target
   */
  value(ctx: IRequestContext): T;
};

/** Package-private ownership key, alongside the common validated-value key. */
export function validatedByKey(target: ValidationTarget): string {
  return `validation-plugin:validated-by-${target}`;
}

/** Attach an instance-bound reader without changing middleware identity or branding. */
export function bindValidatorReader<T>(
  middleware: MiddlewareFunction,
  target: ValidationTarget,
  token: object,
): ValidatorMiddleware<T> {
  return Object.assign(middleware, {
    value(ctx: IRequestContext): T {
      if (ctx.state.get(validatedByKey(target)) !== token) {
        throw new TypeError(`Validator for ${target} did not run or was overwritten`);
      }
      return ctx.state.get(validatedStateKey(target)) as T;
    },
  });
}

type ServiceBuilder = (
  schema: unknown,
  target: ValidationTarget,
  token: object,
) => MiddlewareFunction;
const builders = new WeakMap<
  IValidationService,
  { method: IValidationService['middleware']; build: ServiceBuilder }
>();

/** Register the policy-aware internal builder without extending the common service contract. */
export function registerServiceMiddleware(
  service: IValidationService,
  build: ServiceBuilder,
): void {
  builders.set(service, { method: service.middleware, build });
}

/** Pass the outer token through the internal builder, preserving custom service overrides. */
export function serviceMiddleware(
  service: IValidationService,
  schema: unknown,
  target: ValidationTarget,
  token: object,
): MiddlewareFunction {
  const builder = builders.get(service);
  if (builder !== undefined && builder.method === service.middleware)
    return builder.build(schema, target, token);
  return (ctx, next) =>
    service.middleware(schema, target)(ctx, async () => {
      ctx.state.set(validatedByKey(target), token);
      await next();
    });
}
