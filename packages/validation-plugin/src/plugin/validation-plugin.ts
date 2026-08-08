/**
 * ValidationPlugin — registers an {@linkcode IValidationService} under
 * `CAPABILITIES.VALIDATION`.
 *
 * Provides `CAPABILITIES.VALIDATION` and resolves the error formatter once at
 * registration time (hoisted, not per-request).
 *
 * @module
 */
import type { IPlugin, IPluginContext, IValidationService } from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';

import { ValidationService } from '../services/validation-service.ts';
import type { ErrorFormat, ValidationErrorFormatter } from '../formatters/error-formatter.ts';
import { resolveFormatter } from '../formatters/error-formatter.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/**
 * Options for {@linkcode ValidationPlugin}.
 *
 * @since 0.1.0
 */
export interface ValidationPluginOptions {
  /**
   * Error response format. Defaults to `'default'`.
   *
   * Pass `'default'`, `'rfc7807'`, or `'nestjs'` for built-in formatters,
   * or provide a custom `ValidationErrorFormatter` function.
   */
  readonly errorFormat?: ErrorFormat | ValidationErrorFormatter;

  /**
   * When true, strip properties the schema does not declare.
   *
   * Applied once per middleware at registration time by calling the schema's
   * own `.strip()` (Zod-style). A schema that does not expose `.strip()` — a
   * non-object schema, or a validator other than Zod — is used unchanged, since
   * schemas are duck-typed through `safeParse`.
   */
  readonly whitelist?: boolean;

  /**
   * When true, reject payloads carrying properties the schema does not declare.
   *
   * Applied once per middleware at registration time by calling the schema's
   * own `.strict()` (Zod-style), and takes precedence over
   * {@linkcode ValidationPluginOptions.whitelist} when both are set (rejecting
   * is stronger than stripping). A schema that does not expose `.strict()` is
   * used unchanged.
   */
  readonly forbidNonWhitelisted?: boolean;
}

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'validation-plugin';

/**
 * Creates the ValidationPlugin.
 *
 * The plugin registers its {@linkcode IValidationService} under
 * `CAPABILITIES.VALIDATION` at `PLUGIN_PRIORITY.HIGH` (100) so validation is
 * available before most other plugins register — matching the band used by
 * `ConfigPlugin` and `LoggerPlugin`.
 *
 * The error formatter is resolved once during registration and reused for all
 * subsequent requests.
 *
 * @example
 * ```typescript
 * import { ValidationPlugin } from '@setu-ts/validation-plugin';
 *
 * app.register(ValidationPlugin({
 *   errorFormat: 'rfc7807',
 * }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function ValidationPlugin(options?: ValidationPluginOptions): IPlugin {
  // Hoist the formatter once at registration time.
  const formatter = resolveFormatter(options?.errorFormat);

  return {
    name: PLUGIN_NAME,
    version: denoJson.version,
    provides: [CAPABILITIES.VALIDATION],
    priority: PLUGIN_PRIORITY.HIGH,

    register(ctx: IPluginContext): void {
      const service = new ValidationService(formatter, {
        ...(options?.whitelist !== undefined && { whitelist: options.whitelist }),
        ...(options?.forbidNonWhitelisted !== undefined &&
          { forbidNonWhitelisted: options.forbidNonWhitelisted }),
      });
      ctx.services.register<IValidationService>(CAPABILITIES.VALIDATION, service);
    },
  };
}
