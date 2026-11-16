/** Zero-configuration provider factories shared by add and check. @module */
/** One provider a decorated ingress class can resolve from the application. */
interface IPluginWiring {
  /** Factory exported by the provider package. */
  readonly symbol: string;
}

/**
 * Provider plugins that an emitted application config can activate safely.
 *
 * Every factory here has an in-memory, zero-configuration default. That makes
 * adding it to the CLI-generated config a coherent development
 * composition; providers that need credentials or a user-owned choice remain
 * manifest-only like every other `setu add` package.
 * @since 0.13.0
 */
export const ZERO_CONFIG_WIRINGS: ReadonlyMap<string, IPluginWiring> = new Map([
  ['validation-plugin', { symbol: 'ValidationPlugin' }],
  ['worker-pool-plugin', { symbol: 'WorkerPoolPlugin' }],
  ['secrets-plugin', { symbol: 'SecretsPlugin' }],
  ['storage-plugin', { symbol: 'StoragePlugin' }],
  ['audit-plugin', { symbol: 'AuditPlugin' }],
  ['mail-plugin', { symbol: 'MailPlugin' }],
  ['resilience-plugin', { symbol: 'ResiliencePlugin' }],
  ['view-plugin', { symbol: 'ViewPlugin' }],
  ['idempotency-plugin', { symbol: 'IdempotencyPlugin' }],
  ['cqrs-plugin', { symbol: 'CqrsPlugin' }],
  ['events-plugin', { symbol: 'EventsPlugin' }],
  ['messaging-plugin', { symbol: 'MessagingPlugin' }],
  ['queue-plugin', { symbol: 'QueuePlugin' }],
  ['scheduler-plugin', { symbol: 'SchedulerPlugin' }],
  ['websocket-plugin', { symbol: 'WebSocketPlugin' }],
  ['cache-plugin', { symbol: 'CachePlugin' }],
  ['health-plugin', { symbol: 'HealthPlugin' }],
  ['metrics-plugin', { symbol: 'MetricsPlugin' }],
  ['openapi-plugin', { symbol: 'OpenApiPlugin' }],
  ['sse-plugin', { symbol: 'SsePlugin' }],
  ['realtime-backplane-plugin', { symbol: 'RealtimeBackplanePlugin' }],
]);

/**
 * Providers that need options, so `setu add` prints their registration rather
 * than inserting it. `setu check` (W006) reports an installed one with no call,
 * like a zero-config provider: an installed package nothing registers is the
 * same mistake whichever way the call was meant to arrive. `auth-plugin` is not
 * listed: its quota and error helpers (`createQuota`, `respondQuotaExceeded`)
 * are used without registering `AuthPlugin`, so an installed copy with no call
 * is not evidence of a missing registration.
 * @since 0.13.0
 */
export const CONFIGURED_PROVIDERS: ReadonlyMap<string, IPluginWiring> = new Map([
  ['session-plugin', { symbol: 'SessionPlugin' }],
  ['telemetry-plugin', { symbol: 'TelemetryPlugin' }],
  ['feature-flags-plugin', { symbol: 'FeatureFlagsPlugin' }],
  ['localization-plugin', { symbol: 'LocalizationPlugin' }],
  ['multi-tenancy-plugin', { symbol: 'MultiTenancyPlugin' }],
  ['notification-plugin', { symbol: 'NotificationPlugin' }],
  ['service-discovery-plugin', { symbol: 'ServiceDiscoveryPlugin' }],
  ['static-plugin', { symbol: 'StaticPlugin' }],
  ['graphql-plugin', { symbol: 'GraphqlPlugin' }],
  ['grpc-plugin', { symbol: 'GrpcPlugin' }],
  ['database-plugin', { symbol: 'DatabasePlugin' }],
  ['vector-store-plugin', { symbol: 'VectorStorePlugin' }],
  ['mcp-plugin', { symbol: 'McpPlugin' }],
  ['di-plugin', { symbol: 'DiPlugin' }],
  ['cloudflare-plugin', { symbol: 'CloudflarePlugin' }],
  ['react-router-plugin', { symbol: 'ReactRouterPlugin' }],
]);
