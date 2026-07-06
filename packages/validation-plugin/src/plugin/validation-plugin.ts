/**
 * ValidationPlugin — registers an {@linkcode IValidationService} under
 * `CAPABILITIES.VALIDATION`.
 *
 * Provides `CAPABILITIES.VALIDATION` and resolves the error formatter once at
 * registration time (hoisted, not per-request).
 *
 * @module
 */
import type { IPlugin, IPluginContext, IValidationService } from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

import { ValidationService } from '../services/validation-service.ts';
import type { ErrorFormat, ValidationErrorFormatter } from '../formatters/error-formatter.ts';
import { resolveFormatter } from '../formatters/error-formatter.ts';

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
   * When true, strip unknown properties not defined in the schema.
   *
   * **Limitation:** This option cannot be enforced at the middleware layer
   * because schemas are duck-typed via `safeParse()` which does not expose
   * Zod's `.strip()` configuration. Configure stripping on the schema
   * itself instead:
   *
   * ```typescript
   * import { z } from 'zod';
   * const MySchema = z.object({ name: z.string() }).strip();
   * ```
   */
  readonly whitelist?: boolean;

  /**
   * When true, reject requests containing properties not defined in the
   * schema.
   *
   * **Limitation:** This option cannot be enforced at the middleware layer
   * because schemas are duck-typed via `safeParse()` which does not expose
   * Zod's `.strict()` configuration. Configure strict mode on the schema
   * itself instead:
   *
   * ```typescript
   * import { z } from 'zod';
   * const MySchema = z.object({ name: z.string() }).strict();
   * ```
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
 * import { ValidationPlugin } from '@hono-enterprise/validation-plugin';
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
    version: '0.1.0',
    provides: [CAPABILITIES.VALIDATION],
    priority: PLUGIN_PRIORITY.HIGH,

    register(ctx: IPluginContext): void {
      const service = new ValidationService(formatter);
      ctx.services.register<IValidationService>(CAPABILITIES.VALIDATION, service);
    },
  };
}
