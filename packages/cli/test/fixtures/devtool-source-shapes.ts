/**
 * CLI-managed development source allowlists. Refreshed by setu add.
 * Empty jobs, operations, roles and permissions approve no observations; add
 * the exact application names to those keys when configuring those sources.
 * SDK createObservedFetch is an application helper and is configured separately.
 * Sources are enabled only when createApp receives its devtool argument.
 */
import type { CacheDiagnosticsOptions } from '@setu-ts/cache-plugin';
import type { StorageDiagnosticsOptions } from '@setu-ts/storage-plugin';
import type { RealtimeDiagnosticsOptions } from '@setu-ts/common';
import type { EventsDiagnosticsOptions } from '@setu-ts/events-plugin';
import type { SchedulerDiagnosticsOptions } from '@setu-ts/scheduler-plugin';
import type { QueueDiagnosticsOptions } from '@setu-ts/queue-plugin';
import type { HealthDiagnosticsOptions } from '@setu-ts/health-plugin';
import type { ConfigDiagnosticsOptions } from '@setu-ts/config-plugin';
import type { TraceDiagnosticsOptions } from '@setu-ts/telemetry-plugin';
import type { AuthorizationDiagnosticsOptions } from '@setu-ts/auth-plugin';

/** Installed plugin options consumed by the development factory. */
export const DEVTOOL_SOURCES = {
  cache: {
    diagnostics: { enabled: true, alias: 'cache' } satisfies CacheDiagnosticsOptions,
  },
  storage: {
    diagnostics: { enabled: true, alias: 'storage' } satisfies StorageDiagnosticsOptions,
  },
  websocket: {
    diagnostics: { enabled: true, alias: 'websocket' } satisfies RealtimeDiagnosticsOptions,
  },
  sse: {
    diagnostics: { enabled: true, alias: 'sse' } satisfies RealtimeDiagnosticsOptions,
  },
  backplane: {
    diagnostics: { enabled: true, alias: 'backplane' } satisfies RealtimeDiagnosticsOptions,
  },
  events: {
    diagnostics: { enabled: true, alias: 'events', events: {} } satisfies EventsDiagnosticsOptions,
  },
  scheduler: {
    diagnostics: {
      enabled: true,
      alias: 'scheduler',
      jobs: {},
    } satisfies SchedulerDiagnosticsOptions,
  },
  queue: {
    diagnostics: {
      enabled: true,
      instanceAlias: 'queue',
      queues: {},
    } satisfies QueueDiagnosticsOptions,
  },
  health: {
    diagnostics: {
      enabled: true,
      indicators: {
        'auth': 'auth',
        'cache': 'cache',
        'events': 'events',
        'queue': 'queue',
        'realtime-backplane': 'realtime-backplane',
        'scheduler': 'scheduler',
        'sse': 'sse',
        'storage': 'storage',
        'websocket': 'websocket',
      },
    } satisfies HealthDiagnosticsOptions,
  },
  config: {
    diagnostics: { enabled: true, keys: {} } satisfies ConfigDiagnosticsOptions,
  },
  telemetry: {
    diagnostics: {
      enabled: true,
      serviceAlias: 'shop',
      operations: {},
    } satisfies TraceDiagnosticsOptions,
  },
  auth: {
    authorizationDiagnostics: {
      enabled: true,
      roles: {},
      permissions: {},
    } satisfies AuthorizationDiagnosticsOptions,
  },
};
