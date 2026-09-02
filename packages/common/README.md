# @setu-ts/common

Shared types, interfaces, and capability tokens for the Setu-TS framework.

This package is the framework's contract layer: every other package depends on it, and it depends on
nothing. It contains only interfaces, type aliases, constants, and pure zero-dependency type
utilities — no runtime behavior beyond those.

## Installation

```bash
# Deno
deno add jsr:@setu-ts/common

# npm / pnpm / yarn / bun (via JSR's npm compatibility layer)
npx jsr add @setu-ts/common
```

## What's Inside

| Area                | Exports                                                                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability tokens   | `CAPABILITIES`, `createCapabilityToken()`, `CapabilityToken`, `StandardCapability`                                                                                                                                                                                                           |
| Plugin contract     | `IPlugin`, `IPluginContext`, `IApplication`, context APIs (`IRouterApi`, `IMiddlewareApi`, `ILifecycleApi`, …)                                                                                                                                                                               |
| Service registry    | `IServiceRegistry`, `RegisterOptions`, `ServiceFactory`                                                                                                                                                                                                                                      |
| HTTP abstractions   | `IRequest`, `IResponse`, `IRequestContext`, `IMiddleware`, `MiddlewareFunction`, `RouteHandler`, `RouteDefinition`                                                                                                                                                                           |
| Runtime abstraction | `IRuntimeServices`, `IFileSystem`, `IHttpAdapter`                                                                                                                                                                                                                                            |
| Optional DI         | `IContainer`, `Provider`, `ServiceScope`                                                                                                                                                                                                                                                     |
| Domain contracts    | `ILogger`, `IConfig`, `IValidationService`, `IHealthIndicator`, `IMetric`, `IJwtService`, `IOrmAdapter`, `ICacheStore`, `IEventBus`, `IMessageBroker`, `IQueue`, `ISecretManager`, `IAuditLogger`, `ICircuitBreaker`, `IStorage`, `IMailer`, `INotifier`, `IFeatureFlags`, `ITenantResolver` |
| Shared types        | `HttpMethod`, `RuntimePlatform`, `LogLevel`, `LifecyclePhase`, `HealthStatus`, `MetricType`, `PLUGIN_PRIORITY`                                                                                                                                                                               |
| Utility types       | `Result<T, E>` (`ok`, `err`, `isOk`, `isErr`, `unwrap`), `Option<T>` (`some`, `none`, `isSome`, `isNone`, `fromNullable`)                                                                                                                                                                    |

## Usage

Resolve capabilities by token, typed by the interfaces defined here:

```typescript
import { CAPABILITIES, type ILogger, type IPlugin } from '@setu-ts/common';

export function MyPlugin(): IPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    dependencies: [CAPABILITIES.LOGGER],
    register(ctx) {
      const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
      logger.info('my-plugin registered');
    },
  };
}
```

Handle fallible operations without throwing:

```typescript
import { err, ok, type Result } from '@setu-ts/common';

function parsePort(raw: string): Result<number, RangeError> {
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536
    ? ok(port)
    : err(new RangeError(`Invalid port: ${raw}`));
}
```

## Rules

- Zero dependencies, always.
- No runtime-specific APIs — ever.
- Every export is public API: documented in the repository's `PUBLIC_API.md`, JSDoc'd, and covered
  by the backward-compatibility policy.

## Ingress behaviours

`IngressKind`, `IngressContext`, `IIngressBehavior`, `BehaviorLike`, and `composeBehaviorChain`
provide one transport-neutral, void-result behaviour chain for queue jobs, scheduler fires, broker
deliveries, and WebSocket frames. An `IngressContext` contains only `kind`, `name`, `payload`, and
the optional `attempt` and `headers` fields. Behaviours run in declared order; returning without
`next()` short-circuits the native handler.

`WebSocketUpgradeGuard` and `WebSocketGuardDecision` are the separate, route-scoped handshake guard
types. They run before an accepted upgrade; they are not frame behaviours.

See the repository's
[`PUBLIC_API.md`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#api-reference-setu-tscommon)
for the full API contract and
[`ARCHITECTURE.md`](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md) for how this
package fits the plugin architecture.

## Exports

| Export                       | Kind      |
| ---------------------------- | --------- |
| `assertRealPathContained`    | function  |
| `brandErrorResponder`        | function  |
| `composeBehaviorChain`       | function  |
| `contentTypeFor`             | function  |
| `contextToTraceparent`       | function  |
| `createCachedProbe`          | function  |
| `createCapabilityToken`      | function  |
| `decodeCursor`               | function  |
| `decodeFrameData`            | function  |
| `encodeCursor`               | function  |
| `encodeFrameData`            | function  |
| `err`                        | function  |
| `errorResponderOf`           | function  |
| `extractContextFromHeaders`  | function  |
| `fromNullable`               | function  |
| `isErr`                      | function  |
| `isLexicallyContained`       | function  |
| `isNone`                     | function  |
| `isOk`                       | function  |
| `isPromiseLike`              | function  |
| `isSome`                     | function  |
| `isWebSocketUpgradeRequest`  | function  |
| `isWorkerReadySignal`        | function  |
| `isWorkerTaskReply`          | function  |
| `isWorkerTaskRequest`        | function  |
| `keysetPredicate`            | function  |
| `mintNextCursor`             | function  |
| `none`                       | function  |
| `ok`                         | function  |
| `parseCookie`                | function  |
| `parseTraceparentToContext`  | function  |
| `replacePrincipal`           | function  |
| `replaceTenant`              | function  |
| `resolveKeysetSort`          | function  |
| `resolveRegistryEntry`       | function  |
| `respondWithError`           | function  |
| `sealRequestIdentity`        | function  |
| `securityMetadataOf`         | function  |
| `serializeCookie`            | function  |
| `serializeError`             | function  |
| `setUpgradeIntent`           | function  |
| `some`                       | function  |
| `sortFingerprint`            | function  |
| `splitWorkerEnv`             | function  |
| `unwrap`                     | function  |
| `upgradeIntentOf`            | function  |
| `validatedStateKey`          | function  |
| `validationMetadataOf`       | function  |
| `withSecurityMetadata`       | function  |
| `withValidationMetadata`     | function  |
| `CAPABILITIES`               | const     |
| `CLIENT_IP_STATE_KEY`        | const     |
| `ERROR_RESPONDER_BRAND`      | const     |
| `ERROR_RESPONDER_STATE_KEY`  | const     |
| `PLUGIN_PRIORITY`            | const     |
| `SECURITY_METADATA`          | const     |
| `TELEMETRY_CONTEXT_OPAQUE`   | const     |
| `TRACEPARENT_HEADER`         | const     |
| `TRACESTATE_HEADER`          | const     |
| `UPGRADE_INTENT`             | const     |
| `VALIDATION_METADATA`        | const     |
| `AddJobOptions`              | interface |
| `AuditEntry`                 | interface |
| `BehaviorLike`               | interface |
| `BulkheadPolicy`             | interface |
| `CachedProbeOptions`         | interface |
| `CircuitBreakerPolicy`       | interface |
| `ClassProvider`              | interface |
| `CookieAttributes`           | interface |
| `CqrsCommand`                | interface |
| `CqrsQuery`                  | interface |
| `CqrsRequest`                | interface |
| `CursorPayload`              | interface |
| `EncodedPayload`             | interface |
| `EnvVarSpec`                 | interface |
| `Err`                        | interface |
| `ErrorResponderTarget`       | interface |
| `ErrorResponseInit`          | interface |
| `FactoryProvider`            | interface |
| `FlagContext`                | interface |
| `GraphqlConnectionInfo`      | interface |
| `GraphqlExecutionOutcome`    | interface |
| `GraphqlExecutionResult`     | interface |
| `GraphqlFormattedError`      | interface |
| `GraphqlOperationContext`    | interface |
| `GraphqlRequestParams`       | interface |
| `GrpcServiceDefinition`      | interface |
| `HandlerResult`              | interface |
| `HealthCheckResult`          | interface |
| `HealthReport`               | interface |
| `IAdapterTransaction`        | interface |
| `IApplication`               | interface |
| `IAuditLogger`               | interface |
| `IAuthorizationService`      | interface |
| `IAuthService`               | interface |
| `IAuthStrategy`              | interface |
| `ICacheStore`                | interface |
| `ICircuitBreaker`            | interface |
| `ICliApi`                    | interface |
| `ICommandBus`                | interface |
| `ICommandHandler`            | interface |
| `IConfig`                    | interface |
| `IContainer`                 | interface |
| `ICounter`                   | interface |
| `ICqrsFacade`                | interface |
| `IDatabaseAdapter`           | interface |
| `IDataSource`                | interface |
| `IDecoratorApi`              | interface |
| `IDnsResolver`               | interface |
| `IDomainEvent`               | interface |
| `IEnvironmentApi`            | interface |
| `IErrorResponder`            | interface |
| `IEventBus`                  | interface |
| `IFeatureFlags`              | interface |
| `IFileSystem`                | interface |
| `IGauge`                     | interface |
| `IGraphqlService`            | interface |
| `IGrpcService`               | interface |
| `IHealthApi`                 | interface |
| `IHealthIndicator`           | interface |
| `IHealthService`             | interface |
| `IHistogram`                 | interface |
| `IHttpAdapter`               | interface |
| `IIngressBehavior`           | interface |
| `IJob`                       | interface |
| `IJwtService`                | interface |
| `ILifecycleApi`              | interface |
| `ILogger`                    | interface |
| `IMailer`                    | interface |
| `IMessageBroker`             | interface |
| `IMetadataStore`             | interface |
| `IMetric`                    | interface |
| `IMetricsApi`                | interface |
| `IMetricsService`            | interface |
| `IMiddleware`                | interface |
| `IMiddlewareApi`             | interface |
| `IMultiTenancyService`       | interface |
| `IngressContext`             | interface |
| `INotifier`                  | interface |
| `IOpenApiApi`                | interface |
| `IOrmAdapter`                | interface |
| `IPipelineBehavior`          | interface |
| `IPlugin`                    | interface |
| `IPluginContext`             | interface |
| `IPrincipal`                 | interface |
| `IQueryBus`                  | interface |
| `IQueryHandler`              | interface |
| `IQueue`                     | interface |
| `IRealtimeBackplane`         | interface |
| `IRequest`                   | interface |
| `IRequestContext`            | interface |
| `IResilienceService`         | interface |
| `IResponse`                  | interface |
| `IRouterApi`                 | interface |
| `IRuntimeServices`           | interface |
| `IScheduler`                 | interface |
| `ISecretManager`             | interface |
| `IServiceDiscovery`          | interface |
| `IServiceRegistry`           | interface |
| `ISession`                   | interface |
| `ISessionService`            | interface |
| `ISessionStore`              | interface |
| `ISpan`                      | interface |
| `ISseConnection`             | interface |
| `ISseService`                | interface |
| `ISsrService`                | interface |
| `IStorage`                   | interface |
| `ISubscription`              | interface |
| `ISummary`                   | interface |
| `ITelemetryService`          | interface |
| `ITenant`                    | interface |
| `ITenantRepository`          | interface |
| `ITenantResolver`            | interface |
| `ITransaction`               | interface |
| `IValidationService`         | interface |
| `IWebSocketConnection`       | interface |
| `IWebSocketService`          | interface |
| `IWebSocketTransport`        | interface |
| `IWorkerHandle`              | interface |
| `IWorkerHost`                | interface |
| `IWorkerPool`                | interface |
| `JwtSignOptions`             | interface |
| `MailMessage`                | interface |
| `MessageMetadata`            | interface |
| `MetricConfig`               | interface |
| `MetricOptions`              | interface |
| `MiddlewareOptions`          | interface |
| `None`                       | interface |
| `NormalizedQuery`            | interface |
| `NotificationMessage`        | interface |
| `Ok`                         | interface |
| `PageResult`                 | interface |
| `PickOptions`                | interface |
| `ProcessOptions`             | interface |
| `ProviderOptions`            | interface |
| `PutObjectOptions`           | interface |
| `RbacConfig`                 | interface |
| `RealtimeFrame`              | interface |
| `RecurringOptions`           | interface |
| `RegisterOptions`            | interface |
| `RequestOptions`             | interface |
| `RetryOptions`               | interface |
| `RetryPolicy`                | interface |
| `RoleDefinition`             | interface |
| `RoomBroadcastOptions`       | interface |
| `RouteDefinition`            | interface |
| `RouteInfo`                  | interface |
| `RouteSchema`                | interface |
| `RouteSecurityMetadata`      | interface |
| `RouteValidationMetadata`    | interface |
| `ScheduledJob`               | interface |
| `ScheduleOptions`            | interface |
| `SerializedError`            | interface |
| `ServiceInstance`            | interface |
| `SignedUrlOptions`           | interface |
| `Some`                       | interface |
| `SpanContext`                | interface |
| `SpanOptions`                | interface |
| `SplitWorkerEnv`             | interface |
| `SrvRecord`                  | interface |
| `SseChannel`                 | interface |
| `SseMessage`                 | interface |
| `StartOptions`               | interface |
| `StatResult`                 | interface |
| `SubscribeOptions`           | interface |
| `TaskPoolStats`              | interface |
| `TelemetryContext`           | interface |
| `ValidationIssue`            | interface |
| `ValueProvider`              | interface |
| `WebSocketCloseEvent`        | interface |
| `WebSocketConnectionContext` | interface |
| `WebSocketEventSink`         | interface |
| `WebSocketHandlers`          | interface |
| `WebSocketRoom`              | interface |
| `WebSocketRouteOptions`      | interface |
| `WebSocketUpgradeIntent`     | interface |
| `WorkerErrorShape`           | interface |
| `WorkerReadySignal`          | interface |
| `WorkerRunOptions`           | interface |
| `WorkerTaskReply`            | interface |
| `WorkerTaskRequest`          | interface |
| `WrapOptions`                | interface |
| `BackoffStrategy`            | type      |
| `CapabilityToken`            | type      |
| `ChannelSendResult`          | type      |
| `CircuitState`               | type      |
| `CliCommandHandler`          | type      |
| `Constructor`                | type      |
| `CursorValue`                | type      |
| `DecoratorHandler`           | type      |
| `EntityKey`                  | type      |
| `EventHandler`               | type      |
| `FilterComparison`           | type      |
| `FilterExpression`           | type      |
| `FilterOperator`             | type      |
| `GraphqlSubscriptionOutcome` | type      |
| `GrpcServingStatus`          | type      |
| `HardenedCall`               | type      |
| `HealthIndicatorFn`          | type      |
| `HealthStatus`               | type      |
| `HttpMethod`                 | type      |
| `IngressKind`                | type      |
| `JobProcessor`               | type      |
| `JsonValue`                  | type      |
| `LifecyclePhase`             | type      |
| `LoadBalanceStrategy`        | type      |
| `LogLevel`                   | type      |
| `LogMetadata`                | type      |
| `MessageHandler`             | type      |
| `MetricType`                 | type      |
| `MiddlewareFunction`         | type      |
| `NextFunction`               | type      |
| `Option`                     | type      |
| `OrderDirection`             | type      |
| `PluginPriority`             | type      |
| `Provider`                   | type      |
| `RealtimeFrameHandler`       | type      |
| `RealtimeFrameKind`          | type      |
| `RegistryFactory`            | type      |
| `RequestHandler`             | type      |
| `ResilientCall`              | type      |
| `ResponseSnapshot`           | type      |
| `Result`                     | type      |
| `RouteHandler`               | type      |
| `RpcFetchHandler`            | type      |
| `RuntimePlatform`            | type      |
| `RuntimeSignal`              | type      |
| `SchedulerBackoff`           | type      |
| `SchedulerJobHandler`        | type      |
| `SecurityRequirement`        | type      |
| `ServerHandle`               | type      |
| `ServiceFactory`             | type      |
| `ServiceOutcome`             | type      |
| `ServiceScope`               | type      |
| `SessionData`                | type      |
| `SessionView`                | type      |
| `SpanAttributeValue`         | type      |
| `SpanKind`                   | type      |
| `SpanStatus`                 | type      |
| `StandardCapability`         | type      |
| `TimerHandle`                | type      |
| `Unsubscribe`                | type      |
| `ValidationTarget`           | type      |
| `WebSocketGuardDecision`     | type      |
| `WebSocketReadyState`        | type      |
| `WebSocketUpgradeDecision`   | type      |
| `WebSocketUpgradeGuard`      | type      |
| `WebSocketUpgradeRouter`     | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.
