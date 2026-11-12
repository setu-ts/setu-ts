/** Standard capability contracts, open to plugin augmentation. @module */
import type { CapabilityKey } from './tokens.ts';
import type { IContainer } from './container.ts';
import type { IMetadataStore } from './plugin.ts';
import type {
  IRuntimeServices,
  IHttpAdapter,
  ILocalDiagnosticsListenerFactory,
} from './runtime.ts';
import type { IAgentRunService } from './services/agent-runs.ts';
import type { IAuditLogger } from './services/audit.ts';
import type { IAuthSessionService } from './services/auth-session.ts';
import type { IAuthService, IAuthorizationService, IJwtService } from './services/auth.ts';
import type { IAuthorizationPolicyService } from './services/authorization-policies.ts';
import type { ICacheStore } from './services/cache.ts';
import type { IConfig } from './services/config.ts';
import type { ICqrsFacade, ICommandBus, IQueryBus } from './services/cqrs.ts';
import type {
  IHealthDiagnosticsSource,
  IConfigDiagnosticsSource,
  IQueueDiagnosticsSource,
  ITraceDiagnosticsSource,
  IAuthorizationDiagnosticsSource,
  ICacheDiagnosticsSource,
  ISchedulerDiagnosticsSource,
  IEventDiagnosticsSource,
  IRealtimeDiagnosticsSource,
  IOutboundHttpDiagnosticsSource,
  IStorageDiagnosticsSource,
} from './services/diagnostics.ts';
import type { IEventBus } from './services/events.ts';
import type { IFeatureFlags } from './services/feature-flags.ts';
import type { IGraphqlService } from './services/graphql.ts';
import type { IGrpcService } from './services/grpc.ts';
import type { IHealthService, IHealthIndicator } from './services/health.ts';
import type { IIdempotencyService } from './services/idempotency.ts';
import type { ILocalizer } from './services/localization.ts';
import type { ILogger } from './services/logger.ts';
import type { IMailer } from './services/mail.ts';
import type { IMessageBroker } from './services/messaging.ts';
import type { IMetricsService } from './services/metrics.ts';
import type { INotifier } from './services/notification.ts';
import type { IOpenApiService } from './services/openapi.ts';
import type { IQueue } from './services/queue.ts';
import type { IRealtimeBackplane } from './services/realtime.ts';
import type { IResilienceService } from './services/resilience.ts';
import type { IScheduler } from './services/scheduler.ts';
import type { ISecretManager } from './services/secrets.ts';
import type { IServiceDiscovery } from './services/service-discovery.ts';
import type { ISessionService } from './services/session.ts';
import type { ISseService } from './services/sse.ts';
import type { ISsrService } from './services/ssr.ts';
import type { IStorage } from './services/storage.ts';
import type { ITelemetryService } from './services/telemetry.ts';
import type { IMultiTenancyService } from './services/tenancy.ts';
import type { IValidationService } from './services/validation.ts';
import type { IVectorStore } from './services/vector-store.ts';
import type { IViewEngine } from './services/view.ts';
import type { IWebSocketService } from './services/websocket.ts';
import type { IWorkerPool } from './services/worker-pool.ts';

/**
 * Service interfaces indexed by standard capability token value. Registry and
 * request-resolver overloads infer their return types from this map. Common
 * declares its own interfaces here; a plugin whose interface lives elsewhere
 * augments the map in the module that declares that interface.
 *
 * @example Bind a plugin service
 * ```typescript
 * declare module '@setu-ts/common' {
 *   interface CapabilityServices {
 *     database: IDatabaseService;
 *   }
 * }
 * ```
 * @since 0.13.0
 */
export interface CapabilityServices {
  /** Contract for `agent-runs`. @since 0.13.0 */
  'agent-runs': IAgentRunService;
  /** Contract for `runtime`. @since 0.13.0 */
  runtime: IRuntimeServices;
  /** Contract for `logger`. @since 0.13.0 */
  logger: ILogger;
  /** Contract for `config`. @since 0.13.0 */
  config: IConfig;
  /** Contract for `validation`. @since 0.13.0 */
  validation: IValidationService;
  /** Contract for `cache`. @since 0.13.0 */
  cache: ICacheStore;
  /** Contract for `events`. @since 0.13.0 */
  events: IEventBus;
  /** Contract for `messaging`. @since 0.13.0 */
  messaging: IMessageBroker;
  /** Contract for `authentication`. @since 0.13.0 */
  authentication: IAuthService;
  /** Contract for `authorization`. @since 0.13.0 */
  authorization: IAuthorizationService;
  /** Contract for `authorization-policies`. @since 0.13.0 */
  'authorization-policies': IAuthorizationPolicyService;
  /** Contract for `jwt`. @since 0.13.0 */
  jwt: IJwtService;
  /** Contract for `auth-session`. @since 0.13.0 */
  'auth-session': IAuthSessionService;
  /** Contract for `scheduler`. @since 0.13.0 */
  scheduler: IScheduler;
  /** Contract for `metrics`. @since 0.13.0 */
  metrics: IMetricsService;
  /** Contract for `health`. @since 0.13.0 */
  health: IHealthService;
  /** Contract for `openapi`. @since 0.13.0 */
  openapi: IOpenApiService;
  /** Contract for `telemetry`. @since 0.13.0 */
  telemetry: ITelemetryService;
  /** Contract for `secrets`. @since 0.13.0 */
  secrets: ISecretManager;
  /** Contract for `audit`. @since 0.13.0 */
  audit: IAuditLogger;
  /** Contract for `resilience`. @since 0.13.0 */
  resilience: IResilienceService;
  /** Contract for `storage`. @since 0.13.0 */
  storage: IStorage;
  /** Contract for `mail`. @since 0.13.0 */
  mail: IMailer;
  /** Contract for `notification`. @since 0.13.0 */
  notification: INotifier;
  /** Contract for `feature-flags`. @since 0.13.0 */
  'feature-flags': IFeatureFlags;
  /** Contract for `queue`. @since 0.13.0 */
  queue: IQueue;
  /** Contract for `cqrs`. @since 0.13.0 */
  cqrs: ICqrsFacade;
  /** Contract for `command-bus`. @since 0.13.0 */
  'command-bus': ICommandBus;
  /** Contract for `query-bus`. @since 0.13.0 */
  'query-bus': IQueryBus;
  /** Contract for `multi-tenancy`. @since 0.13.0 */
  'multi-tenancy': IMultiTenancyService;
  /** Contract for `worker-pool`. @since 0.13.0 */
  'worker-pool': IWorkerPool;
  /** Contract for `di-container`. @since 0.13.0 */
  'di-container': IContainer;
  /** Contract for `http-adapter`. @since 0.13.0 */
  'http-adapter': IHttpAdapter;
  /** Contract for `sse`. @since 0.13.0 */
  sse: ISseService;
  /** Contract for `websocket`. @since 0.13.0 */
  websocket: IWebSocketService;
  /** Contract for `realtime-backplane`. @since 0.13.0 */
  'realtime-backplane': IRealtimeBackplane;
  /** Contract for `ssr`. @since 0.13.0 */
  ssr: ISsrService;
  /** Contract for `session`. @since 0.13.0 */
  session: ISessionService;
  /** Contract for `service-discovery`. @since 0.13.0 */
  'service-discovery': IServiceDiscovery;
  /** Contract for `health-indicator`. @since 0.13.0 */
  'health-indicator': IHealthIndicator;
  /** Contract for `metadata-store`. @since 0.13.0 */
  'metadata-store': IMetadataStore;
  /** Contract for `grpc`. @since 0.13.0 */
  grpc: IGrpcService;
  /** Contract for `graphql`. @since 0.13.0 */
  graphql: IGraphqlService;
  /** Contract for `view`. @since 0.13.0 */
  view: IViewEngine;
  /** Contract for `localization`. @since 0.13.0 */
  localization: ILocalizer;
  /** Contract for `idempotency`. @since 0.13.0 */
  idempotency: IIdempotencyService;
  /** Contract for `local-diagnostics-listener`. @since 0.13.0 */
  'local-diagnostics-listener': ILocalDiagnosticsListenerFactory;
  /** Contract for `vector-store`. @since 0.13.0 */
  'vector-store': IVectorStore;
  /** Contract for `health-diagnostics`. @since 0.13.0 */
  'health-diagnostics': IHealthDiagnosticsSource;
  /** Contract for `config-diagnostics`. @since 0.13.0 */
  'config-diagnostics': IConfigDiagnosticsSource;
  /** Contract for `queue-diagnostics`. @since 0.13.0 */
  'queue-diagnostics': IQueueDiagnosticsSource;
  /** Contract for `trace-diagnostics`. @since 0.13.0 */
  'trace-diagnostics': ITraceDiagnosticsSource;
  /** Contract for `authorization-diagnostics`. @since 0.13.0 */
  'authorization-diagnostics': IAuthorizationDiagnosticsSource;
  /** Contract for `cache-diagnostics`. @since 0.13.0 */
  'cache-diagnostics': ICacheDiagnosticsSource;
  /** Contract for `scheduler-diagnostics`. @since 0.13.0 */
  'scheduler-diagnostics': ISchedulerDiagnosticsSource;
  /** Contract for `event-diagnostics`. @since 0.13.0 */
  'event-diagnostics': IEventDiagnosticsSource;
  /** Contract for `realtime-diagnostics`. @since 0.13.0 */
  'realtime-diagnostics': IRealtimeDiagnosticsSource;
  /** Contract for `outbound-http-diagnostics`. @since 0.13.0 */
  'outbound-http-diagnostics': IOutboundHttpDiagnosticsSource;
  /** Contract for `storage-diagnostics`. @since 0.13.0 */
  'storage-diagnostics': IStorageDiagnosticsSource;
}

/**
 * Standard capability keys absent from the currently loaded `CapabilityServices`
 * map. Lookups for these tokens retain an explicit service type argument.
 * In the full program this is the four unnamed kernel contribution contracts;
 * a plugin's token is also unbound when its augmentation is not loaded.
 *
 * @since 0.13.0
 */
export type UnboundCapability = Exclude<CapabilityKey, keyof CapabilityServices>;
