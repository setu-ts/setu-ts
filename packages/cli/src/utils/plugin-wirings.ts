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
