/** Instance-bound readers for validated request values. @module */
import type {
  IRequestContext,
  IValidationService,
  MiddlewareFunction,
  ValidationTarget,
} from '@setu-ts/common';
import { validatedStateKey } from '@setu-ts/common';

/** The parsed output of a Zod-compatible schema, including defaults and coercions. */
export type ValidatedOutput<S> = S extends { readonly _output: infer O } ? O : unknown;

/** Validation middleware whose reader accepts only its own successful run. */
export type ValidatorMiddleware<T> = MiddlewareFunction & {
  /** Read this validator's output; throws if absent or overwritten by another validator. */
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
