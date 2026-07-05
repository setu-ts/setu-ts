/**
 * @module
 *
 * Configuration management plugin with env loading and Zod validation.
 *
 * Provides `ConfigPlugin` which registers a type-safe {@linkcode IConfig}
 * under `CAPABILITIES.CONFIG`. Configuration values originate from
 * environment variables and `.env` files, validated at startup.
 *
 * Every export here is public API and documented in PUBLIC_API.md
 * (AI_GUIDELINES §10).
 */

// Plugin factory
export { ConfigPlugin } from './plugin/config-plugin.ts';
export type { ConfigPluginOptions } from './plugin/config-plugin.ts';

// Structural schema for validation (compatible with Zod)
export type { StructuralSchema } from './validators/config-validator.ts';
