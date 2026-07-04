# Hono Enterprise — AI Engineering Guidelines

> **This document is the permanent engineering handbook for the Hono Enterprise framework.** Every
> rule in this document is mandatory and applies to all future coding sessions. These rules exist to
> ensure the framework remains production-quality, maintainable, and trustworthy for thousands of
> developers.

---

## Table of Contents

1. [Core Principles](#1-core-principles)
2. [Architecture Rules](#2-architecture-rules)
3. [Plugin Rules](#3-plugin-rules)
4. [Runtime Independence Rules](#4-runtime-independence-rules)
5. [TypeScript Rules](#5-typescript-rules)
6. [Testing Rules](#6-testing-rules)
7. [Documentation Rules](#7-documentation-rules)
8. [Milestone Rules](#8-milestone-rules)
9. [Backward Compatibility Rules](#9-backward-compatibility-rules)
10. [Public API Rules](#10-public-api-rules)
11. [Code Quality Rules](#11-code-quality-rules)
12. [Dependency Rules](#12-dependency-rules)
13. [Security Rules](#13-security-rules)
14. [Performance Rules](#14-performance-rules)
15. [Git and Commit Rules](#15-git-and-commit-rules)
16. [Review and Approval Rules](#16-review-and-approval-rules)
17. [Violation Handling](#17-violation-handling)

---

## 1. Core Principles

These principles are the foundation of every decision in this codebase.

### 1.1 SOLID

Every package, plugin, module, and class must adhere to SOLID principles:

- **Single Responsibility** — Each class or function has one reason to change.
- **Open/Closed** — Extend behavior through composition and plugins, not modification.
- **Liskov Substitution** — Any implementation of an interface must be substitutable.
- **Interface Segregation** — No consumer depends on methods it does not use.
- **Dependency Inversion** — Depend on interfaces from `@hono-enterprise/common`, never on concrete
  implementations.

### 1.2 Clean Architecture

Dependency direction must always point inward:

```
Framework Code → Application Code → Domain Code
     ↑                                      ↑
     └────── depends on interfaces only ─────┘
```

- Controllers depend on services.
- Services depend on repository interfaces or abstractions.
- Repositories depend on adapter interfaces.
- Framework code never depends on application code.
- Application code never depends on runtime-specific implementations.

### 1.3 Hexagonal Architecture

The framework follows hexagonal (ports and adapters) architecture:

- **Ports** — Interfaces defined in `@hono-enterprise/common`.
- **Adapters** — Implementations provided by plugins (e.g., `PrismaAdapter`, `RedisStore`).
- **Application Core** — Business logic depends only on ports, never on adapters.

### 1.4 Composition Over Inheritance

- Prefer composition over inheritance in all cases.
- Use factory functions instead of class hierarchies for exception types.
- Use plugin composition instead of module inheritance.
- Use capability tokens instead of abstract base classes for cross-plugin communication.

### 1.5 Adapters Over Implementations

- Every external dependency (database, cache, message broker, storage, mail) must have an adapter
  interface.
- Concrete implementations are provided by plugins, not hardcoded in core.
- Applications depend on adapter interfaces, never on concrete adapters.

### 1.6 Interfaces Over Concrete Types

- All public APIs must expose interfaces, not concrete classes.
- Concrete classes are internal implementation details.
- Service resolution uses capability tokens (strings), not class references.
- No public API returns or accepts a concrete class when an interface exists.

---

## 2. Architecture Rules

### 2.1 Package Boundaries

- Each package must have a single, well-defined responsibility.
- Packages communicate via their public API (`src/index.ts`) only.
- No package imports from another package's internal modules.
- Circular dependencies between packages are forbidden.
- The `@hono-enterprise/common` package contains only types and interfaces — zero runtime code.

### 2.2 Dependency Direction

```
common ← kernel ← all plugins
common ← all plugins
```

- `common` depends on nothing.
- `kernel` depends on `common` only.
- All plugins depend on `common` and optionally `kernel`.
- No plugin depends on another plugin at runtime.
- Plugins communicate via capability tokens resolved through the `ServiceRegistry`.

### 2.3 Layered Architecture

Every plugin must follow this internal structure:

```
plugin-package/
├── src/
│   ├── plugin.ts          # Plugin entry point (register function)
│   ├── services/          # Service implementations
│   ├── interfaces/        # Plugin-specific interfaces (public)
│   ├── adapters/          # External dependency adapters
│   ├── middleware/        # Middleware provided by this plugin
│   └── index.ts           # Public API barrel export
└── test/
    ├── unit/
    ├── integration/
    └── e2e/
```

### 2.4 No God Packages

- No package may contain more than one major capability.
- If a package grows beyond a single capability, split it.
- The `kernel` package contains only: plugin registry, service registry, middleware pipeline,
  router, and application lifecycle.

---

## 3. Plugin Rules

### 3.1 Everything Is a Plugin

- Every framework capability must be implemented as a plugin.
- The kernel ships with zero built-in features beyond plugin orchestration.
- Even DI, decorators, and logging are optional plugins.

### 3.2 Plugin Contract

Every plugin must implement the `IPlugin` interface from `@hono-enterprise/common`:

```typescript
interface IPlugin {
  name: string;
  version: string;
  dependencies?: string[];
  optionalDependencies?: string[];
  provides?: string[];
  consumes?: string[];
  priority?: number;
  register(ctx: IPluginContext): void | Promise<void>;
}
```

### 3.3 Plugin Independence

- A plugin must never import from another plugin's internal modules.
- A plugin accesses other plugins' capabilities only via `ctx.services.get<T>(token)`.
- A plugin must function correctly when optional dependencies are absent.
- A plugin must declare all required dependencies in `dependencies[]`.

### 3.4 Plugin Replaceability

- Any plugin must be replaceable by a custom implementation without modifying application code.
- Plugins register services with capability tokens, not with concrete types.
- A replacement plugin registers the same capability token with `override: true`.

### 3.5 Plugin Extension Points

Every plugin must expose extension points:

| Extension Point               | How                           |
| ----------------------------- | ----------------------------- |
| Custom service implementation | Override the capability token |
| Custom middleware             | `ctx.middleware.add()`        |
| Custom routes                 | `ctx.router`                  |
| Custom health checks          | `ctx.health.register()`       |
| Custom metrics                | `ctx.metrics.register()`      |
| Custom CLI commands           | `ctx.cli.register()`          |
| Custom OpenAPI contributions  | `ctx.openapi`                 |
| Custom lifecycle hooks        | `ctx.lifecycle`               |
| Custom decorators             | `ctx.decorators.register()`   |
| Custom environment validation | `ctx.environment.validate()`  |

### 3.6 Plugin Naming

- Plugin names must be lowercase kebab-case: `my-plugin`.
- Package names must be `@hono-enterprise/[name]-plugin` for capability plugins.
- The `name` field in the `Plugin` interface must match the package name without the scope.

### 3.7 Plugin Versioning

- Plugins follow semantic versioning.
- A plugin's `version` field must match the `version` in its `deno.json`.
- Breaking changes to a plugin's public API require a major version bump.

---

## 4. Runtime Independence Rules

### 4.1 No Runtime-Specific APIs in Core

- The `kernel` and `common` packages must never import from `node:`, `deno:`, or `bun:` modules.
- No use of `process`, `Deno`, `Bun`, or `globalThis` in core packages.
- All runtime-specific operations must go through `IRuntimeServices` from the `RuntimePlugin`.

### 4.2 Runtime Services Abstraction

All runtime-specific operations must be abstracted:

| Operation             | Forbidden                      | Required                |
| --------------------- | ------------------------------ | ----------------------- |
| UUID generation       | `crypto.randomUUID()` directly | `runtime.uuid()`        |
| Random bytes          | `crypto.randomBytes()`         | `runtime.randomBytes()` |
| Timers                | `setTimeout()` directly        | `runtime.setTimeout()`  |
| High-resolution time  | `process.hrtime()`             | `runtime.hrtime()`      |
| Environment variables | `process.env`                  | `runtime.env`           |
| File system           | `fs` module                    | `runtime.fs`            |
| Platform detection    | `process.platform`             | `runtime.platform()`    |

### 4.3 HTTP Adapter Abstraction

- No plugin may directly create an HTTP server.
- HTTP server creation is delegated to the `RuntimePlugin`'s HTTP adapter.
- Request and response objects are abstracted via `IRequest` and `IResponse` interfaces.

### 4.4 No RxJS or Node-Only Libraries

- Do not use RxJS, Node streams, or any Node.js-only library in core or plugins.
- Use native `Promise`, `AsyncIterable`, or `AsyncGenerator` for async operations.
- If a library is Node-only, wrap it in a runtime adapter.

### 4.5 Cross-Runtime Testing

- All tests must pass on Node.js, Deno, and Bun.
- CI must run the full test suite on all three runtimes.
- Runtime-specific tests must be guarded with `runtime.platform()` checks.

---

## 5. TypeScript Rules

### 5.1 Strict Mode

- `strict: true` in the root `deno.json` `compilerOptions` (inherited by all workspace packages).
- `noImplicitAny: true`
- `strictNullChecks: true`
- `strictFunctionTypes: true`
- `strictBindCallApply: true`
- `strictPropertyInitialization: true`
- `noImplicitThis: true`
- `alwaysStrict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noImplicitReturns: true`
- `noFallthroughCasesInSwitch: true`
- `forceConsistentCasingInFileNames: true`

### 5.2 No `any` Type

- The `any` type is forbidden in all code.
- Use `unknown` when the type is genuinely unknown, then narrow it.
- Use generics when the type is parameterized.
- Use `Record<string, unknown>` for dynamic objects.
- The only exception is interop with external libraries that require `any` — wrap them immediately.

### 5.3 No `unknown` Without Narrowing

- `unknown` must be narrowed before use.
- Never perform operations on `unknown` without type guards.
- Use Zod schemas to narrow `unknown` at boundaries.

### 5.4 Explicit Return Types

- All public functions and methods must have explicit return types.
- Inference is acceptable for internal helper functions.

### 5.5 No `enum` — Use Union Types

- Use string literal union types instead of TypeScript enums.
- Unions are tree-shakeable; enums are not.

```typescript
// ✅ Good
type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

// ❌ Bad
enum LogLevel {
  Fatal,
  Error,
  Warn,
  Info,
  Debug,
  Trace,
}
```

### 5.6 No `class` for Pure Data

- Use `interface` or `type` for pure data structures.
- Use `class` only when behavior (methods) is attached.

### 5.7 Generic Constraints

- All generics must have constraints where applicable.
- Use `extends object` for service-like types.
- Use `extends string | symbol` for tokens.

### 5.8 No `export default`

- Use named exports only.
- `export default` prevents tree-shaking and creates naming inconsistency.

### 5.9 Import Organization

- Imports ordered: external, framework, internal.
- Use `import type` for type-only imports.

---

## 6. Testing Rules

### 6.1 Every Milestone Must Include Tests

- No milestone is complete without tests.
- Tests are written before or alongside implementation, never after.
- A milestone with failing tests is not complete.

### 6.2 Test Coverage

- Every package must maintain 90%+ unit test coverage.
- Coverage is measured by lines, branches, and functions.
- Coverage is enforced in CI — builds fail below 90%.
- Public APIs must have 100% coverage.

### 6.3 Test Types

Every package must include:

| Test Type   | Purpose                                            | Location            |
| ----------- | -------------------------------------------------- | ------------------- |
| Unit        | Test individual functions and classes in isolation | `test/unit/`        |
| Integration | Test plugin registration and service resolution    | `test/integration/` |
| E2E         | Test full application scenarios                    | `test/e2e/`         |

### 6.4 Test Framework

- Use `deno test` as the test runner, with `@std/testing/bdd` (`describe`/`it`) and `@std/expect`
  for assertions.
- Use `@hono-enterprise/testing` for test utilities.
- Use `app.inject()` for HTTP testing without a server.
- Use `createMockPlugin()` for mocking plugin services.
- Node/Bun compatibility is verified by a separate compat suite in CI that consumes the packages
  through JSR's npm compatibility layer.

### 6.5 Test Naming

- Test files: `[name].test.ts` or `[name].spec.ts`.
- Test descriptions: `describe('ClassName', () => { it('should do something', ...) })`.
- Use behavior-focused descriptions, not implementation-focused.

### 6.6 Test Independence

- Each test must be independent and runnable in isolation.
- No test depends on the execution order of other tests.
- Each test sets up and tears down its own state.
- Use `beforeEach` and `afterEach` for setup and cleanup.

### 6.7 No Real External Dependencies in Tests

- Tests must not connect to real databases, Redis, message brokers, or external APIs.
- Use in-memory adapters (`MemoryAdapter`, `MemoryStore`, `InMemoryBroker`).
- Use `createMockPlugin()` for mocking plugin services.
- Integration tests that require real dependencies must be guarded with
  `describe.skipIf(!process.env.RUN_INTEGRATION)`. (Test files are the one sanctioned exception to
  the `runtime.env` rule — they run under the Node-based test runner, not inside the framework.)

### 6.8 Snapshot Testing

- Use snapshot tests sparingly, only for stable output (e.g., OpenAPI spec generation).
- Snapshots must be reviewed in PRs.
- Do not use snapshots for testing logic.

---

## 7. Documentation Rules

### 7.1 Every Package Must Have Documentation

- Each package must have a `README.md` with:
  - Package purpose
  - Installation instructions
  - Usage examples
  - API reference (or link to generated docs)
  - Configuration options

### 7.2 JSDoc on Every Public API

- Every exported function, class, interface, and type must have JSDoc.
- JSDoc must include:
  - `@param` for each parameter
  - `@returns` for return values
  - `@throws` for thrown exceptions
  - `@example` for non-trivial APIs
  - `@since` for version tracking
  - `@deprecated` with migration path for deprecated APIs

````typescript
/**
 * Creates a new application instance with the specified plugins.
 *
 * @param options - Application configuration options
 * @returns A new Application instance
 * @throws {Error} If a required plugin dependency is missing
 * @example
 * ```typescript
 * const app = createApplication({
 *   plugins: [RuntimePlugin(), LoggerPlugin()],
 * });
 * await app.start({ port: 3000 });
 * ```
 * @since 1.0.0
 */
export function createApplication(options?: ApplicationOptions): Application { ... }
````

### 7.3 No Undocumented Public APIs

- If it is exported from `index.ts`, it must have JSDoc.
- If it is in the `PUBLIC_API.md`, it must have JSDoc.
- No exceptions.

### 7.4 Documentation Generation

- API reference is auto-generated from JSDoc using `deno doc` (HTML output); JSR additionally
  renders per-package docs automatically on publish.
- Generated docs live in `docs/api/`.
- Documentation is rebuilt on every release.

### 7.5 Code Comments

- Comments explain why, not what.
- The code itself explains what.
- Use comments for non-obvious decisions, trade-offs, and constraints.
- Do not comment out code — delete it.

---

## 8. Milestone Rules

### 8.1 Every Milestone Must Compile

- A milestone is not complete until `deno task check` (type-checking all workspace packages)
  succeeds with zero errors.
- TypeScript errors are blocking.
- No `// @ts-ignore` or `// @ts-expect-error` without a justifiable reason documented in a comment.

### 8.2 Every Milestone Must Include Tests

- A milestone is not complete until all tests pass.
- Tests must cover the new functionality added in the milestone.
- Existing tests must continue to pass.

### 8.3 Every Milestone Must Leave the Repository in a Working State

- After completing a milestone, the repository must be fully functional.
- `deno task check` must succeed.
- `deno task test` must succeed.
- `deno task lint` must succeed.
- `deno task fmt:check` must succeed.
- All example applications must run.

### 8.4 One Package at a Time

- Build one package per milestone.
- Do not start a new package until the current one is complete.
- Complete means: compiles, tested, documented, and reviewed.

### 8.5 Complete Files, Not Snippets

- Never generate partial files or snippets.
- Every file must be complete and functional.
- No `// ... rest of code` placeholders.

### 8.6 Milestone Completion Checklist

Before marking a milestone as complete, verify:

- [ ] Package type-checks with `deno task check`
- [ ] All tests pass with `deno task test`
- [ ] Linting passes with `deno task lint`
- [ ] Formatting passes with `deno task fmt:check`
- [ ] Test coverage is 90%+
- [ ] All public APIs have JSDoc
- [ ] README.md is written
- [ ] No `any` types
- [ ] No runtime-specific APIs in core
- [ ] No circular dependencies
- [ ] Progress tracking table updated

---

## 9. Backward Compatibility Rules

### 9.1 Never Break Backward Compatibility

- Once a public API is released, it must not break in a minor or patch release.
- Breaking changes require a major version bump.
- Breaking changes must be preceded by a deprecation period of at least one minor version.

### 9.2 Deprecation Process

1. Mark the API as `@deprecated` in JSDoc with a migration path.
2. Provide a replacement API in the same version.
3. Remove the deprecated API only in the next major version.

````typescript
/**
 * @deprecated Use `config.getOrThrow()` instead. Will be removed in v2.0.0.
 * @example
 * ```typescript
 * // Before
 * const value = config.getRequired('KEY');
 * // After
 * const value = config.getOrThrow('KEY');
 * ```
 */
export function getRequired<T>(key: string): T { ... }
````

### 9.3 Semantic Versioning

- **Major** — Breaking changes to public APIs.
- **Minor** — New features, backward compatible.
- **Patch** — Bug fixes, backward compatible.

### 9.4 No Silent Breaking Changes

- Never change the behavior of a public API without a version bump.
- Never change the signature of a public function without a version bump.
- Never remove a public export without a deprecation period.

---

## 10. Public API Rules

### 10.1 Public API Definition

A public API is any export from a package's `src/index.ts` file.

### 10.2 Public API Requires Approval

- No public API may be added, modified, or removed without explicit approval.
- Approval is documented in the PR description.
- The `PUBLIC_API.md` document must be updated in the same PR.

### 10.3 Public API Stability

- Public APIs must be stable and well-defined.
- Public APIs must not expose internal implementation details.
- Public APIs must use interfaces, not concrete classes.
- Public APIs must have comprehensive JSDoc.

### 10.4 Public API Naming Conventions

| Type             | Convention                                   | Example                                |
| ---------------- | -------------------------------------------- | -------------------------------------- |
| Interface        | `IXxx`                                       | `ILogger`, `IConfig`                   |
| Service          | `XxxService`                                 | `DatabaseService`, `CacheService`      |
| Plugin           | `XxxPlugin`                                  | `LoggerPlugin`, `DatabasePlugin`       |
| Middleware       | `XxxMiddleware`                              | `AuthMiddleware`, `CorsMiddleware`     |
| Guard            | `requireXxx`                                 | `requireAuth`, `requireRole`           |
| Adapter          | `XxxAdapter`                                 | `PrismaAdapter`, `RedisStore`          |
| Options          | `XxxOptions`                                 | `LoggerOptions`, `DatabaseOptions`     |
| Factory          | `createXxx`                                  | `createApplication`, `createTestApp`   |
| Decorator        | `@Xxx`                                       | `@Controller`, `@Get`, `@Body`         |
| Capability token | `xxx` (lowercase kebab, from `CAPABILITIES`) | `logger`, `database`, `authentication` |

### 10.5 No Undocumented Exports

- Every export from `index.ts` must be in `PUBLIC_API.md`.
- Every export from `index.ts` must have JSDoc.
- No export is "temporary" or "internal" — if it is exported, it is public.

---

## 11. Code Quality Rules

### 11.1 No Duplicated Logic

- DRY (Don't Repeat Yourself) is enforced.
- If logic appears in two places, extract it to a shared utility.
- Shared utilities live in `@hono-enterprise/common` or the owning package.

### 11.2 No Magic Strings

- Use constants for all string literals that appear more than once.
- Capability tokens must use the `CAPABILITIES` constant from `@hono-enterprise/common`.
- HTTP header names, error codes, and event names must be constants.

### 11.3 No Circular Dependencies

- Circular dependencies between packages are forbidden.
- Circular dependencies within a package are forbidden.
- Use dependency inversion to break cycles.
- Circular dependencies are detected by tooling and fail the build.

### 11.4 No Hidden Globals

- No global variables.
- No global state.
- No singletons that are not managed by the DI container or service registry.
- All state is explicit and passed via context or service registry.

### 11.5 No Side Effects in Imports

- Importing a module must not execute side effects.
- No code at module top level that modifies global state.
- Registration happens in `register()` functions, not at import time.

### 11.6 No `console.log` in Production Code

- Use the `ILogger` interface for all logging.
- `console.log` is only acceptable in CLI commands and scripts.
- No `console.error` — use `logger.error()`.

### 11.7 Error Handling

- Never swallow errors.
- Never catch errors without handling or rethrowing.
- Use the framework's exception hierarchy for HTTP errors.
- Use `Result<T, E>` type for operations that can fail without throwing.
- All `catch` blocks must either handle the error, log it, or rethrow it.

### 11.8 No `any` Casts

- No `as any` casts.
- No `@ts-ignore` comments.
- `@ts-expect-error` is allowed only with a documented reason.

### 11.9 Immutability

- Prefer `const` over `let`.
- Never use `var`.
- Prefer immutable data structures.
- Use `readonly` for properties that should not change.
- Use `ReadonlyArray<T>` or `readonly T[]` for arrays that should not change.

### 11.10 Function Purity

- Prefer pure functions.
- Side effects must be documented.
- Functions that modify state must be named with verbs: `updateUser`, `deleteOrder`.

---

## 12. Dependency Rules

### 12.1 Minimal Dependencies

- Every dependency must be justified.
- No dependency is added without a clear use case.
- Prefer zero-dependency implementations for core packages.
- External dependencies are wrapped in adapters.

### 12.2 Optional Heavy Dependencies

- Heavy dependencies (Prisma, Pino, Redis, RabbitMQ clients) must never be hard dependencies of a
  plugin. (JSR has no peer-dependency concept, so the npm "peer dependency" pattern does not apply.)
- Instead, adapters either:
  - accept a **client instance injected via plugin options** (preferred — e.g.,
    `DatabasePlugin({ type: 'prisma', client: prismaClient })`), or
  - **lazily load** the driver via dynamic `import()` of an `npm:` specifier, failing with a clear
    error if it is not installed.
- The framework never installs a database driver by default.
- Users install the driver for the adapter they choose.

### 12.3 No Dependency Cycles

- Package dependency graph must be a DAG (Directed Acyclic Graph).
- Cycles are detected by tooling and fail the build.

### 12.4 Version Pinning

- All dependencies are pinned with `^` (caret) for compatible versions.
- Lock files are committed to the repository.
- Dependency updates go through PR review.

### 12.5 Security Auditing

- Dependency vulnerability scanning (e.g., OSV-Scanner against `deno.lock`) must pass in CI with
  zero high-severity vulnerabilities.
- Dependencies are reviewed quarterly.
- Unused dependencies are removed.

---

## 13. Security Rules

### 13.1 Input Validation

- All external input must be validated using Zod schemas.
- No unvalidated input reaches business logic.
- Validation errors return standardized error responses.

### 13.2 Input Sanitization

- All user-provided strings must be sanitized before storage or display.
- HTML encoding, tag stripping, and length limits are applied.
- Sanitization rules are configurable per field.

### 13.3 No Secrets in Code

- No hardcoded secrets, API keys, or passwords.
- Secrets are loaded via `SecretsPlugin` or environment variables.
- Secrets are never logged.
- The logger redacts known secret fields.

### 13.4 Secure Defaults

- All security-related plugins must default to the most secure configuration.
- CORS defaults to no origins allowed.
- JWT defaults to strong algorithms.
- Rate limiting defaults to enabled.
- Security headers defaults to enabled.

### 13.5 No `eval` or `Function` Constructor

- `eval()` is forbidden.
- `new Function()` is forbidden.
- Dynamic code execution is forbidden.

### 13.6 No `child_process` in Core

- The `kernel` and `common` packages must never use `child_process`.
- CLI commands that need process execution must go through runtime adapters.

---

## 14. Performance Rules

### 14.1 No Blocking Operations

- No synchronous I/O in request handlers.
- No synchronous I/O in middleware.
- All I/O operations must be async.

### 14.2 Lazy Initialization

- Services must be initialized lazily when possible.
- Use `registerFactory()` for lazy service instantiation.
- Heavy services are only created when first requested.

### 14.3 Tree-Shakeable Packages

- Every package must be tree-shakeable.
- Use ES module exports only.
- No side effects at import time.
- Declare subpath exports in each package's `deno.json` `exports` for granular imports (JSR's npm
  transform emits the equivalent `package.json` exports map with `sideEffects: false`):

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./plugin": "./src/plugin.ts",
    "./services": "./src/services/index.ts",
    "./adapters": "./src/adapters/index.ts"
  }
}
```

### 14.4 Minimal Bundle Size

- Each package must be as small as possible.
- Heavy dependencies (database drivers, broker clients, cloud SDKs) are never bundled or eagerly
  imported — adapters load them via dynamic `import()` of `npm:` specifiers, or accept a client
  instance injected through plugin options.
- Use feature detection to avoid bundling unused code.
- Bundle size is monitored in CI.

### 14.5 No Memory Leaks

- All event listeners must be cleaned up on shutdown.
- All timers must be cleared on shutdown.
- All database connections must be closed on shutdown.
- All message broker connections must be closed on shutdown.
- Graceful shutdown is mandatory.

---

## 15. Git and Commit Rules

### 15.1 Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`

Example:

```
feat(database-plugin): add transaction support

Implements Unit of Work pattern for transactional operations.
Supports nested transactions via savepoints.

Closes #123
```

### 15.2 Branch Naming

- Feature branches: `feat/[milestone]-[description]`
- Bug fix branches: `fix/[issue]-[description]`
- Release branches: `release/[version]`

### 15.3 No Direct Commits to Main

- All changes go through pull requests.
- No direct commits to `main` or `master`.
- All PRs require review and CI to pass.

### 15.4 Atomic Commits

- Each commit should represent a single logical change.
- Do not mix unrelated changes in a single commit.
- Do not split related changes across multiple commits.

---

## 16. Review and Approval Rules

### 16.1 Public API Changes Require Approval

- Any change to a package's `src/index.ts` exports requires explicit approval.
- The PR must update `PUBLIC_API.md` in the same change.
- The PR must include a rationale for the change.

### 16.2 Architecture Changes Require Approval

- Any change to the package dependency graph requires approval.
- Any change to the plugin contract requires approval.
- Any change to the `IPluginContext` interface requires approval.

### 16.3 New Dependencies Require Approval

- Adding a new dependency to any package requires approval.
- The PR must justify the dependency.
- The PR must verify the dependency does not introduce security vulnerabilities.

### 16.4 Never Rewrite Completed Milestones Unless Requested

- Once a milestone is complete and merged, do not rewrite it.
- Improvements go through the normal PR process.
- Refactoring must be justified and must not break backward compatibility.

### 16.5 Code Review Checklist

Reviewers must verify:

- [ ] No `any` types
- [ ] No runtime-specific APIs in core
- [ ] No circular dependencies
- [ ] Tests pass and coverage is 90%+
- [ ] JSDoc on all public APIs
- [ ] No breaking changes (or major version bump)
- [ ] No security vulnerabilities
- [ ] No performance regressions
- [ ] `PUBLIC_API.md` updated if API changed
- [ ] README.md updated if needed

---

## 17. Violation Handling

### 17.1 Violations Are Blocking

Any violation of these rules blocks the PR from merging. No exceptions.

### 17.2 Automated Enforcement

| Rule                                           | Enforcement Tool                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| No `any`                                       | `deno lint` rule `no-explicit-any`                                                          |
| No `eval`                                      | `deno lint` rule `no-eval`                                                                  |
| No unused variables                            | `deno lint` rule `no-unused-vars` + `noUnusedLocals` in `compilerOptions`                   |
| Strict TypeScript                              | Root `deno.json` `compilerOptions` with `strict: true`                                      |
| Test coverage 90%+                             | `deno test --coverage` threshold check in CI                                                |
| No circular dependencies                       | `deno info --json` graph check (custom script) or `dependency-cruiser` via `npm:` specifier |
| No security vulnerabilities                    | OSV-Scanner against `deno.lock` in CI                                                       |
| Code formatting                                | `deno fmt`                                                                                  |
| Code style                                     | `deno lint`                                                                                 |
| Runtime-specific imports outside `runtime` pkg | Custom `deno lint` plugin rule / CI grep gate                                               |
| JSDoc on exports                               | `deno doc --lint`                                                                           |

### 17.3 Escalation

If a rule needs to be violated for a justifiable reason:

1. Document the reason in the PR description.
2. Document the mitigation plan.
3. Document the timeline for compliance.
4. Get explicit approval from a maintainer.
5. Add a `// deno-lint-ignore <rule>` with the reason documented.

### 17.4 Rule Updates

These rules may be updated through:

1. A PR that modifies this document.
2. Review and approval by maintainers.
3. The change must not retroactively break existing code without a migration path.

---

## Appendix: Quick Reference

### The 10 Commandments of Hono Enterprise

1. **Thou shalt not break backward compatibility.**
2. **Thou shalt not ship a milestone that does not compile.**
3. **Thou shalt not ship a milestone without tests.**
4. **Thou shalt not use `any`.**
5. **Thou shalt not depend on runtime-specific APIs in core.**
6. **Thou shalt prefer plugins over built-in features.**
7. **Thou shalt prefer composition over inheritance.**
8. **Thou shalt prefer adapters over implementations.**
9. **Thou shalt prefer interfaces over concrete types.**
10. **Thou shalt document every public API.**

### The 5 Optional Rules

1. **Decorators are optional.** The framework must work without them.
2. **Dependency Injection is optional.** The framework must work without it.
3. **Reflection is optional.** The framework must work without it.
4. **Everything has a programmatic API.** No feature requires decorators or reflection.
5. **Everything is replaceable.** Any plugin can be swapped without touching application code.

### The 5 Architecture Rules

1. **Controllers depend only on services.**
2. **Services depend only on repositories or abstractions.**
3. **Repositories depend only on adapters.**
4. **Framework code never depends on application code.**
5. **Application code never depends on runtime-specific implementations.**
