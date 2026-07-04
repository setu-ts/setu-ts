# Hono Enterprise Framework — Architecture Review Report

**Reviewer:** Principal Software Architect\
**Scope:** Complete implementation roadmap (35 milestones, 21 packages)\
**Severity Levels:** 🔴 Critical | 🟠 High | 🟡 Medium | 🔵 Low

---

## Executive Summary

The roadmap demonstrates strong foundational thinking with clear package boundaries, SOLID-aligned
interfaces, and enterprise-grade concerns. However, several architectural issues require addressing
before implementation begins: critical circular dependency risks between `security` and `auth`
packages, Observable-based interceptor design incompatible with runtime portability, insufficient
request scoping for HTTP contexts, and missing extension points for WebSocket/SSE support.

**Overall Assessment:** The architecture is 80% production-ready. The identified issues below bring
it to 100%.

---

## 1. Package Boundaries

### Strengths

- Clear separation between abstraction (`database`) and implementation (Prisma/Drizzle adapters)
- `@hono-enterprise/common` correctly isolated as shared types only
- `@hono-enterprise/core` properly scoped to DI, modules, and application lifecycle

### Issues

#### 🔴 CRITICAL: `security` and `auth` Package Overlap

The [`security`](plans/implementation-roadmap.md#milestone-10-security-package-jwt-rbac-guards) and
[`auth`](plans/implementation-roadmap.md#milestone-11-authentication-and-authorization-middleware)
packages have severe responsibility overlap:

**`security` contains:**

- JWT strategies
- API key strategies
- Local strategies
- RBAC guard
- Permissions guard
- JWT auth guard
- API key guard
- `@CurrentUser`, `@Roles`, `@Permissions`, `@Public` decorators

**`auth` contains:**

- JWT strategy
- API key strategy
- Local strategy
- RBAC guard
- Permissions guard
- JWT auth guard
- API key guard
- `@CurrentUser`, `@Roles`, `@Permissions`, `@Public` decorators

**Same files duplicated across two packages. This is not overlap — this is duplication.**

**Recommendation:** Merge into a single `@hono-enterprise/auth` package with this internal
structure:

```
auth/
├── jwt/              # JWT service, signing, verification
├── api-key/          # API key service
├── strategies/       # Auth strategies (JWT, API Key, Local, RefreshToken)
├── guards/           # Auth guards (JWT, API Key, RBAC, Permissions)
├── rbac/             # Role and permission models + service
├── middleware/       # Authentication, Authorization, Rate Limit, Cookie Security
├── decorators/       # @CurrentUser, @Roles, @Permissions, @Public
├── interfaces/       # User, AuthRequest, Guard, ExecutionContext
└── services/         # AuthService, RolesService, JwtService, PasswordHasher
```

Remove `@hono-enterprise/security` entirely. Rename rate limiting, secure headers, and CORS to
`@hono-enterprise/http-security` since they are HTTP transport concerns, not
authentication/authorization concerns.

#### 🟠 HIGH: `decorators` Package is Too Broad

The
[`decorators`](plans/implementation-roadmap.md#milestone-2-decorators-and-metadata-registration-system)
package contains decorators from every domain:

- Module decorators
- Controller decorators
- Injection decorators
- Request data decorators
- Security decorators
- Cross-cutting decorators

This creates a **god package** where any new decorator lands. It also forces applications importing
`@Controller` to pull in metadata types for `@Cache`, `@Transactional`, `@RateLimit`, etc.

**Recommendation:** Split decorators alongside their consumers:

| Current Location                                    | Recommended Location          |
| --------------------------------------------------- | ----------------------------- |
| `@Module`, `@Global`                                | `@hono-enterprise/core`       |
| `@Controller`, `@Get`, `@Post`, etc.                | `@hono-enterprise/core`       |
| `@Injectable`, `@Inject`, `@Scope`                  | `@hono-enterprise/core`       |
| `@Body`, `@Query`, `@Param`, etc.                   | `@hono-enterprise/core`       |
| `@UseGuards`, `@UseInterceptors`, `@UseFilters`     | `@hono-enterprise/core`       |
| `@Roles`, `@Permissions`, `@CurrentUser`, `@Public` | `@hono-enterprise/auth`       |
| `@Cache`, `@CacheKey`, `@CacheTTL`                  | `@hono-enterprise/cache`      |
| `@Transactional`                                    | `@hono-enterprise/database`   |
| `@Validate`, `@ValidateBody`, etc.                  | `@hono-enterprise/validation` |
| `@Cron`, `@Every`, `@Delay`                         | `@hono-enterprise/scheduler`  |
| `@CommandHandler`, `@QueryHandler`                  | `@hono-enterprise/cqrs`       |
| `@EventHandler`                                     | `@hono-enterprise/events`     |
| `@ApiTags`, `@ApiOperation`, etc.                   | `@hono-enterprise/openapi`    |
| Metadata storage (`WeakMap`-based)                  | `@hono-enterprise/common`     |

Keep `@hono-enterprise/decorators` as a **barrel re-export** package for convenience:

```typescript
// @hono-enterprise/decorators/index.ts
export * from '@hono-enterprise/core';
export * from '@hono-enterprise/auth';
export * from '@hono-enterprise/cache';
// ... etc
```

This enables tree-shaking while providing a single import point.

#### 🟡 MEDIUM: `middleware` Package Should Not Contain Built-in Middleware

The
[`middleware`](plans/implementation-roadmap.md#milestone-4-middleware-pipeline-and-middleware-system)
package mixes pipeline infrastructure with domain-specific middleware (CORS, logging, compression).

**Recommendation:** Split into:

- `@hono-enterprise/core` — Pipeline infrastructure (`MiddlewareContext`, `MiddlewarePipeline`,
  `Middleware` interface)
- Built-in middleware distributed to owning packages:
  - `LoggingMiddleware` → `@hono-enterprise/logger`
  - `CorsMiddleware` → stays in `@hono-enterprise/core` (framework concern)
  - `SecurityHeadersMiddleware` → `@hono-enterprise/http-security` (new package, see above)
  - `CompressionMiddleware` → `@hono-enterprise/core` (framework concern)
  - `TimingMiddleware` → `@hono-enterprise/metrics`
  - `RequestIdMiddleware`, `CorrelationIdMiddleware` → `@hono-enterprise/core`

---

## 2. Dependency Direction

### Current Dependency Graph

```
core ────► common, decorators, exceptions, logger
auth ────► core, common, security
messaging ─► core, common, events, logger
health ────► core, common, cache, database, logger
```

### Issues

#### 🔴 CRITICAL: `core` Depends on `logger`

```
core ────► logger
```

This is a **dependency inversion violation**. The core framework should never depend on a concrete
logging implementation. If a user wants to use Winston instead of Pino, they cannot because `core`
is already bound to `logger`.

**Recommendation:**

1. Create `ILogger` interface in `@hono-enterprise/common`:

```typescript
export interface ILogger {
  fatal(msg: string, context?: string, metadata?: Record<string, unknown>): void;
  error(msg: string, trace?: string, context?: string, metadata?: Record<string, unknown>): void;
  warn(msg: string, context?: string, metadata?: Record<string, unknown>): void;
  info(msg: string, context?: string, metadata?: Record<string, unknown>): void;
  debug(msg: string, context?: string, metadata?: Record<string, unknown>): void;
  trace(msg: string, context?: string, metadata?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): ILogger;
}
```

2. `core` depends on `ILogger` interface from `common` only
3. `logger` package implements `ILogger`
4. Applications provide `ILogger` via DI container at bootstrap

**Updated dependency:**

```
core ────► common (ILogger interface only)
logger ──► common (implements ILogger)
```

#### 🟠 HIGH: `health` Depends on `database` and `cache` Concrete Packages

```
health ────► cache, database
```

Health indicators should depend on **interfaces**, not concrete packages. A health check for a
database should depend on `IOrmAdapter.isReady()`, not the full database package.

**Recommendation:** Health indicators depend on interfaces from `common` or the target package's
public interface. The `health` package declares peer dependencies, not hard dependencies:

```
health ────► common (interfaces only)
health has peerDependencies: cache, database, messaging
```

#### 🟠 HIGH: `messaging` Depends on `events`

```
messaging ─► events
```

This creates a coupling where messaging brokers are tied to the domain event system. In a clean
hexagonal architecture, messaging is an **infrastructure concern** and events are a **domain
concern**. The dependency should flow the other way, or not exist at all.

**Recommendation:** Decouple completely:

- `events` publishes to `IEventBus` (in-memory by default)
- `messaging` provides `IMessageBroker`
- A **bridge** package `@hono-enterprise/events-messaging-bridge` adapts `IMessageBroker` to
  `IEventBus`
- This bridge is optional and allows users to choose whether domain events go through messaging

**Updated dependency:**

```
events ────► common (no messaging dependency)
messaging ──► common (no events dependency)
events-messaging-bridge ─► events, messaging
```

#### 🟡 MEDIUM: `validation` Depends on `exceptions`

```
validation ─► exceptions
```

Validation should be able to return structured errors without depending on the full exception
hierarchy. The exception package should be an optional consumer of validation results.

**Recommendation:** `validation` returns `ValidationError[]` types. The `exceptions` package
provides `ValidationException` that wraps `ValidationError[]`. Reverse the dependency:

```
exceptions ────► validation (consumes ValidationError type)
validation ────► common (returns ValidationError[])
```

---

## 3. SOLID Compliance

### Strengths

- Interface segregation evident in `IRepository` / `IReadRepository` / `IWriteRepository`
- Dependency inversion via `HttpAdapter` interface
- Open/Closed via plugin and middleware architecture

### Issues

#### 🟠 HIGH: Single Responsibility Violation in `core` Package

`@hono-enterprise/core` contains:

- DI Container
- Module System
- Application Bootstrap
- Router
- Controller Discovery
- Parameter Resolution
- HTTP Adapters
- Request/Response Abstractions
- Interceptors
- API Versioning

This is approximately **NestJS's entire `@nestjs/core` package** in a single unit. While this
mirrors NestJS, it creates a monolithic core that is difficult to reason about and test in
isolation.

**Recommendation:** Split `core` into focused sub-packages:

| Current (in core)                                  | New Package                     |
| -------------------------------------------------- | ------------------------------- |
| DI Container                                       | `@hono-enterprise/di`           |
| Module System, Application Bootstrap               | `@hono-enterprise/application`  |
| Router, Controller Discovery, Parameter Resolution | `@hono-enterprise/router`       |
| HTTP Adapters, Request/Response                    | `@hono-enterprise/http`         |
| Middleware Pipeline                                | `@hono-enterprise/pipeline`     |
| Interceptors                                       | `@hono-enterprise/interceptors` |
| API Versioning                                     | `@hono-enterprise/versioning`   |

Keep `@hono-enterprise/core` as a **barrel re-export** that composes all sub-packages. This enables:

- Independent versioning of concerns
- Tree-shaking for unused features
- Easier testing in isolation
- Clearer package boundaries

#### 🟡 MEDIUM: Open/Closed Violation in Exception Hierarchy

The exception hierarchy uses class inheritance:

```
HttpError (base)
├── BadRequestException
│   └── ValidationException
├── UnauthorizedException
├── ForbiddenException
...
```

Inheritance-based exception hierarchies violate Open/Closed because adding new exception types
requires modifying the base class or the factory that creates them. They also create tight coupling
between the exception package and HTTP semantics.

**Recommendation:** Use composition instead:

```typescript
interface HttpError extends Error {
  httpContext: HttpContext;
  metadata: Record<string, unknown>;
}

interface HttpContext {
  statusCode: number;
  errorType: string; // 'BadRequest', 'Unauthorized', etc.
  isPublic: boolean; // Should details be exposed?
}

// Factory functions instead of classes
function createBadRequestException(message: string, errors?: unknown[]): HttpError;
function createUnauthorizedException(message: string): HttpError;
function createForbiddenException(message: string): HttpError;
function createNotFoundException(message: string): HttpError;
```

This enables:

- Custom error types without inheritance
- Runtime composition of error properties
- Easier serialization/deserialization
- No rigid hierarchy to maintain

---

## 4. Runtime Portability

### Strengths

- Runtime adapter pattern for HTTP
- Runtime-specific config loaders
- No direct Node.js API usage mentioned in core

### Issues

#### 🔴 CRITICAL: No Runtime-Independent UUID Generation

Multiple interfaces use `uuid()` for generating IDs:

- `DomainEvent` constructor uses `uuid()`
- Commands and queries have `id: string`
- Request ID middleware likely needs UUID

`uuid()` is Node.js-specific. Deno has `crypto.randomUUID()`, Bun has `crypto.randomUUID()`, but
Node.js requires `crypto.randomUUID()` (Node 19+) or the `uuid` package.

**Recommendation:** Provide `@hono-enterprise/runtime` package with:

```typescript
interface IRuntimeServices {
  uuid(): string;
  randomBytes(length: number): Uint8Array;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
  setInterval(fn: () => void, ms: number): Timer;
  clearInterval(timer: Timer): void;
  setImmediate(fn: () => void): Timer;
  clearImmediate(timer: Timer): void;
  hrtime(): [number, number];
  platform(): string;
}
```

Implement `NodeRuntimeServices`, `DenoRuntimeServices`, `BunRuntimeServices`. Auto-detect and inject
at bootstrap.

#### 🔴 CRITICAL: Interceptors Use RxJS `Observable`

The interceptor interface uses `Observable<TResult>`:

```typescript
interface NestInterceptor<TRequest = any, TResult = any> {
  intercept(
    context: ExecutionContext,
    callback: CallHandler<TRequest, TResult>,
  ): Observable<TResult>;
}
```

**RxJS is Node.js-specific and not available on Deno/Bun without polyfills.** This fundamentally
breaks runtime portability.

**Recommendation:** Use native `AsyncIterable` or `Promise`-based chaining:

```typescript
interface Interceptor<TRequest = unknown, TResult = unknown> {
  intercept(
    context: ExecutionContext,
    next: () => Promise<TResult>,
  ): Promise<TResult>;
}
```

Or for advanced use cases, provide an `AsyncIterator`-based approach:

```typescript
interface Interceptor<TRequest = unknown, TResult = unknown> {
  intercept(
    context: ExecutionContext,
    next: () => AsyncIterable<TResult>,
  ): AsyncIterable<TResult>;
}
```

#### 🟠 HIGH: File System Operations in Health Checks

`DiskHealthIndicator` implies `fs` module usage, which is runtime-specific.

**Recommendation:** Abstract through `IRuntimeServices`:

```typescript
interface IRuntimeServices {
  // ...existing
  stat(path: string): Promise<StatResult>;
  readdir(path: string): Promise<string[]>;
}
```

#### 🟠 HIGH: Pino Logger is Node.js-First

Pino has Deno and Bun support but with limitations. Pino's transport system is Node.js-specific.

**Recommendation:**

1. `ILogger` interface in `common` (already recommended above)
2. Provide multiple implementations:
   - `PinoLogger` for Node.js
   - `ConsoleLogger` as runtime-independent fallback
   - Allow users to provide custom `ILogger` implementations
3. Pino becomes a **peer dependency**, not a hard dependency

#### 🟡 MEDIUM: `hrtime` for Timing is Node.js-Specific

Metrics and timing middleware likely use `process.hrtime()` which doesn't exist in Deno/Bun.

**Recommendation:** Use `performance.now()` which is available across all runtimes:

- Node.js: `require('perf_hooks').performance.now()`
- Deno: `performance.now()` (global)
- Bun: `performance.now()` (global)

Abstract via `IRuntimeServices.hrtimeNow(): number`.

---

## 5. Plugin Opportunities

### Strengths

- Plugin system defined with `register(app, options)` pattern
- Built-in plugins for OpenAPI, health, metrics, docs

### Issues

#### 🟠 HIGH: Plugin System Lacks Lifecycle Hooks for Request Processing

The current plugin hooks are:

```
onModuleInit, onApplicationBootstrap, onHttpAdapter, onRequest, onResponse, onError, onShutdown
```

Missing critical hooks:

- `onRouteRegistered` — Plugins need to react when routes are added
- `onProviderRegistered` — Plugins need to modify or replace providers
- `onMiddlewareAdded` — Plugins need to inject middleware at specific positions
- `onFilterApplied` — Plugins need to add global filters
- `onModuleResolved` — Plugins need to know the final module graph

**Recommendation:** Expand plugin hook system:

```typescript
type PluginHookType =
  | 'onModuleInit'
  | 'onApplicationBootstrap'
  | 'onHttpAdapter'
  | 'onRequest'
  | 'onResponse'
  | 'onError'
  | 'onShutdown'
  | 'onRouteRegistered' // NEW
  | 'onProviderRegistered' // NEW
  | 'onMiddlewareAdded' // NEW
  | 'onFilterApplied' // NEW
  | 'onModuleResolved' // NEW
  | 'onModuleDestroy' // NEW
  | 'onExceptionCaught' // NEW
  | 'onValidationFailed'; // NEW
```

#### 🟡 MEDIUM: No Plugin Priority or Ordering

Plugins register without ordering guarantees. If Plugin A adds middleware and Plugin B needs to wrap
it, there's no mechanism.

**Recommendation:** Add priority to plugin registration:

```typescript
interface Plugin {
  name: string;
  version: string;
  priority?: number; // Higher = earlier execution
  dependencies?: string[]; // Plugin names this plugin depends on
  register(app: Application, options?: any): void;
}
```

---

## 6. Developer Experience

### Strengths

- NestJS-like decorators provide familiar DX
- CLI generators reduce boilerplate
- Module-based organization mirrors Spring Boot

### Issues

#### 🟠 HIGH: No WebSocket or SSE Support

The roadmap focuses exclusively on HTTP REST. Modern enterprise applications require:

- WebSocket for real-time communication
- Server-Sent Events for streaming
- GraphQL as an alternative to REST

**Recommendation:** Add milestones for:

- WebSocket adapter with runtime portability
- SSE support via response streaming
- GraphQL adapter (optional, lower priority)

Add to `ExecutionContext`:

```typescript
interface ExecutionContext {
  getType(): 'http' | 'ws' | 'wss' | 'sse'; // Add 'sse'
  switchToHttp(): HttpArgumentsHost;
  switchToWs(): WsArgumentsHost;
  switchToSse(): SseArgumentsHost; // NEW
  // ...
}
```

#### 🟠 HIGH: No File Upload Support

Enterprise applications commonly handle file uploads. No mention of multipart form handling, file
streaming, or upload validation.

**Recommendation:** Add file upload support:

- `@UploadedFile()` decorator
- `@UploadedFiles()` decorator
- File validation with Zod
- Streaming uploads for large files
- Integration with cloud storage (S3, GCS) via adapters

#### 🟡 MEDIUM: No CLI Preview or Dry Run

The CLI generates files but no mention of previewing changes before writing.

**Recommendation:** Add `--dry-run` and `--preview` flags to all generate commands.

#### 🟡 MEDIUM: No Schematic Customization

NestJS allows custom schematics. The roadmap doesn't mention user-extensible generators.

**Recommendation:** Allow projects to define custom schematics in a `.hono-enterprise/schematics/`
directory.

---

## 7. Testing Strategy

### Strengths

- Dedicated `@hono-enterprise/testing` package
- Mock providers, repositories, services
- Test application factory
- HTTP test tool

### Issues

#### 🟠 HIGH: No Contract Testing Support

For a framework targeting microservices, contract testing is essential. No mention of Pact,
Schemathesis, or OpenAPI-based contract validation.

**Recommendation:** Add to testing package:

- OpenAPI contract validation: Verify controllers match OpenAPI spec
- Request/response schema validation in tests
- Mock server generation from OpenAPI spec

#### 🟠 HIGH: No Performance Testing Utilities

Enterprise frameworks need benchmark utilities.

**Recommendation:** Add benchmark utilities:

- Request throughput measurement
- Latency percentile calculation
- Memory allocation tracking
- Integration with BenchmarkJS or similar

#### 🟡 MEDIUM: No Test Coverage Enforcement

No mention of coverage thresholds.

**Recommendation:** Configure Vitest with coverage thresholds:

- 80% line coverage minimum
- 70% branch coverage minimum
- Enforced in CI

#### 🟡 MEDIUM: No Integration Test Fixtures

No mention of database test fixtures, seed data, or test containers.

**Recommendation:** Add to testing package:

- Database fixture management
- Test container integration (for Docker-based test dependencies)
- Seed data utilities

---

## 8. Extensibility

### Strengths

- Plugin system
- Middleware pipeline
- Adapter pattern for databases, caches, messaging

### Issues

#### 🔴 CRITICAL: No Custom HTTP Method Support

The HTTP method decorators cover `GET`, `Post`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, `ALL`.
Missing:

- `CONNECT`
- `TRACE`

More importantly, there's no mechanism to add custom method handlers.

**Recommendation:** Add `@Method(methods: string[], path?: string)` decorator:

```typescript
@Controller('/webhooks')
class WebhookController {
  @Method(['TRACE'], '/debug')
  handleTrace() {/* ... */}
}
```

#### 🟠 HIGH: No Custom Validation Error Format

Validation error format is hardcoded:

```typescript
interface ValidationErrorResponse {
  statusCode: number;
  error: 'Validation Error';
  message: string;
  details: ValidationErrorDetail[];
  timestamp: string;
  path: string;
}
```

Enterprise applications often need custom error formats per API version, client type, or
organizational standards.

**Recommendation:** Make error format pluggable:

```typescript
interface ValidationErrorFormatter {
  format(errors: ValidationError[], context: ValidationContext): unknown;
}

interface ValidationOptions {
  // ...existing
  errorFormatter?: ValidationErrorFormatter;
}
```

Provide default implementations:

- `Rfc7807Formatter` — RFC 7807 Problem Details
- `NestJsFormatter` — NestJS-compatible format
- `CustomFormatter` — User-defined format

#### 🟠 HIGH: No Custom Route Parameter Types

Route parameters are strings by default:

```typescript
params(): Promise<Record<string, string>>;
```

No mechanism for typed parameters (`:id(number)`, `:date(datetime)`).

**Recommendation:** Add parameter type coercion:

```typescript
interface RouteParamDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'datetime' | 'uuid' | CustomType;
  coerce(value: string): unknown;
  validate(value: unknown): boolean;
}
```

#### 🟡 MEDIUM: No Custom Middleware Matching

Middleware matching uses simple path/method:

```typescript
match?(path: string, method: string): boolean;
```

Enterprise applications need regex matching, glob patterns, and header-based matching.

**Recommendation:** Expand matching:

```typescript
interface MiddlewareMatcher {
  path?: string | RegExp | string[];
  method?: string | string[];
  headers?: Record<string, string | RegExp>;
  custom?: (request: HonoRequest) => boolean;
}
```

---

## 9. Maintainability

### Strengths

- JSDoc requirement for public APIs
- Strict TypeScript enforcement
- No circular dependencies rule

### Issues

#### 🟠 HIGH: No Version Compatibility Matrix

With 21 packages, independent versioning will create compatibility nightmares. No mention of version
alignment.

**Recommendation:** Implement one of:

1. **Lockstep versioning** — All packages share the same version
2. **Version ranges** — Document compatible version ranges per package
3. **Meta-package** — `@hono-enterprise/framework` re-exports all packages at compatible versions

Lockstep versioning is recommended for a framework of this scope, with the meta-package approach as
a consumer-facing convenience.

#### 🟠 HIGH: No API Stability Guarantees

No mention of semver, deprecation notices, or breaking change policies.

**Recommendation:**

- Mark experimental APIs with `@experimental` JSDoc tag
- Deprecation notices with `@deprecated` including migration path
- Semver for all packages
- Breaking change changelog section in releases

#### 🟡 MEDIUM: Barrel Exports May Hurt Tree-Shaking

Using barrel exports (`index.ts` re-exporting everything) may prevent tree-shaking in bundlers.

**Recommendation:** Use explicit subpath exports:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./di": "./src/di/index.ts",
    "./modules": "./src/modules/index.ts",
    "./router": "./src/router/index.ts"
  }
}
```

---

## 10. Scalability

### Strengths

- Multi-tenancy support
- CQRS pattern
- Event-driven architecture
- Background queues

### Issues

#### 🟠 HIGH: No Horizontal Scaling Considerations

The scheduler and background queue systems are process-local. In a multi-instance deployment:

- Multiple instances will execute the same cron jobs
- No distributed lock for job execution
- No leader election

**Recommendation:** Add distributed coordination:

- Redis-based distributed locks
- Leader election for cron jobs
- Job deduplication across instances

```typescript
interface IDistributedLock {
  acquire(lockName: string, ttl?: number): Promise<boolean>;
  release(lockName: string): Promise<void>;
  extend(lockName: string, ttl?: number): Promise<void>;
}
```

#### 🟠 HIGH: No Circuit Breaker for External Dependencies

No circuit breaker pattern for external service calls (databases, caches, message brokers).

**Recommendation:** Add circuit breaker to `@hono-enterprise/sdk` and as middleware:

```typescript
interface CircuitBreaker {
  execute<T>(fn: () => Promise<T>): Promise<T>;
  state: CircuitState; // 'closed' | 'open' | 'half-open'
  stats: CircuitStats;
}
```

Already mentioned in SDK but should also be available as a general-purpose utility.

#### 🟡 MEDIUM: No Request Batching

For high-throughput scenarios, request batching reduces overhead.

**Recommendation:** Add batch endpoint support:

```typescript
@Post('/batch')
@Batch()
async handleBatch(@Body() batches: BatchRequest[]) {
  // Framework handles parallel execution, error aggregation
}
```

---

## 11. Performance

### Strengths

- Hono-based runtime (fast)
- Cache abstraction
- Metrics collection

### Issues

#### 🟠 HIGH: Metadata Reflection May Be Slow

Using `WeakMap`-based metadata storage with decorator registration at class definition time adds
startup overhead. For applications with hundreds of controllers and routes, metadata scanning could
become a bottleneck.

**Recommendation:**

- Lazy metadata resolution (resolve on first request, not at startup)
- Compiled metadata for production (pre-generate route maps)
- Route tree optimization (use radix tree / trie for O(log n) route matching)

#### 🟡 MEDIUM: No Request/Response Pooling

For high-throughput scenarios, object pooling reduces GC pressure.

**Recommendation:** Optional request/response object pooling in HTTP adapters.

#### 🟡 MEDIUM: No Streaming Response Support

Large responses should stream instead of buffering.

**Recommendation:** Add streaming response:

```typescript
interface HonoResponse {
  // ...existing
  stream(iterable: AsyncIterable<Uint8Array>, options?: StreamOptions): void;
  sendSSE(event: string, data: unknown): void;
}
```

---

## 12. Security

### Strengths

- JWT, API Keys, RBAC, Permissions
- Rate limiting
- Secure headers
- CORS
- CSRF
- Cookie security
- Password hashing

### Issues

#### 🔴 CRITICAL: No Input Sanitization

Validation checks structure and types but not content safety. No protection against:

- XSS via stored input
- SQL injection (ORM handles this, but raw queries don't)
- NoSQL injection
- LDAP injection
- Command injection

**Recommendation:** Add sanitization pipeline:

- HTML entity encoding
- Script tag removal
- Dangerous character filtering
- Configurable sanitization rules per field

```typescript
interface Sanitizer {
  sanitize(value: unknown, rules: SanitizationRules[]): unknown;
}

interface SanitizationRules {
  htmlEncode?: boolean;
  stripTags?: boolean;
  allowedTags?: string[];
  maxLength?: number;
  pattern?: RegExp;
}
```

#### 🔴 CRITICAL: No Secret Management

No mention of secret rotation, secure storage, or KMS integration.

**Recommendation:** Add secret management to config package:

- AWS KMS adapter
- GCP Secret Manager adapter
- Azure Key Vault adapter
- HashiCorp Vault adapter
- Local encrypted file adapter

```typescript
interface ISecretManager {
  getSecret(name: string): Promise<string>;
  rotateSecret(name: string, newValue: string): Promise<void>;
  listSecrets(): Promise<string[]>;
}
```

#### 🟠 HIGH: No Request Size Limiting

No mention of payload size limits. Applications vulnerable to memory exhaustion attacks.

**Recommendation:** Add request size middleware:

```typescript
interface RequestSizeOptions {
  maxBodySize?: number; // Default: 1MB
  maxHeaderSize?: number; // Default: 8KB
  maxUrlLength?: number; // Default: 8KB
  onLimitExceeded?: (context: MiddlewareContext) => void;
}
```

#### 🟠 HIGH: No IP-Based Security

No IP allowlisting, blocklisting, or geo-blocking.

**Recommendation:** Add IP security middleware:

```typescript
interface IpSecurityOptions {
  allowList?: string[]; // CIDR notation
  blockList?: string[]; // CIDR notation
  geoBlock?: string[]; // Country codes
  trustProxy?: boolean;
  ipHeader?: string; // X-Forwarded-For, etc.
}
```

#### 🟡 MEDIUM: No Security Headers Configuration

`SecurityHeadersMiddleware` is mentioned but no configuration options defined.

**Recommendation:** Explicit security header options:

```typescript
interface SecurityHeadersOptions {
  contentSecurityPolicy?: string | CSPDirectives;
  xFrameOptions?: 'DENY' | 'SAMEORIGIN';
  xContentTypeOptions?: boolean; // nosniff
  xXSSProtection?: boolean;
  strictTransportSecurity?: HSTSOptions;
  referrerPolicy?: ReferrerPolicy;
  permissionsPolicy?: PermissionsDirectives;
  crossOriginOpenerPolicy?: string;
  crossOriginResourcePolicy?: string;
}
```

#### 🟡 MEDIUM: No Audit Logging

Enterprise applications require audit trails for security compliance.

**Recommendation:** Add audit logging:

```typescript
interface AuditLogEntry {
  timestamp: Date;
  action: string;
  resource: string;
  userId: string;
  tenantId?: string;
  requestId: string;
  ipAddress: string;
  userAgent: string;
  before?: unknown;
  after?: unknown;
  result: 'success' | 'failure';
}

interface AuditLogger {
  log(entry: AuditLogEntry): Promise<void>;
}
```

---

## 13. Public API Design

### Strengths

- Consistent decorator naming (`@Inject`, `@Injectable`, `@Module`)
- Fluent builder pattern for containers
- Interface-based design

### Issues

#### 🟠 HIGH: Inconsistent Naming Conventions

Mix of naming styles across the API:

| Inconsistent            | Recommended                               |
| ----------------------- | ----------------------------------------- |
| `getOrThrow`            | `getRequired`                             |
| `getOrCreateDefault`    | `getOrDefault`                            |
| `createNestApplication` | `createApplication` (not NestJS-specific) |
| `HttpTestTool`          | `HttpTestClient`                          |
| `ArgumentHost`          | `PipeArgumentHost`                        |
| `ReflectableMethod`     | `RouteHandler`                            |

**Recommendation:** Establish and enforce naming conventions:

- Services: `XxxService`
- Interfaces: `IXxx` or `XxxInterface`
- Options: `XxxOptions`
- Factories: `XxxFactory`
- Adapters: `XxxAdapter`
- Middleware: `XxxMiddleware`
- Guards: `XxxGuard`
- Interceptors: `XxxInterceptor`
- Filters: `XxxFilter`
- Decorators: `@xxx` (lowercase camelCase)

#### 🟠 HIGH: `any` Types in Public Interfaces

Multiple interfaces use `any`:

```typescript
ParameterMetadata.schema?: any;  // Zod schema reference
HttpError.errors?: any;
ErrorResponse.details?: any;
```

**Recommendation:** Replace with proper types:

```typescript
ParameterMetadata.schema?: ZodTypeAny;
HttpError.errors?: Record<string, unknown> | unknown[];
ErrorResponse.details?: Record<string, unknown>;
```

#### 🟡 MEDIUM: Missing Generic Constraints

```typescript
interface Provider<T = any> {/* ... */}
```

Should be:

```typescript
interface Provider<T = object> {/* ... */}
```

Primitives should not typically be injected. Constrain to `object` or document when primitives are
intended.

---

## 14. Future Compatibility

### Strengths

- Runtime adapter pattern enables new runtimes
- Plugin system for extension
- Cloudflare Workers mentioned as future target

### Issues

#### 🟠 HIGH: No GraphQL Support Planning

GraphQL is increasingly common in enterprise. The roadmap mentions REST only.

**Recommendation:** Add GraphQL milestone:

- `@hono-enterprise/graphql` package
- Schema-first and code-first approaches
- Integration with existing DI, guards, interceptors
- Automatic OpenAPI-like GraphQL schema generation

#### 🟠 HIGH: No gRPC Support

Enterprise microservices often use gRPC for internal communication.

**Recommendation:** Add gRPC milestone (lower priority):

- `@hono-enterprise/grpc` package
- Client and server support
- Integration with DI container

#### 🟡 MEDIUM: No Edge Runtime Optimization

Cloudflare Workers has specific constraints:

- No `setTimeout` (use `scheduled` events)
- Limited bundle size
- No file system access
- Different crypto APIs

**Recommendation:** When adding Cloudflare Workers support:

- `CloudflareRuntimeAdapter` with Workers-specific implementations
- Build-time optimization for bundle size
- Edge-compatible caching strategies
- D1/KV adapter for data persistence

#### 🟡 MEDIUM: No Reactive Streams Support

For real-time data processing, reactive streams are valuable.

**Recommendation:** Consider adding `@hono-enterprise/streams` package:

- Backpressure-aware streaming
- Operator-based transformations
- Integration with SSE and WebSocket

---

## 15. Missing Enterprise Features

### 🔴 Critical Gaps

| Feature             | Why It Matters                 | Recommended Package           |
| ------------------- | ------------------------------ | ----------------------------- |
| Secret Management   | Enterprise security compliance | `@hono-enterprise/config`     |
| Input Sanitization  | XSS/injection prevention       | `@hono-enterprise/validation` |
| Distributed Locking | Horizontal scaling             | `@hono-enterprise/scheduler`  |
| Audit Logging       | Security compliance            | `@hono-enterprise/logger`     |
| Secret Rotation     | Security best practice         | `@hono-enterprise/config`     |

### 🟠 High-Priority Gaps

| Feature                  | Why It Matters           | Recommended Package              |
| ------------------------ | ------------------------ | -------------------------------- |
| WebSocket Support        | Real-time applications   | `@hono-enterprise/http`          |
| SSE Support              | Streaming responses      | `@hono-enterprise/http`          |
| File Uploads             | Common enterprise need   | `@hono-enterprise/http`          |
| Circuit Breaker          | Resilience pattern       | `@hono-enterprise/sdk`           |
| Request Batching         | Performance optimization | `@hono-enterprise/router`        |
| Contract Testing         | API reliability          | `@hono-enterprise/testing`       |
| IP Security              | Network-level security   | `@hono-enterprise/http-security` |
| RFC 7807 Problem Details | Standard error format    | `@hono-enterprise/exceptions`    |

### 🟡 Medium-Priority Gaps

| Feature                   | Why It Matters             | Recommended Package              |
| ------------------------- | -------------------------- | -------------------------------- |
| GraphQL Support           | Alternative API paradigm   | `@hono-enterprise/graphql`       |
| gRPC Support              | Microservice communication | `@hono-enterprise/grpc`          |
| Edge Runtime (CF Workers) | Serverless deployment      | `@hono-enterprise/core`          |
| Custom Schematics         | Developer extensibility    | `@hono-enterprise/cli`           |
| Performance Benchmarks    | Capacity planning          | `@hono-enterprise/testing`       |
| Database Fixtures         | Test reliability           | `@hono-enterprise/testing`       |
| Request Size Limiting     | DoS protection             | `@hono-enterprise/http-security` |
| Streaming Responses       | Large payload handling     | `@hono-enterprise/http`          |

---

## 16. Unnecessary Complexity

### 🟠 HIGH: Module Compiler in Core

[`module-compiler.ts`](plans/implementation-roadmap.md#milestone-3-module-system-and-application-bootstrap)
suggests dynamic module compilation at runtime. This is unnecessary complexity for TypeScript
applications which compile at build time.

**Recommendation:** Remove `module-compiler.ts`. Use static imports with dynamic `require()` for
lazy loading if needed. TypeScript projects compile before running.

### 🟡 MEDIUM: Five Pipeline Behaviors for CQRS

The CQRS milestone includes:

- LoggingBehavior
- ValidationBehavior
- TransactionBehavior
- CachingBehavior
- TimingBehavior

These duplicate functionality in middleware, interceptors, and filters. Having five parallel
cross-cutting concern mechanisms (middleware, interceptors, filters, pipeline behaviors, guards)
creates confusion about which mechanism to use when.

**Recommendation:** Consolidate to three mechanisms:

| Mechanism    | Purpose                  | When to Use                              |
| ------------ | ------------------------ | ---------------------------------------- |
| Middleware   | Transport-level concerns | CORS, logging, auth, compression         |
| Guards       | Authorization            | Role checks, permission validation       |
| Interceptors | Response transformation  | Logging, caching, transformation, timing |

Remove CQRS pipeline behaviors. Use middleware for logging/timing, validation pipe for validation,
and `@Transactional` decorator for transactions.

### 🟡 MEDIUM: Separate `http-exception-filter.ts` and `base-exception-filter.ts`

Two base exception filters suggest unclear separation of concerns.

**Recommendation:** Single `BaseExceptionFilter` with strategy pattern for different error types.

---

## 17. Architectural Smells

### 🔴 CRITICAL: God Core Package

`@hono-enterprise/core` will contain 20+ files spanning DI, modules, application lifecycle, routing,
controllers, HTTP adapters, request/response, interceptors, and versioning. This violates the Single
Responsibility Principle at the package level.

**Impact:**

- Difficult to test in isolation
- Large bundle size for consumers who only need DI
- Tight coupling between unrelated concerns
- Hard to reason about changes

**Fix:** Split into focused sub-packages (detailed in SOLID section above).

### 🟠 HIGH: Decorator God Package

`@hono-enterprise/decorators` contains all decorators across all domains.

**Fix:** Distribute decorators to owning packages (detailed in Package Boundaries section above).

### 🟠 HIGH: Strategy Duplication Across Packages

Authentication strategies appear in both `security` and `auth`. Guards appear in both. Decorators
appear in both.

**Fix:** Merge `security` and `auth` (detailed in Package Boundaries section above).

### 🟡 MEDIUM: Interface Name Inconsistency

Mix of `IXxx` prefix and `XxxInterface` suffix:

- `IRepository`, `IUnitOfWork`, `ICache`, `IEvent`, `IEventBus`
- But `ExceptionFilterHost` (no `I` prefix)
- And `HttpArgumentsHost` (no `I` prefix)

**Fix:** Standardize on `IXxx` prefix for all interfaces.

---

## 18. Circular Dependency Risks

### 🔴 CRITICAL: `core` ↔ `decorators` → `core`

If `decorators` registers metadata that `core` reads, and `core` exports types that `decorators`
imports, this creates a circular dependency.

```
core imports decorators (for decorator functions)
decorators imports core (for metadata types)
```

**Mitigation:** Metadata types live in `@hono-enterprise/common`. Both `core` and decorator packages
import from `common` but never from each other.

### 🟠 HIGH: `auth` ↔ `security` → `auth`

Current roadmap shows `auth` depends on `security`. If `security` also needs `auth` types (User,
AuthRequest), circular dependency.

**Mitigation:** Merge packages (recommended above) or ensure `security` only imports interfaces from
`common`.

### 🟠 HIGH: `health` → `database` → `exceptions` → `validation` → `exceptions`

`validation` depends on `exceptions` and `exceptions` may need validation types. Circular.

**Mitigation:** Reverse dependency (recommended above): `exceptions` depends on `validation` types,
not the other way.

### 🟡 MEDIUM: `messaging` → `events` → `logger` → `core` → `logger`

If `events` needs `logger`, and `logger` depends on `core`, and `core` has logger types...

**Mitigation:** `ILogger` in `common`. No package depends on `logger` for the interface. Only
concrete implementations live in `logger`.

---

## 19. Runtime-Specific Assumptions

### Identified Assumptions

| Assumption                 | Location                       | Risk                                 |
| -------------------------- | ------------------------------ | ------------------------------------ |
| `uuid()`                   | DomainEvent, Commands, Queries | 🔴 Not available in all runtimes     |
| RxJS `Observable`          | Interceptors                   | 🔴 Node.js only                      |
| Pino transports            | Logger                         | 🟠 Node.js first                     |
| `process.hrtime()`         | Metrics, Timing                | 🟠 Node.js specific                  |
| `fs` module                | Disk health check              | 🟠 Node.js specific                  |
| `setTimeout`/`setInterval` | Scheduler                      | 🟡 Available but different semantics |
| `crypto` module            | Security, JWT                  | 🟡 Different APIs per runtime        |

### Recommendation

Create `@hono-enterprise/runtime` package as the **single source of truth** for runtime-specific
operations:

```typescript
// @hono-enterprise/runtime
export interface IRuntimeAdapter {
  // Time
  now(): number; // High-resolution timestamp
  setTimeout(fn: () => void, ms: number): TimerID;
  clearTimeout(id: TimerID): void;
  setInterval(fn: () => void, ms: number): TimerID;
  clearInterval(id: TimerID): void;

  // Crypto
  uuid(): string;
  randomBytes(length: number): Uint8Array;
  getRandomValues(buffer: Uint8Array): Uint8Array;
  subtle: SubtleCrypto;

  // Environment
  env: Record<string, string | undefined>;
  exit(code?: number): never;

  // File System (optional - not available on edge)
  fs?: IFileSystem;

  // Platform
  platform(): RuntimePlatform;
  version(): string;
}

type RuntimePlatform = 'node' | 'deno' | 'bun' | 'cloudflare-workers' | 'unknown';
```

---

## 20. Weak Abstractions

### Identified Weak Abstractions

#### 🟠 HIGH: `IOrmAdapter.executeQuery()` Returns Raw SQL

```typescript
interface IOrmAdapter {
  executeQuery<T>(query: string, params?: any[]): Promise<T[]>;
}
```

This exposes raw SQL to the abstraction layer, defeating the purpose of ORM abstraction.
Applications using this method are coupled to SQL syntax.

**Recommendation:** Remove raw query execution from the adapter interface. Provide it as an optional
extension method:

```typescript
interface IOrmAdapter {
  // Core methods
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isReady(): boolean;
  createTransaction(): ITransaction;

  // Optional raw query (not all ORMs support this)
  executeRawQuery<T>(query: string, params?: unknown[]): Promise<T[]>;
}
```

#### 🟠 HIGH: `ITransaction.execute()` is SQL-Centric

```typescript
interface ITransaction {
  execute<T>(query: string, params?: any[]): Promise<T>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
```

This assumes SQL-style transactions. Prisma and Drizzle have different transaction APIs.

**Recommendation:** Abstract to operation-based transactions:

```typescript
interface ITransaction {
  // Execute a callback within the transaction
  execute<T>(callback: (transaction: TransactionContext) => Promise<T>): Promise<T>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  isolateLevel: IsolationLevel;
}

interface TransactionContext {
  repository<T extends BaseEntity>(entityClass: Type<T>): IRepository<T, unknown>;
}
```

#### 🟡 MEDIUM: `MessageMetadata` Index Signature

```typescript
interface MessageMetadata {
  correlationId?: string;
  causationId?: string;
  contentType?: string;
  headers?: Record<string, string>;
  [key: string]: any; // Weak abstraction
}
```

Index signature with `any` defeats type safety.

**Recommendation:** Use `Record<string, unknown>`:

```typescript
interface MessageMetadata {
  correlationId?: string;
  causationId?: string;
  contentType?: string;
  headers?: Record<string, string>;
  extensions?: Record<string, unknown>;
}
```

---

## 21. Missing Extension Points

### Critical Missing Extension Points

| Extension Point                    | Why Needed                     | Where           |
| ---------------------------------- | ------------------------------ | --------------- |
| Custom `ILogger`                   | Multiple logging backends      | `common`        |
| Custom `IRuntimeAdapter`           | New runtime support            | `runtime`       |
| Custom `ISecretManager`            | Enterprise secret stores       | `config`        |
| Custom `ISanitizer`                | Industry-specific sanitization | `validation`    |
| Custom `IValidationErrorFormatter` | API-versioned error formats    | `validation`    |
| Custom `IDistributedLock`          | Horizontal scaling             | `scheduler`     |
| Custom `IAuditLogger`              | Compliance requirements        | `logger`        |
| Custom `ISerializer`               | Message serialization          | `messaging`     |
| Custom `ICacheStore`               | New cache backends             | `cache`         |
| Custom `IQueueAdapter`             | New queue backends             | `queue`         |
| Custom `ITenantResolver`           | Custom tenant detection        | `multi-tenancy` |
| Custom `IVersioningStrategy`       | Custom API versioning          | `versioning`    |
| Custom `IMessageBroker`            | New message brokers            | `messaging`     |
| Custom `IOrmAdapter`               | New ORMs                       | `database`      |
| Custom `IHealthIndicator`          | Custom health checks           | `health`        |
| Custom `IMetricCollector`          | Custom metrics                 | `metrics`       |
| Custom `IPipelineBehavior`         | CQRS middleware                | `cqrs`          |
| Custom `IGuard`                    | Custom authorization           | `auth`          |
| Custom `IInterceptor`              | Custom response handling       | `core`          |
| Custom `IExceptionFilter`          | Custom error handling          | `exceptions`    |
| Custom `IMiddleware`               | Custom pipeline steps          | `core`          |
| Custom `IPlugin`                   | Framework extension            | `plugins`       |
| Custom `IHttpAdapter`              | New HTTP servers               | `http`          |
| Custom `IConfigLoader`             | Custom config sources          | `config`        |

Most of these are already supported by the interface-based design. The ones explicitly **missing**
are:

- `ISecretManager` — Not mentioned anywhere
- `ISanitizer` — Not mentioned anywhere
- `IDistributedLock` — Not mentioned anywhere
- `IAuditLogger` — Not mentioned anywhere
- `IRuntimeAdapter` — Partially exists but not formalized

---

## 22. Consolidated Recommendations

### Phase 1: Restructure (Before Implementation)

| # | Action                                                                 | Priority | Impact                       |
| - | ---------------------------------------------------------------------- | -------- | ---------------------------- |
| 1 | Merge `security` and `auth` into single `auth` package                 | 🔴       | Eliminates duplication       |
| 2 | Move `ILogger` interface to `common`; `core` depends on interface only | 🔴       | Fixes dependency inversion   |
| 3 | Distribute decorators to owning packages                               | 🟠       | Fixes god package            |
| 4 | Split `core` into focused sub-packages                                 | 🟠       | Improves maintainability     |
| 5 | Create `@hono-enterprise/runtime` package                              | 🔴       | Enables runtime portability  |
| 6 | Replace RxJS `Observable` with native `Promise`/`AsyncIterable`        | 🔴       | Enables runtime portability  |
| 7 | Decouple `messaging` from `events` via bridge package                  | 🟠       | Clean hexagonal architecture |
| 8 | Reverse `validation` → `exceptions` dependency                         | 🟠       | Clean dependency direction   |
| 9 | Add `http-security` package for CORS, headers, CSRF, rate limiting     | 🟠       | Clear package boundaries     |

### Phase 2: Add Missing Features

| #  | Feature                  | Priority | Milestone                |
| -- | ------------------------ | -------- | ------------------------ |
| 1  | Secret Management        | 🔴       | New: Security milestone  |
| 2  | Input Sanitization       | 🔴       | Extend validation        |
| 3  | Distributed Locking      | 🟠       | Extend scheduler         |
| 4  | Audit Logging            | 🟠       | Extend logger            |
| 5  | WebSocket/SSE Support    | 🟠       | New: Real-time milestone |
| 6  | File Upload Support      | 🟠       | Extend HTTP              |
| 7  | Request Size Limiting    | 🟠       | Extend http-security     |
| 8  | IP Security              | 🟡       | Extend http-security     |
| 9  | RFC 7807 Problem Details | 🟡       | Extend exceptions        |
| 10 | Contract Testing         | 🟡       | Extend testing           |

### Phase 3: Polish

| # | Action                             | Priority |
| - | ---------------------------------- | -------- |
| 1 | Standardize naming conventions     | 🟠       |
| 2 | Replace `any` types in public APIs | 🟠       |
| 3 | Add version compatibility matrix   | 🟠       |
| 4 | Add API stability guarantees       | 🟠       |
| 5 | Configure subpath exports          | 🟡       |
| 6 | Add coverage thresholds            | 🟡       |
| 7 | Add benchmark utilities            | 🟡       |

---

## 23. Revised Package Structure

```
packages/
├── common/                    # Shared types, ILogger, IRuntimeAdapter interfaces
├── runtime/                   # Runtime adapters (NEW)
├── di/                        # DI Container (split from core)
├── application/               # Module system, app bootstrap (split from core)
├── router/                    # Routing, controller discovery (split from core)
├── http/                      # HTTP adapters, request/response, file uploads (split from core)
├── pipeline/                  # Middleware pipeline (split from core)
├── interceptors/              # Interceptors (split from core)
├── versioning/                # API versioning (split from core)
├── core/                      # Barrel re-export of core sub-packages
├── auth/                      # Merged auth + security
├── http-security/             # CORS, headers, CSRF, rate limiting, IP security (NEW)
├── config/                    # + Secret management
├── database/                  # Repository, UoW, ORM adapters
├── cache/                     # Cache abstraction + decorators
├── events/                    # Event bus, domain events
├── cqrs/                      # CQRS (separate package)
├── messaging/                 # Messaging brokers (decoupled from events)
├── events-messaging-bridge/   # Bridge adapter (NEW)
├── validation/                # Zod validation + sanitization
├── exceptions/                # Exception hierarchy + RFC 7807
├── scheduler/                 # + Distributed locking
├── health/                    # Health checks
├── metrics/                   # Prometheus metrics
├── telemetry/                 # OpenTelemetry
├── logger/                    # + Audit logging
├── testing/                   # + Contract testing, fixtures
├── cli/                       # + Custom schematics
├── sdk/                       # + Circuit breaker
├── plugins/                   # Plugin system
└── decorators/                # Barrel re-export only
```

---

## 24. Decision Log

| Decision                        | Rationale                              | Status           |
| ------------------------------- | -------------------------------------- | ---------------- |
| Merge security + auth           | Eliminates file duplication            | Pending Approval |
| Split core into sub-packages    | SRP, tree-shaking, testability         | Pending Approval |
| Replace RxJS with native async  | Runtime portability requirement        | Pending Approval |
| Create runtime package          | Single source for runtime-specific ops | Pending Approval |
| Move ILogger to common          | Dependency inversion                   | Pending Approval |
| Decouple messaging from events  | Hexagonal architecture                 | Pending Approval |
| Add http-security package       | Clear HTTP transport concerns          | Pending Approval |
| Add secret management           | Enterprise security requirement        | Pending Approval |
| Add input sanitization          | Security compliance                    | Pending Approval |
| Add distributed locking         | Horizontal scaling                     | Pending Approval |
| Add WebSocket/SSE support       | Modern enterprise requirements         | Pending Approval |
| Distribute decorators to owners | Package cohesion                       | Pending Approval |
| Lockstep versioning             | Compatibility management               | Pending Approval |

---

## Conclusion

The roadmap demonstrates strong architectural thinking with clear interfaces, proper abstractions,
and comprehensive enterprise feature coverage. The identified issues are primarily around:

1. **Package boundary refinement** — Merge, split, and redistribute for better cohesion
2. **Runtime portability** — Replace Node.js-specific APIs with runtime-agnostic abstractions
3. **Security gaps** — Add sanitization, secret management, and audit logging
4. **Dependency direction** — Ensure interfaces flow from `common`, implementations depend on
   interfaces
5. **Missing extension points** — Formalize runtime adapter, secret manager, sanitizer, distributed
   lock

These changes increase the total package count from 21 to approximately 27 but significantly improve
maintainability, runtime portability, and enterprise readiness.

**Recommendation:** Apply Phase 1 restructuring before beginning implementation. Phase 2 features
can be added as additional milestones. Phase 3 items can be addressed during Milestone 34 (Final
Polish).
