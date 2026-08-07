/**
 * @module
 *
 * Health check plugin: /health, /live, /ready endpoints with pluggable indicators.
 *
 * This plugin provides:
 * - `HealthPlugin` - Main plugin factory that registers `IHealthService`
 * - `HealthService` - Concrete implementation of the health service
 * - `createHttpIndicator` - Factory for HTTP probe indicators
 * - Re-exports of `IHealthService`, `IHealthIndicator`, `HealthCheckResult`,
 *   `HealthIndicatorFn`, `HealthStatus`, `HealthReport` from `@setu-ts/common`
 *
 * @example
 * ```typescript
 * import { HealthPlugin, createHttpIndicator } from '@setu-ts/health-plugin';
 *
 * app.register(HealthPlugin({
 *   endpoints: {
 *     health: '/health',
 *     live: '/live',
 *     ready: '/ready',
 *   },
 *   indicators: [
 *     createHttpIndicator('external-api', { url: 'https://api.example.com/health' }),
 *   ],
 * }));
 * ```
 *
 * @since 0.2.0
 */

// Plugin factory
export { HealthPlugin } from './plugin/health-plugin.ts';
export type { HealthPluginOptions } from './interfaces/index.ts';

// Service
export { HealthService } from './services/health-service.ts';

// Indicators
export { createHttpIndicator } from './indicators/http-indicator.ts';
export type { HttpIndicatorOptions } from './indicators/http-indicator.ts';

// Re-exports from @setu-ts/common
export type {
  HealthCheckResult,
  HealthIndicatorFn,
  HealthReport,
  HealthStatus,
  IHealthIndicator,
  IHealthService,
} from '@setu-ts/common';
