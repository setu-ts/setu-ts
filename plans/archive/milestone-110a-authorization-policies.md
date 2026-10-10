# Milestone 110a — Authorization Policies (`@setu-ts/common` + `@setu-ts/auth-plugin` + `@setu-ts/decorator-plugin`)

> **Status:** Planning. Branch: `feat/m110a-authorization-policies`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR against `develop`.

## 0. Objective & scope

One place to answer "may this principal do this, to this target?" — asynchronously, with the target
as an argument, reachable declaratively from a route (a functional guard and a class-form
`@RequirePolicy`) and imperatively from a handler or service, failing closed with the same
`401`/`403`/`501` bodies the existing role guards answer. `IAuthorizationService`
(`common/src/services/auth.ts:152`) is synchronous and takes a principal plus a role or permission
STRING, so no target can reach a decision; today the only home for "the author of this document" is
a hand-written middleware that re-derives the guards' guarantees by hand. This milestone adds a NEW
capability beside `CAPABILITIES.AUTHORIZATION`, which stays byte-for-byte unchanged. It is the seam
110b's scoped RBAC is built on: a policy is the unit an application — or an external engine such as
OpenFGA or Casbin — plugs in at.

- **In scope:** the `common` contract (`IAuthorizationPolicyService`, `PolicyDefinition`,
  `CAPABILITIES.AUTHORIZATION_POLICIES`) plus one shared refusal-init helper; in `auth-plugin` the
  ONE evaluator (`PolicyService`), `definePolicy`, the `policies` option, the `requirePolicy` route
  guard, the throwing `AuthorizationDeniedError` / `UnknownPolicyError`, and the startup scan that
  refuses a guard naming an unregistered policy or ability; in `decorator-plugin` the class form
  (`@Policy`, `@Ability`, `DecoratorPluginOptions.policies`) and `@RequirePolicy`; the M57 brand on
  every policy guard so `deriveSecurity` documents it; `PUBLIC_API.md`, both READMEs,
  `ARCHITECTURE.md` §14, `CHANGELOG.md`, and a new `docs/authorization.md` ("where does ABAC go").
- **NOT this milestone:** scoped grants (110b); an ingress-behaviour form of the check (named gap,
  §3.13 — owner: proposed M110c); rerouting the six role/permission guards through the evaluator
  (ROADMAP fixes this out); policy decision explanations through M98h's diagnostics connector
  (named, unowned — the M98h source observes `RbacService` only); a per-check deadline (§9).

## 1. Contracts verified from SOURCE (not names)

| Reference                                        | Source (file:line)                                                                                                      | Verified surface / fact                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IAuthorizationService`                          | `packages/common/src/services/auth.ts:152`                                                                              | Four SYNCHRONOUS members (`hasRole`/`hasPermission`/`hasAnyRole`/`hasAllPermissions`), each `(principal: IPrincipal, string \| string[]) => boolean`. No target parameter, no `null` principal. Unchanged by this milestone.                                                                |
| `IPrincipal`                                     | `packages/common/src/services/auth.ts:16`                                                                               | `{ id; roles?; permissions?; claims? }`, all readonly. The policy check receives it verbatim.                                                                                                                                                                                               |
| `CAPABILITIES` / token grammar                   | `packages/common/src/tokens.ts:59,174,295,323,343`                                                                      | `AUTHORIZATION: 'authorization'`, `AUTHORIZATION_DIAGNOSTICS`, `IDEMPOTENCY`; `TOKEN_PATTERN` is kebab segments joined by `.` — `'authorization-policies'` matches (one segment, hyphenated).                                                                                               |
| `respondWithAuthorizationFailure`                | `packages/common/src/errors/authorization-responder.ts:39`                                                              | Four arms; the strings (`401 Unauthorized / Authentication required`, `403 Forbidden / Insufficient privileges`, `501 Not Implemented / Authorization is not configured`) are INLINE literals in the switch — a second writer of the same bodies would duplicate them (§3.9).               |
| `withHttpStatusHint` / `HttpStatusHint`          | `packages/common/src/errors/status-hint.ts`                                                                             | `HttpStatusHint extends ErrorResponseInit` with `status` (400–599) and REQUIRED `detail`; the hint is honoured by `errorHandler` only (`exceptions/src/middleware/error-handler.ts`); the kernel's fallback 500 does NOT read it (grep: no `httpStatusHintOf` under `packages/kernel/src`). |
| `withSecurityMetadata` / `RouteSecurityMetadata` | `packages/common/src/http.ts:538,664,698,725`                                                                           | `Symbol.for('setu.security.metadata')`, `{ authenticated: boolean }`, defined `configurable: true, writable: false, enumerable: false`; read by `openapi-plugin`'s `deriveSecurity`.                                                                                                        |
| The six guards                                   | `packages/auth-plugin/src/guards/index.ts`                                                                              | 401 when `ctx.request.user` absent; `resolveAuthorization` answers 501 via `services.has` (per request); 403 on a failed check; all branded `AUTHENTICATED`. Untouched here.                                                                                                                |
| `AuthPlugin` provides / register                 | `packages/auth-plugin/src/plugin/auth-plugin.ts:126-141,440-519`                                                        | `provides` is assembled conditionally; `optionalDependencies: [CAPABILITIES.SESSION]`; `priority: PLUGIN_PRIORITY.NORMAL`; services registered synchronously in `register()`; `onClose` already used.                                                                                       |
| `AuthPluginOptions`                              | `packages/auth-plugin/src/interfaces/index.ts:270`                                                                      | Has `jwt?`/`middleware?`/`apiKey?`/`local?`/`rbac?`/`authorizationDiagnostics?`/`session?`/`strategies?`/… — no `policies` member. Validation happens at `AuthPlugin(...)` construction (`AuthPluginConfigurationError`, `src/errors.ts`).                                                  |
| `IRouterApi.listRoutes` / `RouteInfo`            | `packages/common/src/plugin.ts:58,162`                                                                                  | `listRoutes(): readonly RouteInfo[]`, each carrying `definition.middleware`. Available on `IPluginContext.router`; the router has no seal, so a route may be added after `start()`.                                                                                                         |
| Lifecycle order                                  | `packages/kernel/src/application/application.ts:770-798`                                                                | all `register()` → `runInit` → pipeline compile → `runBootstrap` → `registry.seal()` → `setHandler` → `listen`. Routes registered in any `register()` exist at bootstrap.                                                                                                                   |
| `ILifecycleApi.onBootstrap`                      | `packages/common/src/plugin.ts:341`                                                                                     | "Runs immediately before the server starts listening."                                                                                                                                                                                                                                      |
| `DecoratorPlugin` chain order                    | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:943-984`                                                      | guards → `appendAuthorizationMiddleware` (`@Roles`/`@Permissions`, when `enforceRoles`) → interceptors/middleware/filters → validation (when `enforceSchemas`) → idempotency. Optional deps resolved ONCE at `register()` (lines 1076-1095).                                                |
| `DecoratorPlugin` optional deps / priority       | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:1044-1067`                                                    | `priority: PLUGIN_PRIORITY.LOW`; `optionalDependencies` lists VALIDATION, AUTHORIZATION, VIEW, IDEMPOTENCY (+ ingress tokens). So AuthPlugin (NORMAL) registers before it.                                                                                                                  |
| `@Render` / `@Idempotent` refusal precedent      | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:471,492`                                                      | New-surface decorator with no provider THROWS at `register()` naming route + remedy (not warn). `@RequirePolicy` follows this, not the `@Roles` warn arm (which preserves released behaviour).                                                                                              |
| `buildRouteSchema` public marker                 | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:585-600`                                                      | `@Public`'s `security: []` is emitted only when no enforced restriction exists; `@RequirePolicy` must join that condition (§3.10).                                                                                                                                                          |
| Decorator metadata model                         | `packages/decorator-plugin/src/metadata/metadata-store.ts:239-280`, `context-bridge.ts`                                 | `RouteMetadata` is package-local (not in `common`); method decorators use `methodDecorator((store, target, handler) => store.mutateMethod(...))`; class decorators drain via `Symbol.metadata` (M76). Adding route/class slots needs no `IMetadataStore` widening (the M97a precedent).     |
| `instantiate(target, ctx)`                       | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:281`                                                          | DI-aware construction (container when present, else class-position `@Inject`); reused for class policies.                                                                                                                                                                                   |
| `IngressContext`                                 | `packages/common/src/services/ingress.ts:55`                                                                            | `kind`/`name`/`payload`/`attempt?`/`headers?`/`consumer?` — NO principal; the JSDoc states "no `state`, no `services`".                                                                                                                                                                     |
| `serializeError`                                 | `packages/common/src/errors/serialize-error.ts:165`                                                                     | Bounded, total; used for the throwing-policy log.                                                                                                                                                                                                                                           |
| Name collisions                                  | `grep -rn "export.*\b(Policy\|Ability\|RequirePolicy\|definePolicy\|requirePolicy\|PolicyDefinition)\b" packages/*/src` | Empty — none of the new names exist.                                                                                                                                                                                                                                                        |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                           | Resolution (picked side)                                                                                                                                                                                                                                                                                                                | Doc deliverable (same PR)                                            |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| C1 | ROADMAP names the route guard `can(policy, ability, target?)`; AI_GUIDELINES §10.4 names guards `requireXxx`.                                                                                                      | §10.4 wins: the guard is `requirePolicy`. `can` stays the name of the boolean member on the service, where it reads naturally.                                                                                                                                                                                                          | ROADMAP M110a scope bullet corrected to `requirePolicy`.             |
| C2 | ROADMAP gives every ability the signature `(principal \| null, target?) → boolean`.                                                                                                                                | Refined, not inherited: an ability sees `null` ONLY when it opts in (`{ anonymous: true, check }`). Otherwise an anonymous principal is denied `401` before the check runs, so the default is fail-closed and a non-anonymous check is typed `IPrincipal` (no null handling to forget). Also what makes the M57 brand truthful (§3.10). | ROADMAP M110a "Policies" bullet amended; PUBLIC_API states the rule. |
| C3 | ROADMAP's contract sketch is `authorize(...) → Promise<AuthorizationDecision>` beside `can(...) → Promise<boolean>`; the same section's survey says applications need "a throwing check plus a non-throwing twin". | The survey wins: `authorize` REJECTS on a deny (with an `errorHandler`-honoured `401`/`403` hint) and `can` resolves a boolean; both call one private evaluation. No public `AuthorizationDecision` type — it would be dead surface (the guard derives `401` vs `403` from principal presence, §3.6).                                   | ROADMAP M110a contract bullet corrected.                             |
| C4 | ROADMAP: "an unknown policy or ability named by a guard … fails at `register()`". A functional guard is a value an application builds; no `register()` sees it.                                                    | Refused at STARTUP instead: AuthPlugin's `onBootstrap` hook scans `ctx.router.listRoutes()` for policy-guard brands and throws before `listen`. `@RequirePolicy` is refused in DecoratorPlugin's own `register()`. Both precede serving; a route added after `start()` is the documented residual (§3.7).                               | ROADMAP wording "fails at startup"; PUBLIC_API states the residual.  |
| C5 | ARCHITECTURE §14 "Authorization" lists the six guards as the whole authorization surface.                                                                                                                          | Extended, not contradicted.                                                                                                                                                                                                                                                                                                             | ARCHITECTURE §14 gains a "Policies" subsection.                      |

## 3. Design decisions

### 3.1 One new capability; the RBAC capability is untouched

- **Decision:** `CAPABILITIES.AUTHORIZATION_POLICIES = 'authorization-policies'`, provided by
  `AuthPlugin` ALWAYS (independent of `rbac`, `jwt`, or a `policies` option), so class-form policies
  have a registry even when the functional option is absent. Service contract in `common`:

  ```ts
  interface IAuthorizationPolicyService {
    can<A extends string, T>(
      principal: IPrincipal | null,
      policy: PolicyRef<A, T>,
      ability: A,
      target?: T,
    ): Promise<boolean>;
    authorize<A extends string, T>(
      principal: IPrincipal | null,
      policy: PolicyRef<A, T>,
      ability: A,
      target?: T,
    ): Promise<void>;
    describe(policy: string, ability: string): PolicyAbilityInfo | undefined;
    define(policy: PolicyDefinition): void;
  }
  type PolicyRef<A, T> = string | PolicyDefinition<A, T>; // a definition is looked up BY ITS NAME
  interface PolicyAbilityInfo {
    readonly anonymous: boolean;
  }
  ```

- **Why:** a new token is non-breaking; `IAuthorizationService` has three in-repo consumers (guards,
  `@Roles` middleware, M98h). Always-provided removes a "registered class policy but no option"
  failure arm. `describe` (not a bare `has`) because the M57 brand needs `anonymous` (§3.10).
- **Test home:** `auth-plugin/test/integration/policy-plugin.test.ts` (token present with no
  options, with `rbac` absent).

### 3.2 Policy definition shape and `definePolicy`

- **Decision:** `common` declares

  ```ts
  type PolicyCheck<T> = (
    principal: IPrincipal,
    target: T | undefined,
  ) => boolean | Promise<boolean>;
  type AnonymousPolicyCheck<T> = (
    principal: IPrincipal | null,
    target: T | undefined,
  ) => boolean | Promise<boolean>;
  type PolicyAbility<T> = PolicyCheck<T> | {
    readonly anonymous: true;
    readonly check: AnonymousPolicyCheck<T>;
  };
  interface PolicyDefinition<A extends string = string, T = never> {
    readonly name: string;
    readonly abilities: Readonly<Record<A, PolicyAbility<T>>>;
    before?(
      principal: IPrincipal,
      ability: A,
      target: T | undefined,
    ): boolean | undefined | Promise<boolean | undefined>;
  }
  ```

  `auth-plugin` exports
  `definePolicy<A extends string, T>(definition: PolicyDefinition<A, T>):
  PolicyDefinition<A, T>`,
  which validates (§3.3) and returns a frozen copy. Ability names are inferred from the object
  literal's keys, so `requirePolicy(postPolicy, 'updaet')` is a compile error. The target type is
  inferred from the check's annotated parameter (`update: (p, post: Post | undefined) => …`); an
  unannotated check gets `T = unknown`.

  **Two typing choices are load-bearing, both established by `deno check` probe in review, not by
  reasoning.** The first draft declared `before` as a function-typed PROPERTY with default
  `T = unknown`, and a typed policy was then NOT assignable to the bare `PolicyDefinition` the
  registry accepts
  (`TS2322: PolicyDefinition<"update" | "read", Post> is not assignable to
  PolicyDefinition<string, unknown>`)
  — under `strictFunctionTypes` a check is contravariant in its target and `before` in its ability,
  so `AuthPluginOptions.policies: readonly PolicyDefinition[]` would have refused every typed
  policy. (1) `before` is a METHOD signature, which TypeScript checks bivariantly, so
  `ability: 'update' | 'read'` is accepted where `string` is declared; (2) the default target is
  `never`, so `PolicyCheck<Post>` is assignable to `PolicyCheck<never>` (its parameter
  `never | undefined` narrows to `undefined`, assignable to `Post | undefined`). The bare
  `PolicyDefinition` is therefore the type-erased form the registry stores; evaluation passes the
  caller's target through an internal cast. The probe also confirmed the misspelled-ability error
  and `before`'s ability-union inference both survive the change.
- **Why:** one target type per policy keeps generics tractable; the `anonymous` object arm makes
  opting in to `null` explicit and greppable.
- **Test home:** `auth-plugin/test/unit/policies/define-policy.test.ts` — a `@ts-expect-error` row
  for a misspelled ability AND a compile-time row assigning a typed policy to
  `readonly PolicyDefinition[]` (the defect above; it fails `deno check` if one of the two typing
  choices is reverted).

### 3.3 Validation at definition and at `define`

- **Decision:** a definition is refused (`AuthPluginConfigurationError`, naming the policy) when:
  `name` is not a non-empty string matching the token-segment grammar (`^[a-z][a-z0-9-]*$`, so it is
  log-safe and greppable); `abilities` is empty; an ability key is `before` or not a non-empty
  string; an ability value is neither a function nor `{ anonymous: true, check: function }`;
  `before` is present and not a function. `define` additionally refuses a DUPLICATE name and any
  call after the service is sealed (§3.7). Ability lookup at evaluation uses `Object.hasOwn` on the
  frozen abilities copy, so `toString`/`constructor`/`__proto__` never resolve as abilities.
- **Why:** an inherited-property lookup would make `can(user, 'post', 'constructor')` evaluate
  `Object` — a type confusion that returns `true`-ish garbage; `hasOwn` plus literal-`true` closes
  it twice. Duplicates silently shadowing a policy would be a privilege bug.
- **Test home:** `define-policy.test.ts`, `policy-service.test.ts` (prototype-name rows).

### 3.4 Evaluation semantics — fixed, not configurable

- **Decision:** `PolicyService.#evaluate(principal, name, ability, target)`:
  1. unknown policy → reject `UnknownPolicyError(policy)`; unknown ability → reject
     `UnknownPolicyError(policy, ability)`. Both name the identifiers, never the target.
  2. `principal === null` and the ability is not `anonymous` → deny (`authentication-required`),
     check NOT called.
  3. `principal !== null` and `before` defined → `r = await before(principal, ability, target)`;
     `r === true` → allow; `r === undefined` → continue; ANY other value (including `null`, `1`,
     `'yes'`) → deny. `before` is skipped for a `null` principal.
  4. `r = await check(principal, target)`; allow iff `r === true`.
  5. A throw or rejection from `before` or `check` → deny, reported once through the logger at
     `error` with `{ policy, ability, error: serializeError(e) }` — never the target, never the
     principal. The logger is read at CALL time through a thunk (the M52b lesson), and a throwing
     logger cannot change the outcome (the M109a `safeLog` precedent).
  6. The deny's failure kind is `authentication-required` when `principal === null`, else
     `insufficient-privileges`.
- **Why:** these are the ROADMAP's "fixed semantics" made exhaustive. `before` returning `null`
  denying is deliberate fail-closed; documented.
- **Test home:** `policy-service.test.ts` — a table over every row above, each with a negative
  control (e.g. a check returning `1` must deny; reverting to truthiness fails it).

### 3.5 `can` and `authorize` — one evaluator, two shapes

- **Decision:** `can` resolves `#evaluate(...).allowed`; `authorize` resolves on allow and rejects
  with `AuthorizationDeniedError` on deny. `AuthorizationDeniedError` (auth-plugin) carries
  `readonly failure: 'authentication-required' | 'insufficient-privileges'`, `readonly policy`,
  `readonly ability`, and is branded with
  `withHttpStatusHint(err, authorizationFailureInit(failure))` (§3.9), so `errorHandler` answers the
  guards' exact body. Both reject `UnknownPolicyError` (unbranded → masked 500: a programming error,
  not a caller fault) for unknown names. Neither member ever throws synchronously (the M52b class).
- **Why:** the surveyed applications' two shapes; one evaluator so they cannot disagree.
- **Test home:** `policy-service.test.ts`;
  `auth-plugin/test/integration/policy-refusal-parity.test.ts` (thrown deny via
  `errorHandler({ format: 'rfc9457' })` byte-identical to a `requireRole` refusal, modulo
  `instance`).

### 3.6 The route guard `requirePolicy`

- **Decision:**
  `requirePolicy<A, T>(policy: PolicyDefinition<A, T>, ability: A, target?: T |
  ((ctx: IRequestContext) => T | Promise<T>))`.
  Per request: no `AUTHORIZATION_POLICIES` provider →
  `respondWithAuthorizationFailure(ctx, 'not-configured')` (501); else resolve target (a FUNCTION
  target is always called as an extractor; documented);
  `allowed = await service.can(user ?? null,
  policy.name, ability, target)`; deny → respond
  `authentication-required` when no user, else `insufficient-privileges`; allow → `next()`. An
  extractor's throw PROPAGATES (the request fails — `errorHandler` maps a `DatabaseUnavailableError`
  to `503` rather than a misleading `403`); the handler never runs. The guard is a policy OBJECT
  only, so its ability is type-checked; the string form is reached imperatively.
- **Why:** consuming the public contract (not the concrete class) means a replacement provider
  serves the guard. Short-circuit on every refusal.
- **Test home:** `auth-plugin/test/unit/policies/require-policy.test.ts` (short-circuit: handler and
  later middleware do not run on each refusal); integration parity test (§3.12).

### 3.7 Startup refusal of an unknown name, and sealing

- **Decision:** every `requirePolicy` middleware carries a module-private brand
  (`Symbol.for('setu.auth.policy-guard')` → `{ policy, ability }`). AuthPlugin's `onBootstrap` hook
  walks `ctx.router.listRoutes()`, and for each branded route middleware whose `describe()` is
  `undefined` throws `AuthPluginConfigurationError` naming method, path, policy and ability —
  start() fails before `listen`. It then calls the internal `PolicyService.seal()`; `define` after
  that throws. Residuals, documented and tested: a route added after `start()`, or a guard added as
  GLOBAL middleware (`ctx.middleware.add`, not in `RouteInfo`), is not scanned — its unknown name
  rejects inside `can`, which propagates (fail closed; masked 500 under `errorHandler`).
- **Why:** C4. Sealing removes runtime mutation of a security registry.
- **Test home:** `auth-plugin/test/integration/policy-startup-scan.test.ts` (unknown policy object
  never registered; unknown ability via an unchecked cast; route added post-start; seal).

### 3.8 Functional registration: `AuthPluginOptions.policies`

- **Decision:** `policies?: readonly PolicyDefinition[]` (definitions from `definePolicy` or any
  conforming object), validated at `AuthPlugin(...)` construction (§3.3 rules + duplicates among the
  list) and `define`d in `register()`.
- **Why:** construction-time refusal is the package's convention. No `RegistryFactory` arm: a policy
  needing a capability uses the class form (§3.11), which gets DI; an arm resolved at `onInit` would
  land AFTER DecoratorPlugin's register-time `@RequirePolicy` validation.
- **Test home:** `policy-plugin.test.ts`.

### 3.9 One owner for the refusal bodies

- **Decision:** `common` gains
  `authorizationFailureInit(failure: AuthorizationFailure):
  HttpStatusHint` returning the
  `{ status, title, detail }` each arm writes; `respondWithAuthorizationFailure` is rewritten to
  `respondWithError(target,
  authorizationFailureInit(failure))`. `AuthorizationDeniedError` brands
  with the same value.
- **Why:** §11.1 — two writers of three status/title/detail triples would drift.
- **Test home:** `common/test/unit/authorization-responder.test.ts` (each arm's init; the responder
  output unchanged, pinned against the literals).

### 3.10 M57 brand and the OpenAPI `@Public` marker

- **Decision:** `requirePolicy` and `@RequirePolicy` middleware are branded with
  `withSecurityMetadata(mw, { authenticated: !anonymous })` where `anonymous` comes from the
  ability. `buildRouteSchema` omits `@Public`'s `security: []` when the route carries any
  `@RequirePolicy` whose ability is not anonymous (joining the `@Roles` condition). No
  `openapi-plugin` change.
- **Why:** an anonymous-allowed ability must not be documented as requiring authentication.
- **Test home:** `auth-plugin/test/integration/policy-openapi.test.ts` (real `OpenApiPlugin` with
  `deriveSecurity`: authenticated route documented, anonymous route not);
  `decorator-plugin/test/unit/require-policy-schema.test.ts`.

### 3.11 Class form in decorator-plugin

- **Decision:** `@Policy(name)` (class) records the policy name; `@Ability(options?)` (method,
  `options.anonymous?: boolean`) marks a method as an ability; an optional `before` method is the
  `before` hook (by method name, matching NestJS).
  `DecoratorPluginOptions.policies?: readonly
  Constructor[]` — at `register()`, BEFORE
  controllers: each class goes through `registerInContainer` then `instantiate()` — the same two
  calls `registerController` makes, so constructor injection works with and without `DiPlugin` — and
  is converted to a `PolicyDefinition` whose checks call the bound methods, and `define`d on the
  resolved `AUTHORIZATION_POLICIES` service. Refusals at `register()`: a class without `@Policy`, a
  `@Policy` class with no `@Ability`, `policies` given with no provider.
  `@RequirePolicy(policy, ability, target?)` (method; repeatable — ALL must allow, evaluated top to
  bottom) takes a `@Policy` class or a `PolicyDefinition`; ability typed as the definition's ability
  keys, or for a class as `keyof InstanceType<C> & string` — the type cannot tell an `@Ability`
  method from an ordinary one, so naming a non-ability method compiles and is refused at
  `register()` through `describe`; target a value or `(ctx) => T`. Appended after
  `@Roles`/`@Permissions` and before interceptors; validated at `register()` via `describe` (unknown
  → throw naming route, policy, ability; no provider → throw naming `AuthPlugin`).
  `AUTHORIZATION_POLICIES` joins `optionalDependencies`. The packages may not import each other
  (AI_GUIDELINES §2.2), so decorator-plugin builds its own thin middleware over the same public
  contract — evaluation stays in the one `PolicyService` — and the parity test (§3.12) proves the
  two entry points agree.
- **Why:** functional default / class opt-in (M65); DI for policies that need a repository.
- **Test home:** `decorator-plugin/test/unit/policy-decorators.test.ts`,
  `decorator-plugin/test/integration/require-policy-e2e.test.ts`.

### 3.12 Parity across entry points

- **Decision:** one integration test drives `requirePolicy`, `@RequirePolicy`, `service.can` and
  `service.authorize` (through `errorHandler`) for the SAME policy, principal and target, under a
  NON-default configuration (`format: 'rfc9457'`, a `before` hook, an anonymous ability), and
  asserts identical allow/deny and byte-identical refusal bodies (modulo `instance`).
- **Test home:** `decorator-plugin/test/integration/policy-parity.test.ts` (decorator-plugin's test
  may import auth-plugin as a dev-time test dependency, as its existing role-parity test does).

### 3.13 Ingress — the gap is named, no behaviour ships

- **Decision:** no ingress behaviour form. `IngressContext` carries no principal, and a behaviour
  that evaluated as anonymous would deny everything (or, worse, pass anonymous abilities) silently.
  Imperative `can`/`authorize` already work in any ingress handler, because the principal is an
  explicit argument the application derives from its payload. The gap is recorded in ROADMAP as a
  proposed **M110c — ingress principal source** placeholder.
- **Test home:** none (no behaviour); `docs/authorization.md` shows the imperative ingress form.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — a new capability token, new types and new exports; no existing
interface gains a member. `respondWithAuthorizationFailure` keeps its signature and output.

| Exported symbol                                                                                                       | Kind      | Consumer / real code path that READS it                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES.AUTHORIZATION_POLICIES` (common)                                                                        | token     | AuthPlugin `provides`/`register`; `requirePolicy`; DecoratorPlugin `optionalDependencies` + `register`            |
| `IAuthorizationPolicyService` (common)                                                                                | interface | `PolicyService implements`; `requirePolicy`; DecoratorPlugin's `@RequirePolicy` middleware and class registration |
| `PolicyDefinition`, `PolicyAbility`, `PolicyCheck`, `AnonymousPolicyCheck`, `PolicyRef`, `PolicyAbilityInfo` (common) | types     | `IAuthorizationPolicyService` signatures; `definePolicy`; DecoratorPlugin's class conversion                      |
| `authorizationFailureInit` (common)                                                                                   | function  | `respondWithAuthorizationFailure`; `AuthorizationDeniedError`                                                     |
| `definePolicy` (auth-plugin)                                                                                          | function  | applications; `AuthPluginOptions.policies`                                                                        |
| `requirePolicy` (auth-plugin)                                                                                         | function  | applications' route definitions; scanned at bootstrap                                                             |
| `AuthorizationDeniedError` (auth-plugin)                                                                              | class     | `PolicyService.authorize` rejection; applications' `instanceof`                                                   |
| `UnknownPolicyError` (auth-plugin)                                                                                    | class     | `PolicyService` rejection; applications' `instanceof`                                                             |
| re-export `IAuthorizationPolicyService` (auth-plugin)                                                                 | type      | the package's existing "re-export common contracts" block                                                         |
| `Policy`, `Ability`, `RequirePolicy` (decorator-plugin)                                                               | functions | DecoratorPlugin `policies` registration and route registration                                                    |
| `RequirePolicyTarget` (decorator-plugin)                                                                              | type      | `@RequirePolicy`'s third parameter                                                                                |

### 4.1 Options — every option names its consumer

| Option                            | Consumer                                                      | Behavior (per implementation)                                                   |
| --------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `AuthPluginOptions.policies`      | `AuthPlugin(...)` validation; `register()` → `service.define` | Validated at construction; each defined at register; absent → empty registry    |
| `DecoratorPluginOptions.policies` | `DecoratorPlugin.register()` → `instantiate` → `define`       | Each class converted and defined before controllers; refused without a provider |
| `@Ability({ anonymous })`         | class conversion → `PolicyAbility` arm                        | `true` → `{ anonymous: true, check }`; absent/`false` → plain check             |

## 5. Implementation files

| File                                                          | Purpose                                                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/authorization-policies.ts`      | contract + definition types                                                                         |
| `packages/common/src/tokens.ts`                               | `AUTHORIZATION_POLICIES`                                                                            |
| `packages/common/src/errors/authorization-responder.ts`       | `authorizationFailureInit`; responder rewritten over it                                             |
| `packages/common/src/index.ts`                                | barrel                                                                                              |
| `packages/auth-plugin/src/policies/policy-service.ts`         | `PolicyService` (evaluator, define, describe, seal)                                                 |
| `packages/auth-plugin/src/policies/define-policy.ts`          | `definePolicy` + shared `validatePolicyDefinition` (internal export)                                |
| `packages/auth-plugin/src/policies/errors.ts`                 | `AuthorizationDeniedError`, `UnknownPolicyError`                                                    |
| `packages/auth-plugin/src/policies/policy-guard.ts`           | `requirePolicy`, the guard brand, `policyGuardOf` (internal)                                        |
| `packages/auth-plugin/src/policies/startup-scan.ts`           | `scanPolicyGuards(routes, service)` (internal)                                                      |
| `packages/auth-plugin/src/plugin/auth-plugin.ts`              | `provides`, `policies` option, register, `onBootstrap` scan + seal                                  |
| `packages/auth-plugin/src/interfaces/index.ts`                | `AuthPluginOptions.policies`                                                                        |
| `packages/auth-plugin/src/index.ts`                           | barrel                                                                                              |
| `packages/decorator-plugin/src/decorators/policy.ts`          | `@Policy`, `@Ability`, `@RequirePolicy`, `RequirePolicyTarget`                                      |
| `packages/decorator-plugin/src/plugin/policy-registration.ts` | class → `PolicyDefinition` conversion + `@RequirePolicy` middleware builder + validation (internal) |
| `packages/decorator-plugin/src/metadata/metadata-store.ts`    | route `policies` slot; class policy slots                                                           |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts`    | option, optional dep, ordering, `buildRouteSchema` public-marker condition                          |
| `packages/decorator-plugin/src/index.ts`                      | barrel                                                                                              |
| `docs/authorization.md`                                       | "where does ABAC go" guide (fence-gated)                                                            |
| `docs/README.md`, `scripts/check-docs.ts` `REQUIRED_GUIDES`   | index the new guide (same precedent as `docs/localization.md`)                                      |

Doc and process deliverables in the same PR: `PUBLIC_API.md` (common contract rows, auth-plugin and
decorator-plugin sections), both package READMEs, `ARCHITECTURE.md` §14 "Policies" (C5), a
`CHANGELOG.md` `Unreleased` → `Added` entry (no `docs/upgrading.md` entry — nothing breaks), the
ROADMAP corrections C1–C4 plus the proposed M110c placeholder, the ROADMAP Progress row flipped to
`✅`, the CLAUDE.md "Current status" entry, and this plan moved to `plans/archive/`. Every new
symbol's JSDoc carries `@since 0.9.0` (the next release; `check:since-tags` skips ahead-of-registry
versions).

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                 | src covered                             | Key assertions                                                                                                                                                                    |
| ------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/authorization-responder.test.ts` (create — none exists) | authorization-responder.ts              | each arm's init literal; responder output unchanged across all four arms                                                                                                          |
| `common/test/unit/authorization-policies-contract.test.ts`                | authorization-policies.ts, tokens.ts    | token grammar; type-level rows (`@ts-expect-error` on a misspelled ability through `PolicyRef<A,T>`)                                                                              |
| `common/test/unit/barrel-exports.test.ts` (extend)                        | index.ts                                | new symbols pinned against the barrel                                                                                                                                             |
| `auth-plugin/test/unit/policies/define-policy.test.ts`                    | define-policy.ts                        | every §3.3 refusal by name; frozen copy; inferred ability names                                                                                                                   |
| `auth-plugin/test/unit/policies/policy-service.test.ts`                   | policy-service.ts, errors.ts            | §3.4 table incl. literal-`true`, `null`/`1` deny, `before` arms, throwing policy denies + one log, throwing logger, prototype names, unknown names reject, no sync throw, seal    |
| `auth-plugin/test/unit/policies/require-policy.test.ts`                   | policy-guard.ts                         | 501/401/403/allow; extractor sync/async; extractor throw propagates; short-circuit; brand values                                                                                  |
| `auth-plugin/test/unit/policies/startup-scan.test.ts`                     | startup-scan.ts                         | unknown policy / ability named; non-guard middleware ignored                                                                                                                      |
| `auth-plugin/test/integration/policy-plugin.test.ts`                      | auth-plugin.ts (new arms), interfaces   | token always provided; option validated at construction; real kernel app: allow/deny round trip                                                                                   |
| `auth-plugin/test/integration/policy-startup-scan.test.ts`                | auth-plugin.ts onBootstrap              | `start()` rejects naming route/policy/ability; post-start route residual; `define` after start throws                                                                             |
| `auth-plugin/test/integration/policy-refusal-parity.test.ts`              | errors.ts + responder                   | thrown `authorize` deny through `errorHandler({format:'rfc9457'})` byte-identical to `requireRole` refusal (401 and 403)                                                          |
| `auth-plugin/test/integration/policy-openapi.test.ts`                     | brand                                   | real `OpenApiPlugin` `deriveSecurity`: authenticated vs anonymous ability                                                                                                         |
| `auth-plugin/test/unit/barrel-exports.test.ts` (extend — it exists)       | index.ts                                | new exports pinned                                                                                                                                                                |
| `decorator-plugin/test/unit/policy-decorators.test.ts`                    | decorators/policy.ts, metadata-store.ts | metadata recorded; repeatable `@RequirePolicy` order; `@Ability` anonymous; type rows                                                                                             |
| `decorator-plugin/test/unit/policy-registration.test.ts`                  | policy-registration.ts                  | conversion; `before` method wired; every register-time refusal; middleware 501/401/403/allow; extractor                                                                           |
| `decorator-plugin/test/integration/require-policy-e2e.test.ts`            | decorator-plugin.ts arms                | real kernel app + AuthPlugin: class policy with injected dependency; `@RequirePolicy` all-of; order after `@Roles`, before validation (401 → 403 → 400); `@Public` marker omitted |
| `decorator-plugin/test/unit/require-policy-schema.test.ts`                | decorator-plugin.ts `buildRouteSchema`  | `@Public` marker omitted beside a non-anonymous `@RequirePolicy`, kept beside an anonymous one                                                                                    |
| `decorator-plugin/test/integration/policy-parity.test.ts`                 | cross-entry                             | §3.12                                                                                                                                                                             |
| `test/guide-fence-compiler.test.ts` (register `docs/authorization.md`)    | docs                                    | every fence compiles; the guide is added to `GUIDES` in `test/fixtures/snippets/fence-engine.ts` and to the test's `EXPECTED_INVENTORY`                                           |

Negative controls (each observed failing, then reverted): truthiness instead of `=== true`; dropping
the `hasOwn` guard; removing the startup scan; `before` skipped for authenticated principals;
dropping the `anonymous` brand computation; the responder reverted to inline literals while the
error keeps the helper (parity must fail).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m110a-authorization-policies
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs
deno task publish:check     # committed tree
deno task release:verify 0.8.0
```

Plus a behavioral probe (`.verify-110a/driver.ts`, scratch, not committed) driving a real kernel app
with AuthPlugin + DecoratorPlugin + errorHandler: a target loaded by an extractor, owner allowed,
non-owner 403, anonymous 401, anonymous-ability 200, throwing policy 403 with one log line.

## 8. Risks & mitigations

- A policy check that hangs hangs the request → documented; the check is application code with its
  own backend bounds (M101a). Deadline deferred (§9).
- `before` returning `null` denies — surprising → stated in JSDoc, PUBLIC_API and the guide; tested.
- A function-valued target is always treated as an extractor → stated; a policy wanting a function
  target wraps it.
- Two copies of auth-plugin in one process: the guard brand uses `Symbol.for`, so a scan by one copy
  sees both copies' guards.
- `docs/authorization.md` fences drift → registered in the guide fence compiler.
- Policy identity is the NAME: a `requirePolicy` guard built from a policy object that was never
  registered, while a DIFFERENT policy with the same name is, evaluates the registered one and
  passes the startup scan. `define` refuses duplicate names, so this needs two distinct objects
  sharing a name with only one registered → documented in `requirePolicy`'s JSDoc; an identity
  comparison was rejected because the class form produces its definition at `register()`, so no
  application holds that object to compare against.

## 9. Out of scope

- Scoped grants, grant sources, scope resolvers — **M110b**.
- An ingress behaviour form and a principal source on `IngressContext` — proposed **M110c** (ROADMAP
  placeholder added by this PR).
- Policy decisions in M98h's authorization explanations — unowned; the M98h collector observes
  `RbacService` only, and widening its DTOs is a diagnostics-contract change.
- A per-check deadline — unowned; would be an option with no honest default.
- Deny-overrides / policy combination beyond all-of `@RequirePolicy` — 110b names deny rules
  deferred.

## 10. Design security review

> **Recorded after implementation**, on the M101a/M101b precedent: the security-relevant decisions
> were made in §3 at plan time (literal `true`, `Object.hasOwn`, fixed semantics, fail-closed
> `501`), but the review was not written down as its own section before the code. The rows below
> pair each threat with its resolution and the file that carries it, so the committed-tree audit can
> check each claim against the code.

**Reviewed flow.** A request reaches a `requirePolicy` guard or a `@RequirePolicy` middleware → the
middleware resolves `CAPABILITIES.AUTHORIZATION_POLICIES` (absent → `501`) → resolves the target
(value, or an extractor over the request) → `service.can(principal | null, name, ability, target)` →
the one `PolicyService` evaluator → allow (`next()`) or deny (`401`/`403` through the shared
responder). Imperatively, a handler calls `can` (boolean) or `authorize` (rejects with a
status-hinted `AuthorizationDeniedError`). At startup, AuthPlugin's `onBootstrap` scans route guards
and seals the registry.

**Assets.** The decision itself (a wrong allow is the whole failure); the target and principal (may
carry personal or business data); the policy and ability names (tell an attacker what to acquire).

**Attackers.** (A1) an unauthenticated network client; (A2) a signed-in principal reaching for
another principal's target; (A3) a client controlling a route parameter, header or body the
application feeds into an extractor or an imperative call; (A4) code in the same process — another
plugin — that can resolve the policy service.

**Budgets.** No new outbound I/O, no new listener, no new secret. One registry lookup and one
evaluation per check; a check is application code and is NOT time-bounded (§8, §9).

| #   | Threat                                                                                  | Resolution                                                                                                                                                                                                                                | Carried by                                                                            |
| --- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| T1  | (A3) an ability named `constructor`/`toString`/`__proto__` resolves an inherited member | Ability lookup is `Object.hasOwn` on the frozen copy; unknown → `UnknownPolicyError`; `describe` answers `undefined`                                                                                                                      | `policies/policy-service.ts` `#ability`                                               |
| T2  | A check returning a truthy non-boolean (`1`, `'yes'`, `{}`) allows                      | Allow only on `=== true`; `before` allows only on `=== true`, falls through only on `=== undefined`                                                                                                                                       | `policy-service.ts` `#evaluate`                                                       |
| T3  | A throwing or rejecting policy answers `200`, a raw `500`, or leaks through the body    | Caught, denied, reported once at `error` with policy, ability, hook and `serializeError` — never the target or principal; a throwing logger cannot change the outcome                                                                     | `policy-service.ts` `#evaluate`, `#report`                                            |
| T4  | (A1/A2) a refusal discloses which policy or ability failed                              | Bodies come from `authorizationFailureInit` (fixed title/detail); `AuthorizationDeniedError`'s message names them but is never served — the hint's detail is                                                                              | `common/errors/authorization-responder.ts`, `policies/errors.ts`                      |
| T5  | (A1) an anonymous request reaches a check written for a signed-in principal             | Denied `401` before the check runs unless the ability is declared anonymous; `before` is skipped for a `null` principal                                                                                                                   | `policy-service.ts` `#evaluate`                                                       |
| T6  | A guard naming an unregistered policy fails open                                        | Startup scan fails `start()`; per request an unknown name REJECTS (the handler does not run) — never a deny that a caller could mistake for a configured policy                                                                           | `policies/startup-scan.ts`, `policy-guard.ts`                                         |
| T7  | (A4) a second policy shadows a registered one under the same name                       | `define` refuses a duplicate name; the startup scan refuses a guard whose policy object disagrees with the registered one on `anonymous`                                                                                                  | `policy-service.ts` `define`, `startup-scan.ts`                                       |
| T8  | (A4) the policy set is mutated while serving                                            | `seal()` after the bootstrap scan; `define` then throws                                                                                                                                                                                   | `plugin/auth-plugin.ts` `onBootstrap`                                                 |
| T9  | A definition object whose getters answer differently after validation (TOCTOU)          | Every member is read once into a frozen copy at `define`; the evaluator never consults the caller's object                                                                                                                                | `policies/define-policy.ts`                                                           |
| T10 | No policy service registered → a guarded route is served                                | Guard and `@RequirePolicy` answer `501` per request; `@RequirePolicy`/`policies` refuse `register()` without a provider                                                                                                                   | `policy-guard.ts`, `decorator-plugin/plugin/policy-registration.ts`                   |
| T11 | An extractor failure (database outage) turns into an allow                              | Extractor errors propagate; the handler never runs                                                                                                                                                                                        | `policy-guard.ts`, `policy-registration.ts`                                           |
| T12 | The OpenAPI document marks a secured route public, or an anonymous one secured          | Brand computed from the guard's own object at construction (the startup scan proves it matches the registered ability for routes present at `start()`; see §10.3); `@Public` marker omitted beside a principal-requiring `@RequirePolicy` | `policy-guard.ts`, `policy-registration.ts`, `decorator-plugin.ts` `buildRouteSchema` |
| T13 | (A3) a user-controlled policy/ability string reaches an error message                   | Quoted through `JSON.stringify` (escapes control characters); a non-string is labelled `[<typeof>]` without conversion; the unknown-policy rejection is unbranded, so a masked `500`                                                      | `policy-service.ts` `refName`, `policies/errors.ts`                                   |
| T14 | A policy that never settles holds the request                                           | Accepted and documented: a check is application code with its own backend bounds (M101a); a deadline would be an option with no honest default                                                                                            | §8, §9                                                                                |

**Obligations on the committed-tree audit** (each a probe with a positive control, at a real kernel
application):

1. Drive T1 through `requirePolicy`, `@RequirePolicy`, `can` and `describe` with each inherited
   name.
2. Plant canaries in the target, in the principal's claims and in a thrown policy error; prove the
   target and principal canaries are absent from every response body and every log record, and the
   error canary is absent from every response body.
3. Prove the `401`/`403`/`501` bodies name no policy or ability under `'default'`, `'rfc9457'` and a
   thrown `authorize` through `errorHandler`.
4. Prove an anonymous request never invokes a non-anonymous check (call counter), and that `before`
   is not invoked for it.
5. Prove an unregistered guard fails `start()`; a route added after `start()` refuses (handler not
   run); `define` after `start()` throws; a duplicate name is refused.
6. Prove no provider → `501` for both entry points, with the handler not run.
7. Confirm each §6 negative control exists and fails when its guard is removed.

### 10.1 Committed-tree audit, round 1 — five findings, all fixed on this branch

Round 1 (fresh subagent, commit `cfd087ce`) held all seven obligations and failed on five findings
the T-table had not covered or had overstated. Each fix shipped with a test written first and
observed failing:

| Finding                                                                                                                                     | Fix                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 (Medium) — the target extractor ran before an anonymous refusal: a lookup per unauthenticated request, and a 401-vs-404 existence oracle | `requirePolicy` and `@RequirePolicy` refuse `401` for an anonymous request to a non-anonymous ability BEFORE extracting (the evaluator would deny it without calling the check anyway) |
| F2 (Low) — an `undefined` principal counted as signed in                                                                                    | `can`/`authorize` normalise `principal ?? null`; an anonymous check receives `null`                                                                                                    |
| F3 (Low) — T9 overstated: the anonymous arm's `check` getter was read twice; `authorize` re-read `policy.name`                              | `anonymousCheckOf` reads each member once and returns what it read; `authorize` reads the name once and passes it through                                                              |
| F4 (Low) — `@RequirePolicy` skipped T7's same-name refusal                                                                                  | `appendPolicyMiddleware` refuses a referenced class or definition that does not declare the ability with the registered `anonymous` flag                                               |
| F5 (Low) — T13 covered escaping but not length: an attacker-chosen name was copied unbounded into `UnknownPolicyError`                      | Names are truncated to 128 characters in the message and fields, with the removed length noted                                                                                         |

One pre-existing unit fixture referenced an ability through a definition that did not declare it —
the F4 case itself — and was corrected rather than left relying on the gap.

### 10.2 Committed-tree audit, round 2 — one finding, fixed on this branch

Round 2 (fresh subagent, commit `6ef94ff3`) closed F1–F5 and held all seven obligations, and failed
on **G1 (Low)**: the F1 refusal read `anonymous` from the guard's OWN policy object, which only the
startup scan proves agrees with the registered policy. A guard the scan never sees — a route added
after `start()`, a guard used as global middleware — built from a same-named object marking the
ability anonymous ran the extractor for anonymous callers (`[401, 404]`), and the docs stated the
guarantee unconditionally. Access stayed fail-closed throughout. **Fix:** the guard reads
`service.describe(name, ability)` on every request and refuses anonymous from the REGISTERED flag
(the way `@RequirePolicy` already did at `register()`); an unregistered ability rejects through
`can()` without running the extractor, and a replacement provider that describes nothing yet allows
is still refused. Four tests, each observed failing on the round-2 guard; the three doc sites now
state the per-request reading.

**Rename.** At the maintainer's direction the decorator `@Can` became `@RequirePolicy`, matching the
`requireXxx` guard names; nothing was published under the old name.

### 10.3 Committed-tree audit, round 3 — one documentation finding, fixed on this branch

Round 3 (fresh subagent, commit `57c7dffe`) closed G1 with no regression and failed on **G2 (Low)**:
the `requirePolicy` OpenAPI brand is fixed at construction from the guard's own object, while T12
and two doc sites claimed it follows the registered ability. On a route added after `start()` from a
mismatched same-named object, the document disagreed with enforcement; access was unaffected. The
service is not available when a guard is built, so the fix is scoping: T12 and both doc sites now
say the brand describes the guard's object, which the startup scan proves matches for routes present
at `start()`. The round's observation O1 — a replacement provider reporting a truthy non-boolean
`anonymous` skipped the early refusal — is hardened to `=== true` with a test observed failing
first.
