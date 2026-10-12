/**
 * CLI-managed development source allowlists. Refreshed by setu add.
 * Empty jobs, operations, roles and permissions approve no observations; add
 * the exact application names to those keys when configuring those sources.
 * SDK createObservedFetch is an application helper and is configured separately.
 * Sources are enabled only when createApp receives its devtool argument.
 */
import type { CacheDiagnosticsOptions } from '@setu-ts/cache-plugin';

const ROWS_SOURCES = {
  cache: {
    diagnostics: {
      enabled: true,
      alias: 'cache',
    } satisfies CacheDiagnosticsOptions,
  },
};

/** Every source key, so a row this file no longer emits still spreads to nothing. */
interface AbsentSources {
  readonly cache?: Readonly<Record<never, never>>;
  readonly storage?: Readonly<Record<never, never>>;
  readonly websocket?: Readonly<Record<never, never>>;
  readonly sse?: Readonly<Record<never, never>>;
  readonly backplane?: Readonly<Record<never, never>>;
  readonly events?: Readonly<Record<never, never>>;
  readonly scheduler?: Readonly<Record<never, never>>;
  readonly queue?: Readonly<Record<never, never>>;
  readonly health?: Readonly<Record<never, never>>;
  readonly config?: Readonly<Record<never, never>>;
  readonly telemetry?: Readonly<Record<never, never>>;
  readonly auth?: Readonly<Record<never, never>>;
}

type Sources = Omit<AbsentSources, keyof typeof ROWS_SOURCES> & typeof ROWS_SOURCES;

/** Installed plugin options consumed by the development factory. */
export const DEVTOOL_SOURCES: Sources = ROWS_SOURCES;
