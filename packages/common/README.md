# @setu-ts/common

`IRuntimeServices.reportError?` is the optional last-resort JSON error sink used by the kernel and
`errorHandler` when no logger is registered. Implementations contain serialization and write
failures. `IErrorResponder.statusFor?` purely predicts the owner's served status for a thrown value;
request logging consumes it without reporting a clamp twice. A custom response hook can serve a
different status, which the predictor does not reflect.

Shared types, interfaces, and capability tokens for the Setu-TS framework.

This package is the framework's contract layer: every other package depends on it, and it depends on
nothing. It contains only interfaces, type aliases, constants, and pure zero-dependency type
utilities — no runtime behavior beyond those.

## Installation

```bash
# npm (pnpm add / yarn add / bun add work the same way)
npm install @setu-ts/common

# Deno
deno add npm:@setu-ts/common
```

## What's Inside

`OptionalDependencyUnavailableError(dependency, { cause?, requiredBy? })` preserves `dependency` and
the original `cause`. Since 0.11.0, loaders pass their npm package name as `requiredBy` to make the
message actionable; it is used only in the message, with no new instance field:
`Optional dependency 'ioredis' could not be loaded by '@setu-ts/cache-plugin'. Install it where '@setu-ts/cache-plugin' is installed, in the version range that package declares for it — in an npm, Yarn or Bun workspace that is usually the workspace root, not the member — or choose an option that does not need it on this runtime.`
Without `requiredBy`, the message says `the package that loads it` generically.

| Area                | Exports                                                                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability tokens   | `CAPABILITIES`, `createCapabilityToken()`, `CapabilityToken`, `StandardCapability`                                                                                                                                                                                                           |
| Plugin contract     | `IPlugin`, `IPluginContext`, `IApplication`, context APIs (`IRouterApi`, `IMiddlewareApi`, `ILifecycleApi`, …)                                                                                                                                                                               |
| Service registry    | `IServiceRegistry`, `RegisterOptions`, `ServiceFactory`                                                                                                                                                                                                                                      |
| HTTP abstractions   | `IRequest`, `IResponse`, `IRequestContext`, `IMiddleware`, `MiddlewareFunction`, `RouteHandler`, `RouteDefinition`, `ResponseSnapshot`, `ResponseSnapshotInit`                                                                                                                               |
| Runtime abstraction | `IRuntimeServices`, `IFileSystem`, `IHttpAdapter`                                                                                                                                                                                                                                            |
| Optional DI         | `IContainer`, `Provider`, `ServiceScope`, `createToken`, `InjectionToken`, `ContainerToken`, `InjectEntry`                                                                                                                                                                                   |
| Domain contracts    | `ILogger`, `IConfig`, `IValidationService`, `IHealthIndicator`, `IMetric`, `IJwtService`, `IOrmAdapter`, `ICacheStore`, `IEventBus`, `IMessageBroker`, `IQueue`, `ISecretManager`, `IAuditLogger`, `ICircuitBreaker`, `IStorage`, `IMailer`, `INotifier`, `IFeatureFlags`, `ITenantResolver` |
| Shared types        | `HttpMethod`, `RuntimePlatform`, `LogLevel`, `LifecyclePhase`, `HealthStatus`, `MetricType`, `PLUGIN_PRIORITY`                                                                                                                                                                               |
| Utility types       | `Result<T, E>` (`ok`, `err`, `isOk`, `isErr`, `unwrap`), `Option<T>` (`some`, `none`, `isSome`, `isNone`, `fromNullable`), `PathPattern` (`createPathMatcher`)                                                                                                                               |

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

### Response snapshots

`IResponse.snapshot().headers` is the documented live `Headers` view for middleware and application
code. `ResponseSnapshot.responseInit` is an `@internal` kernel-to-runtime optimization hint:
adapters may use its snapshot-local header input while constructing a native response, including
adding derived headers such as `Content-Length`. Do not consume it from application or middleware
code.

## Rules

- Zero dependencies, always.
- No runtime-specific APIs — ever.
- Every export is public API: documented in the repository's `PUBLIC_API.md`, JSDoc'd, and covered
  by the backward-compatibility policy.

## Ingress behaviours

`IngressKind`, `IngressContext`, `IIngressBehavior`, `BehaviorLike`, and `composeBehaviorChain`
provide one transport-neutral, void-result behaviour chain for queue jobs, scheduler fires, broker
deliveries, and WebSocket frames. An `IngressContext` contains only `kind`, `name`, `payload`, and
the optional `attempt`, `headers` and `consumer` fields. Behaviours run in declared order; returning
without `next()` short-circuits the native handler.

`consumer` (M109a) is a dispatch identity, not a capability or state bag: the subscription's
`SubscribeOptions.queue` when given, otherwise `subscription:<instance>:<n>` on `'messaging'`, and
the job name on `'queue'`; absent on `'scheduler'` and `'websocket'`. It exists so per-consumer
state (an idempotency record) is keyed per subscriber rather than per topic.

`WebSocketUpgradeGuard` and `WebSocketGuardDecision` are the separate, route-scoped handshake guard
types. They run before an accepted upgrade; they are not frame behaviours.

### Idempotency (M109a)

`CAPABILITIES.IDEMPOTENCY` (`'idempotency'`) names the provider of the idempotency service. The
`common` package holds only the contracts — the store port `IIdempotencyStore` and its
`IdempotencyClaimRequest`, `IdempotencyClaimResult` and `IdempotencySettleResult` types, the service
contract `IIdempotencyService`, the route option type `IdempotentRouteOptions` with
`IdempotencyKeySource` and `IdempotencyFingerprintSource`, and the ingress option types
`IdempotentIngressOptions` (with its shared half `IdempotentIngressCommonOptions`),
`IngressIdempotencyKeySource` and `IngressIdempotencyFingerprintSource`. The mechanism —
`IdempotencyPlugin`, `idempotent()`, `idempotentIngress()` and `@Idempotent` — lives in
`@setu-ts/idempotency-plugin`. The guarantee is **no duplicate processing within the limits of the
store** — it is not a single-execution guarantee.

### Error diagnostics

`serializeError()` preserves ordinary error fields plus a deliberately small classifier allowlist:
`code`, `errno`, `syscall`, `severity`, `constraint`, `codeName`, and `statusCode`. Only strings,
finite numbers, and booleans are kept; objects such as driver query payloads and `$metadata` are
omitted. Classifier strings are capped at 512 Unicode code points, aggregate errors keep at most
eight direct members, and the complete serialized tree is bounded to 64 nodes. An aggregate that is
truncated reports `omittedErrorCount`.

## Redaction

Classification and redaction live in `@setu-ts/common` so every egress plugin shares one policy
shape. A `RedactionPolicy` maps dot-path field patterns to a classification, and classifications to
redactors:

| Member            | Meaning                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `fields`          | Dot-path patterns, each mapped to a classification or to a `FieldRedaction` |
| `redactors`       | Redactor selected by the classification a matched pattern carries           |
| `defaultRedactor` | Fallback used when `redactors` has no entry for that classification         |

A `fields` value is either a classification string (`'pii'`) or a `FieldRedaction`
(`{ classification, redactor? }`). The object form lets one classification carry two treatments —
mask the email, erase the name — without inventing a second classification string. `redactValue` and
`redactRecord` select a redactor in this order: the matched field's own `redactor`, then
`redactors[classification]`, then `defaultRedactor`, then `eraseRedactor`.

The framework knows four classifications — `DATA_CLASSIFICATIONS.PII` (`'pii'`), `PHI` (`'phi'`),
`PCI` (`'pci'`) and `SECRET` (`'secret'`) — and accepts any other string, which reaches
`redactors[<string>]`.

```typescript
import { createMaskRedactor, createRedactionService, DATA_CLASSIFICATIONS } from '@setu-ts/common';

const service = createRedactionService({
  fields: {
    'user.email': {
      classification: DATA_CLASSIFICATIONS.PII,
      redactor: createMaskRedactor({ keep: 4 }),
    },
    'user.name': DATA_CLASSIFICATIONS.PII,
    'auth.token': DATA_CLASSIFICATIONS.SECRET,
  },
});

service.redactRecord({ user: { email: 'jane@example.com', name: 'Jane' } });
```

The precedence above is executable:

<!-- assert:js -->

| Expression                                                                                                                                                                                                                                     | Value                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `(await import('@setu-ts/common')).createRedactionService({ fields: { email: { classification: 'pii', redactor: () => 'field' } }, redactors: { pii: () => 'class' } }).redactValue('email', 'x')`                                             | `"field"`            |
| `(await import('@setu-ts/common')).createRedactionService({ fields: { name: { classification: 'pii' } }, redactors: { pii: () => 'class' } }).redactValue('name', 'x')`                                                                        | `"class"`            |
| `(await import('@setu-ts/common')).createRedactionService({ fields: { name: { classification: 'pii' } }, defaultRedactor: () => 'default' }).redactValue('name', 'x')`                                                                         | `"default"`          |
| `(await import('@setu-ts/common')).createRedactionService({ fields: { token: { classification: 'secret' } } }).redactValue('token', 'x')`                                                                                                      | `"[Redacted]"`       |
| `(await import('@setu-ts/common')).createRedactionService({ fields: { 'user.email': { classification: 'pii', redactor: (await import('@setu-ts/common')).createMaskRedactor({ keep: 4 }) } } }).redactValue('user.email', 'jane@example.com')` | `"************.com"` |

See the repository's
[`PUBLIC_API.md`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#redaction) for the
`FieldRedaction` type, the classification table, and the full contract, and
[`ARCHITECTURE.md`](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md) for how this
package fits the plugin architecture.

## Exports

| Export                                | Kind      |
| ------------------------------------- | --------- |
| `assertPrimaryKeyUnchanged`           | function  |
| `assertRealPathContained`             | function  |
| `attachConnectionErrorReporter`       | function  |
| `authorizationFailureInit`            | function  |
| `brandErrorResponder`                 | function  |
| `causeMessage`                        | function  |
| `checkWritePrecondition`              | function  |
| `compileRealtimeDiagnosticsAlias`     | function  |
| `composeBehaviorChain`                | function  |
| `contentTypeFor`                      | function  |
| `contextToTraceparent`                | function  |
| `createCachedProbe`                   | function  |
| `createCapabilityToken`               | function  |
| `createConnectionErrorReporter`       | function  |
| `createMaskRedactor`                  | function  |
| `createPathMatcher`                   | function  |
| `createRealtimeHandlerErrorReporter`  | function  |
| `createRealtimeObservationCollector`  | function  |
| `createRedactionService`              | function  |
| `createToken`                         | function  |
| `deadlineRangeError`                  | function  |
| `decodeCursor`                        | function  |
| `decodeFrameData`                     | function  |
| `describeError`                       | function  |
| `dispatchRealtimeFrame`               | function  |
| `encodeCursor`                        | function  |
| `encodeFrameData`                     | function  |
| `eraseRedactor`                       | function  |
| `err`                                 | function  |
| `errorResponderOf`                    | function  |
| `extractContextFromHeaders`           | function  |
| `formEncodingOf`                      | function  |
| `fromNodeRedis`                       | function  |
| `fromNullable`                        | function  |
| `fullJitterDelay`                     | function  |
| `hasForbiddenAliasCharacter`          | function  |
| `httpStatusHintOf`                    | function  |
| `installRequestIdentityGuard`         | function  |
| `isConnectionFault`                   | function  |
| `isConnectionFaultCode`               | function  |
| `isErr`                               | function  |
| `isLexicallyContained`                | function  |
| `isNone`                              | function  |
| `isOk`                                | function  |
| `isPromiseLike`                       | function  |
| `isScopeType`                         | function  |
| `isSome`                              | function  |
| `isValidPublishId`                    | function  |
| `isWebSocketUpgradeRequest`           | function  |
| `isWorkerReadySignal`                 | function  |
| `isWorkerTaskReply`                   | function  |
| `isWorkerTaskRequest`                 | function  |
| `keysetPredicate`                     | function  |
| `mintNextCursor`                      | function  |
| `none`                                | function  |
| `ok`                                  | function  |
| `parseCookie`                         | function  |
| `parseEnv`                            | function  |
| `parseFormBody`                       | function  |
| `parseJsonBody`                       | function  |
| `parsePublishOptions`                 | function  |
| `parseTraceparentToContext`           | function  |
| `publicRequestUrl`                    | function  |
| `publishHeaderNameProblem`            | function  |
| `publishHeaderValueProblem`           | function  |
| `publishIdProblem`                    | function  |
| `replaceLocale`                       | function  |
| `replacePrincipal`                    | function  |
| `replaceTenant`                       | function  |
| `requestOriginOf`                     | function  |
| `resolveKeysetSort`                   | function  |
| `resolveProbeTiming`                  | function  |
| `resolveRegistryEntry`                | function  |
| `resolveResponseStatus`               | function  |
| `respondWithAuthorizationFailure`     | function  |
| `respondWithError`                    | function  |
| `responseMetadataOf`                  | function  |
| `scopedPermissionAbility`             | function  |
| `scopedRoleAbility`                   | function  |
| `scopeFromParam`                      | function  |
| `scopeFromTenant`                     | function  |
| `sealRequestIdentity`                 | function  |
| `securityMetadataOf`                  | function  |
| `serializeCookie`                     | function  |
| `serializeError`                      | function  |
| `setUpgradeIntent`                    | function  |
| `some`                                | function  |
| `sortFingerprint`                     | function  |
| `splitWorkerEnv`                      | function  |
| `tenantBindingMismatch`               | function  |
| `unwrap`                              | function  |
| `upgradeIntentOf`                     | function  |
| `validatedStateKey`                   | function  |
| `validationMetadataOf`                | function  |
| `withDeadline`                        | function  |
| `withHttpStatusHint`                  | function  |
| `withResponseMetadata`                | function  |
| `withSecurityMetadata`                | function  |
| `withValidationMetadata`              | function  |
| `DuplicateKeyError`                   | class     |
| `InvalidCursorError`                  | class     |
| `InvalidFieldValueError`              | class     |
| `MalformedRequestBodyError`           | class     |
| `OptionalDependencyUnavailableError`  | class     |
| `PrimaryKeyChangeError`               | class     |
| `ReconnectSupervisor`                 | class     |
| `UnknownPayloadFieldError`            | class     |
| `UnsupportedFormEncodingError`        | class     |
| `CAPABILITIES`                        | const     |
| `CLIENT_IP_STATE_KEY`                 | const     |
| `CREDENTIAL_SOURCE_STATE_KEY`         | const     |
| `DATA_CLASSIFICATIONS`                | const     |
| `DEDUPLICATION_ID_HEADER`             | const     |
| `DEFAULT_SECRET_FIELD_PATTERNS`       | const     |
| `ERROR_RESPONDER_BRAND`               | const     |
| `ERROR_RESPONDER_STATE_KEY`           | const     |
| `HTTP_STATUS_HINT`                    | const     |
| `IDEMPOTENCY_RECORD_KIND`             | const     |
| `INBOX_RECORD_KIND`                   | const     |
| `MAX_PUBLISH_HEADER_NAME_BYTES`       | const     |
| `MAX_PUBLISH_HEADER_VALUE_BYTES`      | const     |
| `MAX_PUBLISH_HEADERS`                 | const     |
| `MAX_PUBLISH_ID_BYTES`                | const     |
| `MAX_SCOPE_ID_LENGTH`                 | const     |
| `ORDERING_KEY_HEADER`                 | const     |
| `OUTBOX_RECORD_KIND`                  | const     |
| `PLUGIN_PRIORITY`                     | const     |
| `REQUEST_ORIGIN_STATE_KEY`            | const     |
| `RESERVED_HEADER_NAMES`               | const     |
| `RESERVED_HEADER_PREFIXES`            | const     |
| `RESPONSE_METADATA`                   | const     |
| `SCOPED_RBAC_POLICY`                  | const     |
| `SECURITY_METADATA`                   | const     |
| `SESSION_STATE_KEY`                   | const     |
| `SESSION_TENANT_BINDING_KEY`          | const     |
| `SESSION_TENANT_BINDING_STATE_KEY`    | const     |
| `TELEMETRY_CONTEXT_OPAQUE`            | const     |
| `TRACEPARENT_HEADER`                  | const     |
| `TRACESTATE_HEADER`                   | const     |
| `UPGRADE_INTENT`                      | const     |
| `VALIDATION_METADATA`                 | const     |
| `AddJobOptions`                       | interface |
| `AuditEntry`                          | interface |
| `AuthorizationDecisionObservation`    | interface |
| `AuthorizationDecisionStep`           | interface |
| `AuthorizationDiagnosticsBatch`       | interface |
| `BehaviorLike`                        | interface |
| `BulkheadPolicy`                      | interface |
| `CacheDiagnosticsRecord`              | interface |
| `CacheDiagnosticsResponse`            | interface |
| `CacheDiagnosticsSnapshot`            | interface |
| `CachedProbeOptions`                  | interface |
| `CircuitBreakerPolicy`                | interface |
| `ClassProvider`                       | interface |
| `ConfigDiagnosticsSnapshot`           | interface |
| `ConfigProvenanceEntry`               | interface |
| `ConnectionErrorReporter`             | interface |
| `ConnectionErrorReporterOptions`      | interface |
| `CookieAttributes`                    | interface |
| `CqrsCommand`                         | interface |
| `CqrsQuery`                           | interface |
| `CqrsRequest`                         | interface |
| `CursorPayload`                       | interface |
| `DeadlineOptions`                     | interface |
| `DiagnosticsBatch`                    | interface |
| `DiagnosticsEdge`                     | interface |
| `DiagnosticsEvent`                    | interface |
| `DiagnosticsNode`                     | interface |
| `DiagnosticsSnapshot`                 | interface |
| `EncodedPayload`                      | interface |
| `EnvVarSpec`                          | interface |
| `Err`                                 | interface |
| `ErrorResponderTarget`                | interface |
| `ErrorResponseInit`                   | interface |
| `EventDiagnosticsRecord`              | interface |
| `EventDiagnosticsResponse`            | interface |
| `EventDiagnosticsSnapshot`            | interface |
| `FactoryProvider`                     | interface |
| `FieldRedaction`                      | interface |
| `FlagContext`                         | interface |
| `FormBody`                            | interface |
| `FormFile`                            | interface |
| `GraphqlConnectionInfo`               | interface |
| `GraphqlExecutionOutcome`             | interface |
| `GraphqlExecutionResult`              | interface |
| `GraphqlFormattedError`               | interface |
| `GraphqlOperationContext`             | interface |
| `GraphqlRequestParams`                | interface |
| `GrpcServiceDefinition`               | interface |
| `HandlerResult`                       | interface |
| `HealthCheckResult`                   | interface |
| `HealthDiagnosticsObservation`        | interface |
| `HealthDiagnosticsSnapshot`           | interface |
| `HealthIndicatorOptions`              | interface |
| `HealthReport`                        | interface |
| `HttpStatusHint`                      | interface |
| `IAdapterTransaction`                 | interface |
| `IApplication`                        | interface |
| `IAuditLogger`                        | interface |
| `IAuthorizationDiagnosticsSource`     | interface |
| `IAuthorizationPolicyService`         | interface |
| `IAuthorizationService`               | interface |
| `IAuthService`                        | interface |
| `IAuthSessionService`                 | interface |
| `IAuthStrategy`                       | interface |
| `ICacheDiagnosticsSource`             | interface |
| `ICacheStore`                         | interface |
| `ICircuitBreaker`                     | interface |
| `ICliApi`                             | interface |
| `ICommandBus`                         | interface |
| `ICommandHandler`                     | interface |
| `IConfig`                             | interface |
| `IConfigDiagnosticsSource`            | interface |
| `IContainer`                          | interface |
| `ICounter`                            | interface |
| `ICqrsFacade`                         | interface |
| `IDatabaseAdapter`                    | interface |
| `IDataSource`                         | interface |
| `IDecoratorApi`                       | interface |
| `IdempotencyClaimRequest`             | interface |
| `IdempotentIngressCommonOptions`      | interface |
| `IdempotentRouteOptions`              | interface |
| `IdempotentWithinOptions`             | interface |
| `IdempotentWithinResult`              | interface |
| `IDiagnosticsSource`                  | interface |
| `IDnsResolver`                        | interface |
| `IDomainEvent`                        | interface |
| `IEnvironmentApi`                     | interface |
| `IErrorResponder`                     | interface |
| `IEventBus`                           | interface |
| `IEventDiagnosticsSource`             | interface |
| `IFeatureFlags`                       | interface |
| `IFileSystem`                         | interface |
| `IGauge`                              | interface |
| `IGrantSource`                        | interface |
| `IGraphqlService`                     | interface |
| `IGrpcService`                        | interface |
| `IHealthApi`                          | interface |
| `IHealthDiagnosticsSource`            | interface |
| `IHealthIndicator`                    | interface |
| `IHealthService`                      | interface |
| `IHistogram`                          | interface |
| `IHttpAdapter`                        | interface |
| `IIdempotencyService`                 | interface |
| `IIdempotencyStore`                   | interface |
| `IInboxStore`                         | interface |
| `IIngressBehavior`                    | interface |
| `IJob`                                | interface |
| `IJwtService`                         | interface |
| `ILifecycleApi`                       | interface |
| `ILocalDiagnosticsListener`           | interface |
| `ILocalDiagnosticsListenerFactory`    | interface |
| `ILocalizer`                          | interface |
| `ILogger`                             | interface |
| `IMailer`                             | interface |
| `IMessageBroker`                      | interface |
| `IMetadataStore`                      | interface |
| `IMetric`                             | interface |
| `IMetricsApi`                         | interface |
| `IMetricsService`                     | interface |
| `IMiddleware`                         | interface |
| `IMiddlewareApi`                      | interface |
| `IMultiTenancyService`                | interface |
| `InboxFailureUpdate`                  | interface |
| `InboxIds`                            | interface |
| `InboxRecord`                         | interface |
| `InboxStoreStats`                     | interface |
| `IngressContext`                      | interface |
| `InjectionToken`                      | interface |
| `INotifier`                           | interface |
| `IOpenApiApi`                         | interface |
| `IOrmAdapter`                         | interface |
| `IOutboundHttpDiagnosticsSource`      | interface |
| `IOutboxStore`                        | interface |
| `IOutboxWriteScope`                   | interface |
| `IPipelineBehavior`                   | interface |
| `IPlugin`                             | interface |
| `IPluginContext`                      | interface |
| `IPrincipal`                          | interface |
| `IQueryBus`                           | interface |
| `IQueryHandler`                       | interface |
| `IQueue`                              | interface |
| `IQueueDiagnosticsSource`             | interface |
| `IRealtimeBackplane`                  | interface |
| `IRealtimeDiagnosticsSource`          | interface |
| `IRealtimeHandlerErrorReporter`       | interface |
| `IRealtimeObservationCollector`       | interface |
| `IRedactionService`                   | interface |
| `IRequest`                            | interface |
| `IRequestContext`                     | interface |
| `IResilienceService`                  | interface |
| `IResponse`                           | interface |
| `IRouterApi`                          | interface |
| `IRuntimeServices`                    | interface |
| `IScheduler`                          | interface |
| `ISchedulerDiagnosticsSource`         | interface |
| `IScopedRoleSource`                   | interface |
| `ISecretManager`                      | interface |
| `IServiceDiscovery`                   | interface |
| `IServiceRegistry`                    | interface |
| `ISession`                            | interface |
| `ISessionService`                     | interface |
| `ISessionStore`                       | interface |
| `ISpan`                               | interface |
| `ISseConnection`                      | interface |
| `ISseService`                         | interface |
| `ISsrService`                         | interface |
| `IStorage`                            | interface |
| `IStorageDiagnosticsSource`           | interface |
| `ISubscription`                       | interface |
| `ISummary`                            | interface |
| `ITelemetryService`                   | interface |
| `ITenant`                             | interface |
| `ITenantDataStore`                    | interface |
| `ITenantRepository`                   | interface |
| `ITenantResolver`                     | interface |
| `ITraceDiagnosticsSource`             | interface |
| `ITransaction`                        | interface |
| `ITransactionalIdempotencyStore`      | interface |
| `ITransactionIsolationSupport`        | interface |
| `IValidationService`                  | interface |
| `IViewEngine`                         | interface |
| `IWebSocketConnection`                | interface |
| `IWebSocketService`                   | interface |
| `IWebSocketTransport`                 | interface |
| `IWorkerHandle`                       | interface |
| `IWorkerHost`                         | interface |
| `IWorkerPool`                         | interface |
| `JwtSignOptions`                      | interface |
| `LocalDiagnosticsListenerOptions`     | interface |
| `MailMessage`                         | interface |
| `MaskOptions`                         | interface |
| `MessageMetadata`                     | interface |
| `MetricConfig`                        | interface |
| `MetricOptions`                       | interface |
| `MiddlewareOptions`                   | interface |
| `None`                                | interface |
| `NormalizedQuery`                     | interface |
| `NotificationMessage`                 | interface |
| `Ok`                                  | interface |
| `OutboundHttpDiagnosticsRecord`       | interface |
| `OutboundHttpDiagnosticsResponse`     | interface |
| `OutboundHttpDiagnosticsSnapshot`     | interface |
| `OutboxKey`                           | interface |
| `OutboxRecord`                        | interface |
| `OutboxStoreStats`                    | interface |
| `PageResult`                          | interface |
| `ParsedPublishOptions`                | interface |
| `PendingSignIn`                       | interface |
| `PickOptions`                         | interface |
| `PluralForms`                         | interface |
| `PolicyAbilityInfo`                   | interface |
| `PolicyDefinition`                    | interface |
| `ProbeTiming`                         | interface |
| `ProcessOptions`                      | interface |
| `ProviderOptions`                     | interface |
| `PublishOptions`                      | interface |
| `PutObjectOptions`                    | interface |
| `QueueAttemptObservation`             | interface |
| `QueueDepthObservation`               | interface |
| `QueueDiagnosticsBatch`               | interface |
| `QueueDiagnosticsSourceBatch`         | interface |
| `QueueDiagnosticsSourceStatus`        | interface |
| `QueueSourceAttemptObservation`       | interface |
| `QueueSourceDepthObservation`         | interface |
| `RbacConfig`                          | interface |
| `RealtimeDiagnosticsGauges`           | interface |
| `RealtimeDiagnosticsOptions`          | interface |
| `RealtimeDiagnosticsRecord`           | interface |
| `RealtimeDiagnosticsResponse`         | interface |
| `RealtimeDiagnosticsSnapshot`         | interface |
| `RealtimeFrame`                       | interface |
| `RealtimeGaugeReading`                | interface |
| `RealtimeHandlerErrorReporterOptions` | interface |
| `RealtimeObservationCollectorInit`    | interface |
| `ReconnectSupervisorOptions`          | interface |
| `RecurringOptions`                    | interface |
| `RedactionContext`                    | interface |
| `RedactionPolicy`                     | interface |
| `RegisterOptions`                     | interface |
| `RequestOptions`                      | interface |
| `RetryOptions`                        | interface |
| `RetryPolicy`                         | interface |
| `RoleDefinition`                      | interface |
| `RoomBroadcastOptions`                | interface |
| `RouteDefinition`                     | interface |
| `RouteInfo`                           | interface |
| `RouteResponseMetadata`               | interface |
| `RouteSchema`                         | interface |
| `RouteSecurityMetadata`               | interface |
| `RouteValidationMetadata`             | interface |
| `ScheduledJob`                        | interface |
| `ScheduleOptions`                     | interface |
| `SchedulerDiagnosticsRecord`          | interface |
| `SchedulerDiagnosticsResponse`        | interface |
| `SchedulerDiagnosticsSnapshot`        | interface |
| `ScopedGrant`                         | interface |
| `ScopedRbacTarget`                    | interface |
| `ScopedRoleDefinition`                | interface |
| `ScopeRef`                            | interface |
| `SerializedError`                     | interface |
| `ServiceInstance`                     | interface |
| `SignedUrlOptions`                    | interface |
| `SignInOptions`                       | interface |
| `Some`                                | interface |
| `SpanContext`                         | interface |
| `SpanOptions`                         | interface |
| `SplitWorkerEnv`                      | interface |
| `SrvRecord`                           | interface |
| `SseChannel`                          | interface |
| `SseMessage`                          | interface |
| `StartOptions`                        | interface |
| `StatResult`                          | interface |
| `StorageDiagnosticsRecord`            | interface |
| `StorageDiagnosticsResponse`          | interface |
| `StorageDiagnosticsSnapshot`          | interface |
| `SubscribeOptions`                    | interface |
| `TaskPoolStats`                       | interface |
| `TelemetryContext`                    | interface |
| `TraceDiagnosticsBatch`               | interface |
| `TraceLinkRelationship`               | interface |
| `TraceObservation`                    | interface |
| `TraceparentSource`                   | interface |
| `TraceSamplerDescription`             | interface |
| `TransactionalIdempotencyClaim`       | interface |
| `TransactionalIdempotencyRecord`      | interface |
| `TransactionOptions`                  | interface |
| `ValidationIssue`                     | interface |
| `ValidationMiddlewareOptions`         | interface |
| `ValueProvider`                       | interface |
| `WebSocketCloseEvent`                 | interface |
| `WebSocketConnectionContext`          | interface |
| `WebSocketEventSink`                  | interface |
| `WebSocketHandlers`                   | interface |
| `WebSocketRoom`                       | interface |
| `WebSocketRouteOptions`               | interface |
| `WebSocketUpgradeIntent`              | interface |
| `WorkerErrorShape`                    | interface |
| `WorkerReadySignal`                   | interface |
| `WorkerRunOptions`                    | interface |
| `WorkerTaskReply`                     | interface |
| `WorkerTaskRequest`                   | interface |
| `WrapOptions`                         | interface |
| `AnonymousPolicyCheck`                | type      |
| `AuthMethod`                          | type      |
| `AuthorizationCoverage`               | type      |
| `AuthorizationDecisionOperation`      | type      |
| `AuthorizationDecisionReason`         | type      |
| `AuthorizationFailure`                | type      |
| `AuthorizationSourceState`            | type      |
| `BackoffStrategy`                     | type      |
| `CacheDiagnosticsOperation`           | type      |
| `CapabilityToken`                     | type      |
| `ChannelSendResult`                   | type      |
| `CircuitState`                        | type      |
| `CliCommandHandler`                   | type      |
| `Component`                           | type      |
| `ConfigProvenanceOrigin`              | type      |
| `ConfigSchemaEffect`                  | type      |
| `ConnectionErrorLogger`               | type      |
| `Constructor`                         | type      |
| `ContainerToken`                      | type      |
| `CursorValue`                         | type      |
| `DataClassification`                  | type      |
| `DecoratorHandler`                    | type      |
| `DiagnosticsEdgeKind`                 | type      |
| `DiagnosticsEventKind`                | type      |
| `DiagnosticsEventOutcome`             | type      |
| `DiagnosticsEventStage`               | type      |
| `DiagnosticsFailureCode`              | type      |
| `DiagnosticsInspectorState`           | type      |
| `DiagnosticsNodeKind`                 | type      |
| `DiagnosticsSnapshotState`            | type      |
| `EntityKey`                           | type      |
| `EventDiagnosticsCoverage`            | type      |
| `EventDiagnosticsState`               | type      |
| `EventHandler`                        | type      |
| `EventObservationOperation`           | type      |
| `FilterComparison`                    | type      |
| `FilterExpression`                    | type      |
| `FilterOperator`                      | type      |
| `FormEncoding`                        | type      |
| `FormValue`                           | type      |
| `GrantQuery`                          | type      |
| `GraphqlSubscriptionOutcome`          | type      |
| `GrpcServingStatus`                   | type      |
| `HardenedCall`                        | type      |
| `HealthIndicatorFn`                   | type      |
| `HealthObservationState`              | type      |
| `HealthStatus`                        | type      |
| `HttpMethod`                          | type      |
| `IdempotencyClaimResult`              | type      |
| `IdempotencyFingerprintSource`        | type      |
| `IdempotencyKeySource`                | type      |
| `IdempotencySettleResult`             | type      |
| `IdempotentIngressOptions`            | type      |
| `InboxReleaseOutcome`                 | type      |
| `InboxStatus`                         | type      |
| `IngressIdempotencyFingerprintSource` | type      |
| `IngressIdempotencyKeySource`         | type      |
| `IngressKind`                         | type      |
| `InjectEntry`                         | type      |
| `ITenantIsolationStrategy`            | type      |
| `JobProcessor`                        | type      |
| `JsonValue`                           | type      |
| `LifecyclePhase`                      | type      |
| `LoadBalanceStrategy`                 | type      |
| `LocalizationMessage`                 | type      |
| `LogLevel`                            | type      |
| `LogMetadata`                         | type      |
| `MessageCatalogue`                    | type      |
| `MessageHandler`                      | type      |
| `MetricType`                          | type      |
| `MiddlewareFunction`                  | type      |
| `NextFunction`                        | type      |
| `NodeRedisAdapter`                    | type      |
| `NodeRedisAdapterOptions`             | type      |
| `NodeRedisClientLike`                 | type      |
| `Option`                              | type      |
| `OrderDirection`                      | type      |
| `OutboundHttpStatusClass`             | type      |
| `OutboxStatus`                        | type      |
| `OutboxTransition`                    | type      |
| `PathPattern`                         | type      |
| `PluginPriority`                      | type      |
| `PolicyAbility`                       | type      |
| `PolicyCheck`                         | type      |
| `PolicyRef`                           | type      |
| `PolicyTarget`                        | type      |
| `Provider`                            | type      |
| `QueueDepthCoverage`                  | type      |
| `QueueDepthCycleCoverage`             | type      |
| `QueueDepthScope`                     | type      |
| `QueueDiagnosticsFailure`             | type      |
| `QueueProcessorOutcome`               | type      |
| `QueueSettlementState`                | type      |
| `QueueSourceFailure`                  | type      |
| `QueueSourceState`                    | type      |
| `RealtimeFrameHandler`                | type      |
| `RealtimeFrameKind`                   | type      |
| `RealtimeGaugeState`                  | type      |
| `RealtimeObservationOperation`        | type      |
| `RealtimeSourceKind`                  | type      |
| `ReconnectMode`                       | type      |
| `Redactor`                            | type      |
| `RegistryFactory`                     | type      |
| `RequestHandler`                      | type      |
| `RequestOrigin`                       | type      |
| `ResilientCall`                       | type      |
| `ResponseSnapshot`                    | type      |
| `ResponseSnapshotInit`                | type      |
| `Result`                              | type      |
| `RouteHandler`                        | type      |
| `RpcFetchHandler`                     | type      |
| `RuntimePlatform`                     | type      |
| `RuntimeSignal`                       | type      |
| `SchedulerBackoff`                    | type      |
| `SchedulerDiagnosticsOperation`       | type      |
| `SchedulerJobHandler`                 | type      |
| `ScopeSource`                         | type      |
| `SecurityRequirement`                 | type      |
| `ServerHandle`                        | type      |
| `ServiceFactory`                      | type      |
| `ServiceOutcome`                      | type      |
| `ServiceScope`                        | type      |
| `SessionData`                         | type      |
| `SessionView`                         | type      |
| `SignInOutcome`                       | type      |
| `SpanAttributeValue`                  | type      |
| `SpanKind`                            | type      |
| `SpanStatus`                          | type      |
| `StandardCapability`                  | type      |
| `StorageDiagnosticsOperation`         | type      |
| `TimerHandle`                         | type      |
| `TraceCoverage`                       | type      |
| `TraceInstrumentationKind`            | type      |
| `TraceOutcome`                        | type      |
| `TraceParentVisibility`               | type      |
| `TraceSourceState`                    | type      |
| `TransactionIsolationLevel`           | type      |
| `Unsubscribe`                         | type      |
| `ValidationTarget`                    | type      |
| `WebSocketGuardDecision`              | type      |
| `WebSocketReadyState`                 | type      |
| `WebSocketUpgradeDecision`            | type      |
| `WebSocketUpgradeGuard`               | type      |
| `WebSocketUpgradeRouter`              | type      |
| `WritePrecondition`                   | type      |
| `WritePreconditionCheck`              | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Readiness and dependency outages (M113b)

`isConnectionFault(error: unknown): boolean` walks up to five cause objects, stops at cycles, and
recognises the eight node/net connection-fault codes plus measured ioredis 5 and node-redis 6 outage
rejections (closed, offline, socket closed, connect timeout, socket timeout). It never mutates
errors. Command errors such as WRONGTYPE remain unclassified.

`isConnectionFaultCode(code: unknown): boolean` returns true only for a string in the module-private
set: `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, `ENOTFOUND`,
`EAI_AGAIN`, `EPIPE`. Use the predicate instead of the removed, unreleased `CONNECTION_FAULT_CODES`
export; callers cannot mutate the classification vocabulary.

## Using node-redis (0.11.0)

Every Redis-backed plugin uses ioredis by default and takes an injected `client`. To use
[node-redis](https://www.npmjs.com/package/redis) (`redis`, v5 or v6) instead, wrap a client you
build in `fromNodeRedis` and pass it to that option:

```typescript
import { fromNodeRedis } from '@setu-ts/common';
import { createClient } from 'redis';

const url = 'redis://127.0.0.1:6379';
const cacheClient = fromNodeRedis(createClient({ url }));
const queueClient = fromNodeRedis(createClient({ url }), { commandTimeoutMs: 5_000 });
```

No Setu-TS package depends on `redis`: install it in your application. `fromNodeRedis` types its
argument structurally, and the one adapter fits every plugin's `client` option — cache, queue, Redis
Streams messaging, the realtime backplane (`client` and `subscriber`), the scheduler lock,
idempotency and the auth rate-limit store.

- **One client per plugin.** Most plugins close their client when the application stops, so a client
  shared between plugins would be closed under the others. The backplane takes two:
  `client: fromNodeRedis(base)` and `subscriber: fromNodeRedis(base.duplicate())`.
- **Lazy connect.** The adapter connects on its first command (or when a plugin calls `connect()`),
  as ioredis does by default, so building it opens no socket. A client you already connected is used
  as it is.
- **A bound on every command.** node-redis does not bound a command once it is written: against a
  paused or stopped server it waits indefinitely. The adapter rejects any command — and the lazy
  connect — after `commandTimeoutMs` (default 15 000; `0` disables; otherwise a finite number up to
  2 147 483 647, else `RangeError`) with `Error('Command timed out')`, the error ioredis raises, so
  the plugins report an outage. The command is not cancelled; a late reply is discarded. A plugin's
  own `commandTimeoutMs` option applies only to a client the plugin builds.
- **An `'error'` listener is always attached**, because node-redis rethrows an unlistened `'error'`
  event and would crash the process. `onError(error)` receives each event; without it the listener
  stays silent and failures surface through the rejected commands and health.
- **RESP3.** node-redis 6 speaks RESP3 by default, where some replies are maps. The adapter turns
  map replies back into the RESP2 shapes the plugins read, so either protocol works.
- **Closing.** `quit()` closes the client (falling back to `destroy()` when that exceeds the bound)
  and is idempotent; `status` reports `'wait'`, `'connecting'`, `'ready'` or `'end'`.

Cluster and sentinel clients (`createCluster`, `createSentinel`) are not supported.

## Portable database refusals (0.11.0)

`UnknownPayloadFieldError(entity, field, options?)` and `InvalidFieldValueError(entity, options?)`
carry fixed 400 HTTP details without caller field names or values. The former is also re-exported by
`@setu-ts/database-plugin`. `sortFingerprint(orderBy, { entity, keyColumns })` binds a cursor to its
entity, key columns and sort; omitting scope preserves the legacy string. The fingerprint checks
correctness; authorization still comes from the query's tenant predicates.
