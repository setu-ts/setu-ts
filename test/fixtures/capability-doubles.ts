import type { IConfig, ILogger } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';

/** Full logger double with selectively recorded methods. @since 0.13.0 */
export function loggerDouble(overrides: Partial<ILogger> = {}): ILogger {
  return {
    level: 'info',
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return this;
    },
    ...overrides,
  };
}

/** Full config double backed by values. @since 0.13.0 */
export function configDouble(values: Readonly<Record<string, unknown>> = {}): IConfig {
  return {
    get<T>(key: string, options?: { readonly default: T }): T {
      return (values[key] ?? options?.default) as T;
    },
    getOrThrow<T>(key: string): T {
      if (!(key in values)) throw new Error(`Missing ${key}`);
      return values[key] as T;
    },
    has: (key) => key in values,
  };
}

/** Full database double for registration and reachability tests. @since 0.13.0 */
export function databaseDouble(): IDatabaseService {
  return {
    getRepository() {
      throw new Error('No repository configured');
    },
    transaction() {
      return Promise.reject(new Error('No transaction configured'));
    },
    query() {
      return Promise.resolve([]);
    },
    migrate() {
      return Promise.reject(new Error('Migrations unsupported'));
    },
    isHealthy: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
}
