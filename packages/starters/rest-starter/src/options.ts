/**
 * @module
 */
import type { ConfigPluginOptions } from '@hono-enterprise/config-plugin';
import type { LoggerPluginOptions } from '@hono-enterprise/logger-plugin';
import type { ValidationPluginOptions } from '@hono-enterprise/validation-plugin';
import type { HttpSecurityPluginOptions } from '@hono-enterprise/http-security-plugin';
import type { HealthPluginOptions } from '@hono-enterprise/health-plugin';
import type { MetricsPluginOptions } from '@hono-enterprise/metrics-plugin';
import type { OpenApiPluginOptions } from '@hono-enterprise/openapi-plugin';
import type { DecoratorPluginOptions } from '@hono-enterprise/decorator-plugin';
import type { DatabasePluginOptions } from '@hono-enterprise/database-plugin';
import type { AuthPluginOptions } from '@hono-enterprise/auth-plugin';

/**
 * Options for {@linkcode createRestApp}. Per-plugin optional arms are threaded
 * straight through to each plugin factory. Omitted plugins use their default
 * configuration (no arguments required).
 *
 * @see {@linkcode RestStarterOptions}
 */
export interface RestStarterOptions {
  /**
   * Options for {@linkcode ConfigPlugin}. Omitted → defaults.
   */
  config?: ConfigPluginOptions;
  /**
   * Options for {@linkcode LoggerPlugin}. Omitted → defaults.
   */
  logger?: LoggerPluginOptions;
  /**
   * Options for {@linkcode ValidationPlugin}. Omitted → defaults.
   */
  validation?: ValidationPluginOptions;
  /**
   * Options for {@linkcode HttpSecurityPlugin}. Omitted → defaults.
   */
  httpSecurity?: HttpSecurityPluginOptions;
  /**
   * Options for {@linkcode HealthPlugin}. Omitted → defaults.
   */
  health?: HealthPluginOptions;
  /**
   * Options for {@linkcode MetricsPlugin}. Omitted → defaults.
   */
  metrics?: MetricsPluginOptions;
  /**
   * Options for {@linkcode OpenApiPlugin}. Omitted → defaults.
   */
  openapi?: OpenApiPluginOptions;
  /**
   * Options for {@linkcode DecoratorPlugin}. Omitted → defaults.
   */
  decorators?: DecoratorPluginOptions;
  /**
   * Optional arm: {@linkcode DatabasePlugin}. Provided only when the caller
   * supplies database credentials; omitted → database not registered.
   */
  database?: DatabasePluginOptions;
  /**
   * Optional arm: {@linkcode AuthPlugin}. Provided only when the caller supplies
   * auth configuration (jwt + rbac); omitted → auth not registered.
   */
  auth?: AuthPluginOptions;
}
