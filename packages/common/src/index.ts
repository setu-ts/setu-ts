/**
 * @module
 *
 * Shared types, interfaces, and capability tokens for the Hono Enterprise
 * framework. This package has zero dependencies and no runtime behavior
 * beyond constants and pure type utilities.
 *
 * Every export here is public API and documented in PUBLIC_API.md
 * (AI_GUIDELINES §10).
 */

// Capability tokens
export { CAPABILITIES, createCapabilityToken } from './tokens.ts';
export type { CapabilityToken, StandardCapability } from './tokens.ts';

// Shared types
export { PLUGIN_PRIORITY } from './types.ts';
export type {
  HealthStatus,
  HttpMethod,
  LifecyclePhase,
  LogLevel,
  MetricType,
  PluginPriority,
  RuntimePlatform,
} from './types.ts';

// Utility types
export { err, isErr, isOk, ok, unwrap } from './result.ts';
export type { Err, Ok, Result } from './result.ts';
export { fromNullable, isNone, isSome, none, some } from './option.ts';
export type { None, Option, Some } from './option.ts';

// Service registry
export type { IServiceRegistry, RegisterOptions, ServiceFactory } from './registry.ts';

// HTTP abstractions
export type {
  HandlerResult,
  IMiddleware,
  IRequest,
  IRequestContext,
  IResponse,
  MiddlewareFunction,
  NextFunction,
  RouteDefinition,
  RouteHandler,
  RouteSchema,
} from './http.ts';

// Runtime abstraction
export type {
  IFileSystem,
  IHttpAdapter,
  IRuntimeServices,
  ServerHandle,
  StatResult,
  TimerHandle,
} from './runtime.ts';

// Optional DI container
export type {
  ClassProvider,
  Constructor,
  FactoryProvider,
  IContainer,
  Provider,
  ProviderOptions,
  ServiceScope,
  ValueProvider,
} from './container.ts';

// Plugin contract
export type {
  CliCommandHandler,
  DecoratorHandler,
  EnvVarSpec,
  IApplication,
  ICliApi,
  IDecoratorApi,
  IEnvironmentApi,
  IHealthApi,
  ILifecycleApi,
  IMetadataStore,
  IMetricsApi,
  IMiddlewareApi,
  IOpenApiApi,
  IPlugin,
  IPluginContext,
  IRouterApi,
  MiddlewareOptions,
  RouteInfo,
  StartOptions,
} from './plugin.ts';

// Domain service contracts
export type { ILogger, LogMetadata } from './services/logger.ts';
export type { IConfig } from './services/config.ts';
export type {
  IValidationService,
  ValidationIssue,
  ValidationTarget,
} from './services/validation.ts';
export type {
  HealthCheckResult,
  HealthIndicatorFn,
  HealthReport,
  IHealthIndicator,
  IHealthService,
} from './services/health.ts';
export type {
  ICounter,
  IGauge,
  IHistogram,
  IMetric,
  IMetricsService,
  ISummary,
  MetricConfig,
  MetricOptions,
} from './services/metrics.ts';
export type {
  IAuthorizationService,
  IAuthService,
  IAuthStrategy,
  IJwtService,
  IPrincipal,
  JwtSignOptions,
  RbacConfig,
  RoleDefinition,
} from './services/auth.ts';
export type { IOrmAdapter, ITransaction } from './services/database.ts';
export type { ICacheStore } from './services/cache.ts';
export type { EventHandler, IDomainEvent, IEventBus, Unsubscribe } from './services/events.ts';
export type {
  IMessageBroker,
  ISubscription,
  MessageHandler,
  MessageMetadata,
  SubscribeOptions,
} from './services/messaging.ts';
export type {
  AddJobOptions,
  IJob,
  IQueue,
  JobProcessor,
  ProcessOptions,
  RecurringOptions,
} from './services/queue.ts';
export type { ISecretManager } from './services/secrets.ts';
export type { AuditEntry, IAuditLogger } from './services/audit.ts';
export type { CircuitState, ICircuitBreaker } from './services/resilience.ts';
export type { IStorage, SignedUrlOptions } from './services/storage.ts';
export type { IMailer, MailMessage } from './services/mail.ts';
export type { INotifier, NotificationMessage } from './services/notification.ts';
export type { FlagContext, IFeatureFlags } from './services/feature-flags.ts';
export type { ITenant, ITenantResolver } from './services/tenancy.ts';
export type {
  CqrsCommand,
  CqrsQuery,
  CqrsRequest,
  ICommandBus,
  ICommandHandler,
  ICqrsFacade,
  IPipelineBehavior,
  IQueryBus,
  IQueryHandler,
} from './services/cqrs.ts';
export type {
  IScheduler,
  RetryOptions,
  ScheduledJob,
  ScheduleOptions,
  SchedulerBackoff,
  SchedulerJobHandler,
} from './services/scheduler.ts';
export type {
  ISpan,
  ITelemetryService,
  SpanAttributeValue,
  SpanKind,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
} from './services/telemetry.ts';
export { TELEMETRY_CONTEXT_OPAQUE } from './services/telemetry.ts';
