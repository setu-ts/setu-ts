import type { IConfig } from '@setu-ts/common';

/** Builds a config double over a mutable record for fallback/cache tests. */
export function createFakeConfig(data: Record<string, unknown> = {}): IConfig {
  function get<T>(key: string): T | undefined;
  function get<T>(key: string, options: { readonly default: T }): T;
  function get<T>(key: string, options?: { readonly default: T }): T | undefined {
    return data[key] === undefined ? options?.default : (data[key] as T);
  }
  return {
    get,
    has: (key: string): boolean => data[key] !== undefined,
    getOrThrow: <T>(key: string): T => {
      if (data[key] === undefined) throw new Error(`Missing config key: ${key}`);
      return data[key] as T;
    },
  };
}
