# Milestone 110b — Scoped RBAC (`@setu-ts/common` + `@setu-ts/auth-plugin` + `@setu-ts/decorator-plugin` + `@setu-ts/database-plugin`)

> **Status:** Planning. Branch: `feat/m110b-scoped-rbac`. `develop` and `main` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR against
> `develop`.

## 0. Objective & scope

A role granted IN a scope — a tenant, an organisation, a team, a project, a region — rather than
everywhere, evaluated as ONE built-in policy on M110a's evaluator, and configurable enough that the
five ROADMAP reference scenarios need configuration only. Today a role is global: `RbacConfig` is
one static `roles` map (`common/src/services/auth.ts:98`) and `hasPermission(principal, permission)`
has no scope parameter, so "may approve invoices in tenant X" can only be faked by packing
tenant-prefixed strings into `principal.permissions`. The existing global path —
`IAuthorizationService`, the six guards, `@Roles`/`@Permissions` — stays byte-for-byte unchanged.

**Maintainer decisions (2026-10-10):** the whole ROADMAP section ships in this one milestone (all
three resolution-timing modes, scenarios A–E — no `110b2` letter); scenario E (per-tenant custom
roles) is INCLUDED rather than deferred; the scoped guards and decorators get NEW names
(`requireScopedRole`/`requireScopedPermission`, `@ScopedRoles`/`@ScopedPermissions`) so the six
existing guards and `@Roles`/`@Permissions` keep their single evaluator and their `501` conditions.

- **In scope:** the grant model and its `common` port (`ScopeRef`, `ScopedGrant`, `IGrantSource`,
  `IScopedRoleSource`, the reserved policy name and ability encoders, the `scopeFromTenant` /
  `scopeFromParam` scope sources); in `auth-plugin` the built-in `scoped-rbac` policy and its
  evaluator, `AuthPluginOptions.scopedRbac` (grant sources, scope hierarchy/delegation, per-role
  scope-type limits, custom-role sources, resolution timing), the two scoped guards, and the
  sign-in-time grant resolution; in `decorator-plugin` `@ScopedRoles`/`@ScopedPermissions`; in
  `database-plugin` `createDatabaseGrantSource()` and `createDatabaseRoleSource()`; scenarios A–E as
  integration tests with negative controls; a real-PostgreSQL and a real-MongoDB grant-source suite;
  `PUBLIC_API.md`, both READMEs, `docs/authorization.md` (scoped-RBAC section, fence-gated),
  `ARCHITECTURE.md` §14, `CHANGELOG.md`.
- **NOT this milestone:** deny rules / deny-overrides (ROADMAP fixes them out — §9); an ingress
  principal source (proposed **M110c**); scoped decisions in M98h's authorization explanations
  (named, unowned — §3.17); scoped forms of `requireAnyRole`/`requireAllPermissions` as separate
  names (folded into the two guards' array arms, §3.10).

## 1. Contracts verified from SOURCE (not names)

| Reference                                           | Source (file:line)                                                                                                                      | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RoleDefinition` / `RbacConfig`                     | `packages/common/src/services/auth.ts:86,98`                                                                                            | `{ permissions?; inherits? }` and `{ roles: Record<string, RoleDefinition> }`. The catalogue this milestone reuses; NOT widened (§3.8).                                                                                                                                                                                                                                                                                                                                              |
| `IPrincipal`                                        | `packages/common/src/services/auth.ts:16`                                                                                               | `{ id; roles?; permissions?; claims? }`. `roles`/`permissions` become the GLOBAL grants (scope `null`) of the scoped evaluator.                                                                                                                                                                                                                                                                                                                                                      |
| `IAuthorizationService` / `RbacService`             | `packages/common/src/services/auth.ts:152`; `packages/auth-plugin/src/services/rbac-service.ts`                                         | Synchronous; closure cache built at construction (`computeClosure`, per-role `seen` set). `roleExists` uses the `in` operator (prototype names resolve) — the scoped evaluator uses `Object.hasOwn` instead (§3.8); `RbacService` itself is untouched.                                                                                                                                                                                                                               |
| `PolicyDefinition` / `PolicyTarget` / service       | `packages/common/src/services/authorization-policies.ts:93,145,185`                                                                     | A policy is a fixed record of abilities, each `(principal, target) => boolean \| Promise<boolean>`; `before` optional. One evaluator; unknown policy/ability REJECTS; literal-`true` allow; throw → deny + one log. `define` refused once sealed.                                                                                                                                                                                                                                    |
| `validatePolicyDefinition`                          | `packages/auth-plugin/src/policies/define-policy.ts:15,63`                                                                              | Ability key `before` reserved; any other non-empty string is a legal ability name (so `perm:invoices.approve` is legal).                                                                                                                                                                                                                                                                                                                                                             |
| `PolicyService`                                     | `packages/auth-plugin/src/policies/policy-service.ts`                                                                                   | `#ability` looks abilities up with `Object.hasOwn` on a frozen copy; `#report` logs `{ policy, ability, stage, error }` — never target, never principal.                                                                                                                                                                                                                                                                                                                             |
| `requirePolicy` / startup scan                      | `packages/auth-plugin/src/policies/policy-guard.ts:113`; `startup-scan.ts:32`                                                           | `requirePolicy` takes the policy OBJECT and checks `Object.hasOwn(abilities, ability)` when the guard is BUILT — so it cannot be called before AuthPlugin's `register()` defines the built-in policy. The brand is ONE frozen, non-configurable property holding a single `{ policy, ability, anonymous }`; `policyGuardOf`/`scanPolicyGuards` read one ability per middleware, and the scan's only refusal message names `AuthPlugin({ policies })`. Both files change here (§3.9). |
| `createPolicyMiddleware` / `appendPolicyMiddleware` | `packages/decorator-plugin/src/plugin/policy-registration.ts:180,230`                                                                   | Decorator-side middleware over the public contract: `501` with no provider, `401` before the extractor for a non-anonymous ability, `can()` per request; validated at `register()` via `describe`.                                                                                                                                                                                                                                                                                   |
| DecoratorPlugin chain order                         | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:712,987,993`                                                                  | guards → `appendAuthorizationMiddleware` (`@Roles`/`@Permissions`) → `appendPolicyMiddleware` (`@RequirePolicy`) → interceptors/middleware/filters → validation.                                                                                                                                                                                                                                                                                                                     |
| `IRequest.tenant`                                   | `packages/common/src/http.ts:66`; `services/tenancy.ts:14`                                                                              | `ITenant { id; name?; metadata? }`, written by `tenantMiddleware` at priority 40 — before any route guard runs.                                                                                                                                                                                                                                                                                                                                                                      |
| `IRequestContext.params`                            | `packages/common/src/http.ts:325`                                                                                                       | `Readonly<Record<string, string>>` — what `scopeFromParam` reads.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `withDeadline`                                      | `packages/common/src/health/deadline.ts:118`                                                                                            | Bounds a call and aborts its signal; `timeoutMs: 0` DISABLES the bound — so a source timeout of `0` must be refused (§3.13), not passed through.                                                                                                                                                                                                                                                                                                                                     |
| `FilterExpression` / `FilterOperator`               | `packages/common/src/services/database.ts:76,110`                                                                                       | `eq`/`in` plus `and`/`or`; `eq` against `null` is a supported arm on every adapter (M68 conformance). Enough for "subject = X and (scope in chain or scope is null)".                                                                                                                                                                                                                                                                                                                |
| `RegistryFactory`                                   | `packages/common/src/registry.ts:66`                                                                                                    | `(services: IServiceRegistry) => T` — the M101c bridge shape, resolved at `onInit`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `createDatabaseTenantDataStore` precedent           | `packages/database-plugin/src/tenancy/database-tenant-data-store.ts`                                                                    | Port in `common`, bridge in `database-plugin` as a `RegistryFactory`, equality-only filters, refuses `$`-prefixed keys and non-scalar values (MongoDB operator injection).                                                                                                                                                                                                                                                                                                           |
| `AuthSessionService.signIn`                         | `packages/auth-plugin/src/sign-in/auth-session-service.ts:211,27`                                                                       | Async; records the principal under `__setu_auth_principal`, or a PENDING record when MFA is required. OIDC (`sign-in/routes.ts:483`), SAML (`saml/routes.ts:515`), username-less passkeys (`passkeys/ceremonies.ts:987`) and application password sign-in call it. It is NOT the only writer — see `promotePending` below.                                                                                                                                                           |
| `AuthSessionService.promotePending`                 | `packages/auth-plugin/src/sign-in/auth-session-service.ts:330,343`; callers `mfa/totp-service.ts:509,545`, `passkeys/ceremonies.ts:971` | SYNCHRONOUS (`'signed-in' \| 'no-pending'`); writes `__setu_auth_principal` directly when a second factor completes. No async work can run inside it, so sign-in-time grants must be resolved in `signIn` and carried with the pending record (§3.12).                                                                                                                                                                                                                               |
| `IRepository.findAll` / `IDataSource.findAll`       | `packages/common/src/services/database.ts:212`                                                                                          | `findAll(query: NormalizedQuery)` — no `AbortSignal` parameter. A `withDeadline` expiry ABANDONS a repository query; the database keeps running it (§3.16, §8).                                                                                                                                                                                                                                                                                                                      |
| `IRequestContext.state`                             | `packages/common/src/http.ts:329`                                                                                                       | `Map<string, unknown>`, one per request — a valid `WeakMap` key for the per-request memo (§3.12).                                                                                                                                                                                                                                                                                                                                                                                    |
| CI real databases                                   | `.github/workflows/ci.yml:110,111,116,127`                                                                                              | PostgreSQL 16 behind `OUTBOX_POSTGRES_URL` (port 5433) and MongoDB behind `MONGODB_URI`; both pinned by `test/apps-gate.test.ts`.                                                                                                                                                                                                                                                                                                                                                    |
| Name collisions                                     | `grep -rnE "Scoped(Roles\|Permissions\|Grant\|RbacOptions)\|IGrantSource\|scopeFrom(Tenant\|Param)\|requireScoped" packages/*/src`      | Empty — none of the new names exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                          | Resolution (picked side)                                                                                                                                                                                                                                                                        | Doc deliverable (same PR)                                       |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| C1 | ROADMAP: "a permission absent from the catalogue denies … the catalogue check also catches a typo". A request-time deny cannot tell a typo from an unheld permission.             | The catalogue check runs at STARTUP for every route guard (§3.9: each permission is an ability of the built-in policy, so M110a's scan refuses a typo). The imperative path still denies an unknown permission per request — by REJECTING (M110a's unknown-ability rule), not by a silent deny. | ROADMAP 110b "Fixed" bullet reworded to "refused at startup".   |
| C2 | ROADMAP axis 4 lists "a parent scope's grants descend" and "relationship-based delegation via a resolver" as two mechanisms.                                                      | One mechanism: an `inheritsFrom(scope)` resolver returning the scopes whose grants apply (parents and delegators), walked transitively with cycle refusal and depth/node bounds (§3.5). A parent is one hop of it; a delegation is another.                                                     | ROADMAP 110b axis 4 bullet updated.                             |
| C3 | ROADMAP axis 6 "computed at sign-in into the principal". Writing grants into `principal.claims` makes a federated token carrying the same claim name indistinguishable from them. | Grants resolved at sign-in are stored in the auth session under a PRIVATE session key beside the principal record, never in `claims` (§3.12).                                                                                                                                                   | ROADMAP 110b axis 6 bullet updated; PUBLIC_API states the rule. |
| C4 | ROADMAP scenario E is "per-tenant custom roles (or its named deferral)"; axis 5 says custom roles are "a stretch the plan accepts or defers by name".                             | Accepted (maintainer, 2026-10-10). A custom role bundles CATALOGUE permissions only and is checked through permissions; a guard naming a custom role is refused at startup (§3.11).                                                                                                             | ROADMAP 110b scenario E + axis 5 bullets updated.               |
| C5 | ARCHITECTURE §14 "Authorization" describes roles as global.                                                                                                                       | Extended, not contradicted.                                                                                                                                                                                                                                                                     | ARCHITECTURE §14 gains a "Scoped roles" subsection.             |

## 3. Design decisions

### 3.1 Built on M110a: one built-in policy, no new capability

- **Decision:** when `AuthPluginOptions.scopedRbac` is set, AuthPlugin `define`s ONE built-in policy
  in `register()`, named by the reserved constant `SCOPED_RBAC_POLICY = 'scoped-rbac'` (exported
  from `common`, because `decorator-plugin` must name it without importing `auth-plugin`). Its
  abilities are generated from the catalogue: `perm:<permission>` for every permission named by any
  `rbac.roles` entry or listed in `scopedRbac.permissions`, and `role:<role>` for every `rbac.roles`
  key. The wildcard `'*'` is NOT turned into an ability: it is a grant-side shorthand ("every
  permission"), and `requireScopedPermission('*')` naming it as a requirement is refused at startup
  like any other unknown ability. The two encoders are pure functions in `common`:
  `scopedPermissionAbility(p)` and `scopedRoleAbility(r)`. No new capability token: guards,
  decorators and imperative checks reach it through `CAPABILITIES.AUTHORIZATION_POLICIES`.
- **Why:** the ROADMAP's "one evaluator for the guard, the decorator and the yes/no check" is
  M110a's evaluator; the startup scan, sealing, `401`-before-extractor and refusal bodies come for
  free. The prefixes keep a permission named `before` (the one reserved ability key) legal and keep
  roles and permissions in separate namespaces.
- **Test home:** `auth-plugin/test/unit/scoped/scoped-policy.test.ts` (ability generation; `before`
  as a permission name; prefix collision impossible).

### 3.2 Configuration refusals at construction

- **Decision:** `AuthPlugin(...)` refuses, with `AuthPluginConfigurationError`: `scopedRbac` without
  `rbac` (no catalogue); any `policies` entry named `scoped-rbac` (reserved — refused whether or not
  `scopedRbac` is set, so a later enabling cannot silently shadow it); `scopedRbac.sources` empty;
  each bound in §3.13 out of range (including `NaN`, the M90a lesson); `timing: 'sign-in'` without
  `signIn` configured; a `grantableIn` key naming a role absent from the catalogue; a scope-type
  string not matching `^[a-z][a-z0-9-]*$`; a `grantableIn` entry with an empty `scopeTypes` and no
  `global: true` (a role grantable nowhere is a configuration mistake, not a policy).
- **Why:** the package's convention — every misconfiguration refuses before an application exists.
- **Test home:** `auth-plugin/test/unit/scoped/scoped-options.test.ts` (one row per refusal).

### 3.3 The grant model (`common`)

- **Decision:**

  ```ts
  interface ScopeRef {
    readonly type: string;
    readonly id: string;
  }
  interface ScopedGrant {
    readonly role: string;
    readonly scope: ScopeRef | null; // null = global
  }
  type GrantQuery =
    | { readonly kind: 'chain'; readonly scopes: readonly ScopeRef[] }
    | { readonly kind: 'all' };
  interface IGrantSource {
    readonly name: string;
    grantsFor(
      principal: IPrincipal,
      query: GrantQuery,
      signal: AbortSignal,
    ): Promise<readonly ScopedGrant[]>;
  }
  ```

  A `ScopeRef` is valid when `type` matches the scope-type grammar and `id` is a non-empty string of
  at most 256 UTF-16 units. Every value a source returns is VALIDATED and COPIED (read once, the
  M110a T9 rule); an invalid grant is dropped and counted, never coerced. A `chain` query asks for
  grants whose scope is one of `scopes`, plus every global grant; `all` asks for every grant the
  principal holds (used only by sign-in timing, §3.12).
- **Why:** the assignment carries the scope (Casbin), `null` is global (spatie); the `chain`/`all`
  split lets one source serve both the per-request and the sign-in timing.
- **Test home:** `common/test/unit/scoped-grants.test.ts` (validator rows: grammar, length,
  non-string, getter-read-once).

### 3.4 Where a check's scope comes from

- **Decision:** a scoped check's target is a
  `ScopedRbacTarget = { readonly scope: ScopeRef | null;
  readonly context?: IRequestContext }`.
  Guards and decorators take a `ScopeSource`:
  `ScopeRef | null | ((ctx) => ScopeRef | null | undefined | Promise<…>)`, defaulting to
  `scopeFromTenant()`. `common` exports `scopeFromTenant(type = 'tenant')` (reads
  `ctx.request.tenant?.id`) and `scopeFromParam(param, type)` (reads `ctx.params[param]`). The
  guard/decorator wraps the resolved scope with `context: ctx`; an imperative caller passes
  `{ scope, context: ctx }` (or `{ scope }` without a memo). A source answering `undefined` — no
  tenant resolved, a missing parameter — is UNRESOLVED and denies (§3.14); `null` explicitly means
  "global grants only". A source never means "any scope".
- **Why:** the ROADMAP's four origins (request tenant, route parameter, a handler-loaded value, an
  explicit argument) are the four arms; the `context` member is what makes the per-request memo and
  the tenant-consistency check possible without trusting a caller-built memo (§3.6, §3.7).
- **Test home:** `common/test/unit/scope-sources.test.ts`; `scoped-guards.test.ts`.

### 3.5 Scope hierarchy and delegation — one resolver

- **Decision:** `scopedRbac.inheritsFrom?: (scope, signal) => readonly ScopeRef[] | Promise<…>`
  returns the scopes whose grants ALSO apply in `scope` (its parent, a delegating tenant). The
  evaluator walks it breadth-first from the check's scope, deduplicating by `type\0id`; a scope
  reached again ON ITS OWN PATH is a cycle → the whole check denies and logs
  `{ reason: 'scope-cycle', scopeType }`; a diamond (reached by two paths) is deduplicated, not a
  cycle. Bounds: `maxScopeDepth` (default 8) and `maxScopeNodes` (default 32); exceeding one of them
  denies (fail closed). Each call is bounded by `sourceTimeoutMs` (§3.13). Absent → flat: the chain
  is the check's scope alone. Several independent scope TYPES coexist with no configuration: a check
  names one scope; the resolver may cross types (team → organisation).
- **Why:** C2. A transitive walk with cycle refusal is the one mechanism both parents and delegation
  need.
- **Test home:** `auth-plugin/test/unit/scoped/scope-chain.test.ts` (flat, three-level, diamond,
  cycle, depth and node bounds, resolver throw, resolver timeout, invalid ref dropped).

### 3.6 Tenant consistency

- **Decision:** when the target carries `context`, the request has a resolved tenant, and the
  check's OWN scope has type `scopedRbac.tenantScopeType` (default `'tenant'`) with an id different
  from `context.request.tenant.id`, the check denies and logs `{ reason: 'tenant-mismatch' }` (no
  ids). Scopes reached through `inheritsFrom` are NOT compared: they are reached from the check's
  own scope, so once that scope is the request tenant, a parent tenant reached from it (scenario A)
  is attributable to the request by construction. With no tenant resolved, the scope source is
  honoured as given. **Scenario A semantics (maintainer, 2026-10-10):** a request resolved to a
  CHILD tenant inherits grants held in its parent; a parent-tenant administrator acting on a child
  through a route parameter while resolved to the parent is refused by this rule, by design. Only
  the tenant scope TYPE is compared: whether an organisation or project id belongs to the request
  tenant is the application's responsibility (an `inheritsFrom` that ends at the tenant is the
  documented way to make that relation visible), stated in the guide.
- **Why:** the ROADMAP security item "a route-parameter scope that disagrees with the resolved
  request tenant" — `scopeFromParam('tenantId', 'tenant')` on a request resolved to another tenant
  must not evaluate the attacker-chosen tenant's grants.
- **Test home:** `auth-plugin/test/integration/scoped-tenant-consistency.test.ts` (param scope ≠
  request tenant → 403; equal → allowed; no tenant resolved → param honoured; inherited parent of
  the request tenant → allowed).

### 3.7 Grant sources and their union

- **Decision:** `scopedRbac.sources: readonly GrantSourceConfig[]`, a union discriminated on `kind`:
  `{ kind: 'static'; grants: readonly { subject: string; role: string; scope: ScopeRef | null }[] }`
  (validated and indexed by subject at construction);
  `{ kind: 'claims'; map: (claims, principal) =>
  readonly ScopedGrant[] }` (the
  Keycloak-Organizations shape — no store);
  `{ kind: 'custom';
  source: IGrantSource | RegistryFactory<IGrantSource> }` (a factory is
  resolved at `onInit`, the M101c precedent — which is how `createDatabaseGrantSource()` plugs in).
  The principal's own `roles` are always included as GLOBAL grants (`principal.permissions` is
  honoured as global directly-held permissions). Grants from all sources are UNIONED; one source
  rejecting or timing out denies the WHOLE check. A partial union cannot over-grant (there are no
  deny rules), but it would make a broken source look like a principal with fewer rights, hiding the
  outage; denying and logging the source makes it visible.
- **Why:** axis 3 verbatim; union because grants are additive and there are no deny rules.
- **Test home:** `auth-plugin/test/unit/scoped/grant-sources.test.ts`.

### 3.8 Evaluation

- **Decision:** the `perm:<p>` ability allows iff some grant in the chain (or global) names a role
  whose resolved permission closure contains `p` or `'*'`, and also when `principal.permissions`
  contains `p` or `'*'`; the `role:<r>` ability allows iff some grant in the chain names `r` or a
  role whose closure inherits `r`. Closures are computed once at construction from `rbac.roles` with
  `Object.hasOwn` lookups (a grant naming `constructor` resolves nothing). A grant of a role absent
  from the catalogue (and from the grant scope's custom roles, §3.11) grants nothing and is counted.
  Per role scope-type limits:
  `scopedRbac.grantableIn?: Record<role, { readonly scopeTypes: readonly
  string[]; readonly global?: boolean }>`
  — a grant of a limited role in a scope whose type is not in `scopeTypes` is IGNORED (counted,
  never an error), and a limited role held GLOBALLY (a `null`-scope grant, or `principal.roles`)
  counts only when `global: true`. A separate boolean rather than a sentinel string, because every
  sentinel (`'global'`) is also a legal scope type. An unlimited role is valid in every scope and
  globally, as today.
- **Why:** the global evaluator's semantics, reapplied per scope chain; ignoring rather than failing
  on a misplaced grant keeps one bad row from denying every other right.
- **Test home:** `scoped-policy.test.ts` (closure, wildcard, inheritance, prototype names,
  `grantableIn`).

### 3.9 Startup refusal of unknown permissions and roles

- **Decision:** the scoped guards are NOT built through `requirePolicy` (§1: it needs the policy
  object at build time, and AuthPlugin defines the built-in policy later, at `register()`). Instead
  the internal policy-guard brand widens from `{ policy, ability, anonymous }` to
  `{ policy, abilities: readonly string[], anonymous }`; `requirePolicy` writes a one-element list,
  the scoped guards write every ability they name. `policyGuardOf` and `scanPolicyGuards` iterate
  the list, so the M110a scan refuses an unknown permission or role on every route present at
  `start()`. The scan special-cases `SCOPED_RBAC_POLICY`: when no policy of that name is registered
  it reports that the route uses a scoped guard and `AuthPlugin({ scopedRbac })` is not configured,
  rather than the generic `AuthPlugin({ policies })` advice. The brand stays internal (not
  barrel-exported), so the widening breaks nothing. `@ScopedRoles`/`@ScopedPermissions` are
  validated at `register()` through `describe`, with the same `scopedRbac` wording.
- **Why:** C1; a typo is a configuration error, not a 403. Widening the existing brand keeps ONE
  scan rather than adding a second classifier.
- **Test home:** `auth-plugin/test/integration/scoped-startup-scan.test.ts`;
  `auth-plugin/test/unit/policies/startup-scan.test.ts` (extended: a multi-ability brand with one
  unknown entry is refused; a one-element brand behaves exactly as before);
  `auth-plugin/test/unit/policies/require-policy.test.ts` (extended: the brand is a one-element
  list).

### 3.10 Guards

- **Decision:**
  `requireScopedRole(role: string | readonly string[], options?: { scope?:
  ScopeSource })` — an
  array is ANY-of; `requireScopedPermission(permission: string | readonly
  string[], options?)` —
  an array is ALL-of (mirroring `requireAnyRole`/`requireAllPermissions`). An array of length 0 is
  refused at construction. Each is ONE middleware, built in `scoped/scoped-guards.ts` without
  `requirePolicy`, that resolves the scope once and calls `service.can` per entry (short-circuiting
  in order). Per request it mirrors `requirePolicy`'s order: `501` with no policy provider;
  `describe` each ability on the REGISTERED policy (an unregistered one rejects through `can`, the
  M110a G1 rule — never decided from the guard's own arguments); `401` for an anonymous request
  BEFORE the scope source runs; `403` on deny. It carries the widened brand listing every ability
  (§3.9) and `{ authenticated: true }` for M57.
- **Why:** maintainer decision (new names); one scope resolution per route, not per entry.
- **Test home:** `auth-plugin/test/unit/scoped/scoped-guards.test.ts` (501/401/403/allow, any-of and
  all-of short-circuit, scope source throw propagates, handler never runs on refusal).

### 3.11 Per-scope custom roles (scenario E)

- **Decision:** `scopedRbac.customRoles?: IScopedRoleSource | RegistryFactory<IScopedRoleSource>`
  where `IScopedRoleSource.rolesFor(scopes: readonly ScopeRef[], signal)` returns, in ONE call, the
  roles DEFINED in each requested scope:
  `Promise<readonly { scope: ScopeRef; role: string; permissions: readonly string[] }[]>`. The
  evaluator asks only for the scopes that carry a grant naming a non-catalogue role, so a check
  whose grants are all catalogue roles makes no custom-role call. **Resolution rule:** a grant's
  role resolves against the custom roles defined in the GRANT'S OWN scope, never another scope's.
  Inheritance therefore comes from the grant descending through `inheritsFrom` (a grant made on an
  organisation applies on its teams), and two scopes in one chain defining the same role name can
  never collide, because each grant names exactly one defining scope. Rules: a custom name equal to
  a catalogue role is ignored (counted — it cannot shadow); a custom role's permission absent from
  the permission catalogue is dropped (counted); custom roles neither inherit nor are inherited; at
  most `maxCustomRoles` (default 128) per scope and `maxPermissionsPerRole` (default 256) per role,
  exceeding one of them denies the check. Custom roles are checked through PERMISSIONS:
  `requireScopedRole` names catalogue roles only, because a guard naming a tenant-defined role
  cannot be validated at startup.
- **Why:** C4. Keeping the permission catalogue static keeps the startup typo check total; resolving
  against the grant's own scope removes the ancestry relation a breadth-first walk does not produce,
  and the batched call bounds the cost at one deadlined call per check.
- **Test home:** `auth-plugin/test/unit/scoped/custom-roles.test.ts`; scenario E integration.

### 3.12 Resolution timing

- **Decision:** `scopedRbac.timing: 'request' | { kind: 'cache'; ttlMs; maxEntries } | 'sign-in'`,
  default `'request'`.
  - `'request'`: grants and custom roles are memoised per request in a module-private
    `WeakMap<Map<string, unknown>, …>` keyed by the target's `context.state` object (one Map per
    request), so they are never shared across requests and a caller cannot inject a memo. A FAILED
    resolution is memoised for the rest of that request too, so an ALL-of guard over two permissions
    calls a failing source once and logs once; it is never carried into another request. Without
    `context`, nothing is memoised. **Revocation latency: the next request.**
  - `cache`: an LRU (`maxEntries`, 1–100 000) keyed by `JSON.stringify([principalKey, query])` where
    `principalKey = JSON.stringify([principal.id, typeof claims.iss === 'string' ? claims.iss
    : null])`
    — so the same `sub` from two issuers never shares an entry. Entries expire after `ttlMs` (1
    000–3 600 000) on the MONOTONIC clock (`runtime.hrtime()`); a failed resolution is never cached.
    **Revocation latency: up to `ttlMs`.**
  - `'sign-in'`: `AuthSessionService.signIn` resolves the principal's `all` grants (and nothing
    else) after the principal is accepted, bounded by `maxGrantsPerPrincipal`, for BOTH of its
    outcomes. Signed in directly, it stores them under the private session key
    `__setu_auth_scoped_grants` beside `__setu_auth_principal`. When a second factor is required, it
    stores them INSIDE the pending record (§1: `promotePending` is synchronous and cannot resolve
    anything itself), and `promotePending` moves them to `__setu_auth_scoped_grants` in the same
    synchronous write that records the principal — so TOTP completion, recovery codes and passkey
    step-up all arrive with the grants resolved at the first factor. A regenerate, sign-out or
    expired pending record clears them with the principal. At check time ONLY that stored list is
    read, filtered to the chain. A principal not signed in through the auth session (a bearer JWT)
    has its global roles only. A resolution failure at sign-in FAILS the sign-in: `signIn` rejects
    with a new `GrantResolutionError`, status-hinted `503` (an outage, not a refusal of the user —
    so it is deliberately not an `AuthorizationDeniedError`), whose message carries the fixed reason
    and source name only, reported once, and records nothing. **Revocation latency: until sign-out
    or session expiry.** Custom roles are still resolved per request in this mode.
- **Why:** axis 6, with C3's private storage. Each mode states its latency where an operator reads
  it.
- **Test home:** `auth-plugin/test/unit/scoped/grant-cache.test.ts`;
  `auth-plugin/test/integration/scoped-sign-in.test.ts`.

### 3.13 Bounds

- **Decision:** `sourceTimeoutMs` (default 2 000; 1–60 000 — `0` refused, §1 `withDeadline`) bounds
  every source, custom-role and `inheritsFrom` call through `withDeadline` with the runtime's timer
  surface; `maxGrantsPerPrincipal` (default 256; 1–10 000) bounds one resolution's union — exceeding
  it DENIES the check rather than truncating, because a truncation under-grants arbitrarily (which
  grants survive depends on source order) while a deny is deterministic and logged; `maxScopeDepth`,
  `maxScopeNodes`, `maxCustomRoles`, `maxPermissionsPerRole` as above. Identical resolutions in
  flight at the same time are COALESCED onto one call (keyed like the cache: principal key plus
  query), in every timing mode, because a timed-out repository query is abandoned but keeps running
  (§1, §3.16) — coalescing is what stops a slow database from receiving one more copy of the same
  query per concurrent request. Coalescing shares an in-flight call only between callers asking the
  identical question for the identical principal, so it can never move a grant between principals.
- **Why:** ROADMAP "Bounded". Every bound refuses an out-of-range value at construction.
- **Test home:** `scoped-options.test.ts`; `scope-chain.test.ts`; `grant-sources.test.ts`.

### 3.14 Fail closed — the complete deny list

- **Decision:** the check DENIES (never allows, never `500`s for a request-path cause) when: the
  scope is unresolved (`undefined`); a scope ref is invalid; a grant source or the custom-role
  source rejects, throws or exceeds `sourceTimeoutMs`; `inheritsFrom` rejects, throws, times out,
  cycles or exceeds a bound; any bound is exceeded; tenant consistency fails. **The built-in check
  never throws**: every failure is caught inside it and answered `false`. That is load-bearing, not
  tidiness — a throwing check reaches `PolicyService.#report`, which logs `serializeError(error)` in
  full, and a database error message can quote its bound parameters (M108 measured Drizzle doing
  exactly that), which here are subject and scope ids. The check logs through its OWN logger thunk,
  captured from `IPluginContext` at `register()` and read at call time (the M52b lesson), with
  `{ policy: 'scoped-rbac', reason, scopeType?, source?, errorName? }` — the reason from a fixed
  vocabulary, `errorName` being the thrown value's `name` only, never its message; never a scope id,
  never a principal id. A throwing logger cannot change the outcome (the M109a `safeLog` precedent).
  The runtime's monotonic clock and timer surface for `withDeadline` and the cache are captured from
  the same context. An unknown ability still REJECTS (M110a).
- **Why:** ROADMAP "Fail closed" plus the security item "scope identifiers reaching logs".
- **Test home:** `auth-plugin/test/unit/scoped/fail-closed.test.ts` (one row per entry, each with a
  canary scope id and principal id asserted absent from every log record).

### 3.15 Decorators

- **Decision:** `@ScopedRoles(roles: readonly string[], scope?: ScopeSource)` (ANY-of) and
  `@ScopedPermissions(permissions: readonly string[], scope?: ScopeSource)` (ALL-of), on class and
  method like `@Roles`/`@Permissions`; method overrides class. They record a scoped requirement that
  a NEW builder, `appendScopedRbacMiddleware` in `plugin/policy-registration.ts`, turns into ONE
  middleware per decorator: it resolves the scope once and evaluates every ability in it, ANY-of for
  `@ScopedRoles` and ALL-of for `@ScopedPermissions`. `appendPolicyMiddleware` cannot be reused: it
  emits one middleware per requirement, and separate middlewares compose as ALL-of, so ANY-of is
  inexpressible through it. The new builder shares `createPolicyMiddleware`'s refusal order and
  responder calls (`501`, `401` before the scope source, `403`), sits in the same band as
  `@RequirePolicy` (after `@Roles`/`@Permissions`, before interceptors), and is validated at
  `register()` via `describe` on each ability (unknown → throw naming route and name; no policy
  registered → throw naming `AuthPlugin({ scopedRbac })`). `buildRouteSchema` omits `@Public`'s
  marker beside them.
- **Why:** maintainer decision (new names); one scope resolution per decorator, and the parity test
  (§6) proves the guard and the decorator answer byte-identical bodies.
- **Test home:** `decorator-plugin/test/unit/scoped-decorators.test.ts`,
  `decorator-plugin/test/integration/scoped-rbac-e2e.test.ts`.

### 3.16 Repository sources (`database-plugin`)

- **Decision:** `createDatabaseGrantSource({ entity, fields? })` → `RegistryFactory<IGrantSource>`
  over `CAPABILITIES.DATABASE`'s repository for `entity`, reading rows
  `{ subject, role, scopeType,
  scopeId }` (field names overridable). A `chain` query is ONE
  `findAll` with filter
  `and(eq(subject), or(and(eq(scopeType, null), eq(scopeId, null)), …one and() per chain scope))`
  and `limit: maxGrantsPerPrincipal + 1` (the source refuses rather than truncates); `all` drops the
  scope clause. `createDatabaseRoleSource({ entity, fields? })` reads
  `{ scopeType, scopeId, role,
  permission }` rows (one per permission) and groups them. Both pass
  only scalar strings into `where`/`filter` (the M101c operator-injection rule). The signal they
  receive is checked before the query is issued, but `IRepository.findAll` takes no signal (§1), so
  a query already running is ABANDONED on expiry rather than cancelled — the deny is immediate, the
  database work is not. That is stated in both factories' JSDoc and the guide, and §3.13's
  coalescing is the bound on how many abandoned copies one hot principal can create. Adapter
  refusals (`UnsupportedFilterOperatorError`) surface as a source failure → deny.
- **Why:** ROADMAP deliverable "a repository grant source driven against a real database in CI"; the
  M101c bridge shape.
- **Test home:** `database-plugin/test/unit/grant-source.test.ts` (memory adapter: chain, global,
  all, limit refusal, injection refusal);
  `database-plugin/test/integration/grant-source-real.test.ts` (guarded on `OUTBOX_POSTGRES_URL` via
  Drizzle and `MONGODB_URI`; `ignore:` guards, never an early return — the M70c trap).

### 3.17 M98h explanations

- **Decision:** scoped decisions are NOT observed by M98h (its collector is attached to
  `RbacService`, and policy decisions have never been observed — M110a §9). Recorded as named and
  unowned; no scope identifier reaches the diagnostics connector because no observation is made.
- **Why:** the ROADMAP security item is satisfied by absence; widening M98h's DTOs is a
  diagnostics-contract change.
- **Test home:** `scoped-policy.test.ts` (an attached M98h collector records nothing for a scoped
  check).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — new types, a reserved constant, pure helpers, new options and
new exports; no existing interface gains a member, and `RoleDefinition`/`RbacConfig` are unchanged.

| Exported symbol                                                             | Kind       | Consumer / real code path that READS it                                                                                         |
| --------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ScopeRef`, `ScopedGrant`, `GrantQuery` (common)                            | types      | `IGrantSource`; the auth-plugin evaluator; database-plugin bridges                                                              |
| `IGrantSource`, `IScopedRoleSource` (common)                                | interfaces | auth-plugin source union + custom-role option; database-plugin bridges implement them                                           |
| `ScopedRbacTarget`, `ScopeSource` (common)                                  | types      | the evaluator's target; guard and decorator parameters                                                                          |
| `SCOPED_RBAC_POLICY` (common)                                               | constant   | AuthPlugin `define`; guards; DecoratorPlugin `appendPolicyMiddleware`; the reserved-name refusal                                |
| `scopedPermissionAbility`, `scopedRoleAbility` (common)                     | functions  | the policy's ability generation; guards; decorator middleware; imperative `can` callers                                         |
| `scopeFromTenant`, `scopeFromParam` (common)                                | functions  | guard/decorator default and options; applications                                                                               |
| `requireScopedRole`, `requireScopedPermission` (auth-plugin)                | functions  | applications' routes; scanned at bootstrap                                                                                      |
| `GrantResolutionError` (auth-plugin)                                        | class      | `AuthSessionService.signIn` rejection under `'sign-in'` timing; applications' `instanceof`; `errorHandler` reads its `503` hint |
| `ScopedRbacOptions`, `GrantSourceConfig`, `ScopedRbacTiming` (auth-plugin)  | types      | `AuthPluginOptions.scopedRbac`                                                                                                  |
| `ScopedRoles`, `ScopedPermissions` (decorator-plugin)                       | functions  | DecoratorPlugin route registration                                                                                              |
| `createDatabaseGrantSource`, `createDatabaseRoleSource` (database-plugin)   | functions  | `scopedRbac.sources[].source` / `scopedRbac.customRoles` (resolved by AuthPlugin at `onInit`)                                   |
| `DatabaseGrantSourceOptions`, `DatabaseRoleSourceOptions` (database-plugin) | types      | the two factories' parameters                                                                                                   |

### 4.1 Options — every option names its consumer

| Option                                  | Consumer                             | Behavior                                                               |
| --------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| `scopedRbac.sources`                    | evaluator `#resolveGrants`           | Unioned; a factory arm resolved at `onInit`; any failure denies (§3.7) |
| `scopedRbac.permissions`                | ability generation (§3.1)            | Extra catalogue permissions not named by any role                      |
| `scopedRbac.inheritsFrom`               | `#resolveChain` (§3.5)               | Absent → flat                                                          |
| `scopedRbac.tenantScopeType`            | tenant-consistency check (§3.6)      | Default `'tenant'`                                                     |
| `scopedRbac.grantableIn`                | evaluation (§3.8)                    | Misplaced grant ignored                                                |
| `scopedRbac.customRoles`                | `#resolveCustomRoles` (§3.11)        | Absent → catalogue only                                                |
| `scopedRbac.timing`                     | memo / cache / session read (§3.12)  | Default `'request'`                                                    |
| `scopedRbac.sourceTimeoutMs`, `max*`    | `withDeadline`, bound checks (§3.13) | Refused out of range at construction                                   |
| `createDatabaseGrantSource({ fields })` | the bridge's filter builder          | Overrides the four column names                                        |
| `createDatabaseRoleSource({ fields })`  | the bridge's filter builder          | Overrides the four column names                                        |

## 5. Implementation files

| File                                                                  | Purpose                                                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/scoped-authorization.ts`                | model types, `IGrantSource`, `IScopedRoleSource`, `SCOPED_RBAC_POLICY`, encoders, validators                                                      |
| `packages/common/src/services/scope-sources.ts`                       | `scopeFromTenant`, `scopeFromParam`, `ScopeSource`                                                                                                |
| `packages/common/src/index.ts`                                        | barrel                                                                                                                                            |
| `packages/auth-plugin/src/scoped/options.ts`                          | `compileScopedRbac` (construction validation, §3.2/§3.13)                                                                                         |
| `packages/auth-plugin/src/scoped/scoped-policy.ts`                    | builds the built-in `PolicyDefinition` (abilities, closures, evaluation §3.8)                                                                     |
| `packages/auth-plugin/src/scoped/scope-chain.ts`                      | `inheritsFrom` walk (§3.5) and tenant consistency (§3.6)                                                                                          |
| `packages/auth-plugin/src/scoped/grant-resolver.ts`                   | source union, validation/copy, bounds, deadlines, memo and cache (§3.7/§3.12/§3.13)                                                               |
| `packages/auth-plugin/src/scoped/custom-roles.ts`                     | custom-role resolution and rules (§3.11)                                                                                                          |
| `packages/auth-plugin/src/scoped/scoped-guards.ts`                    | `requireScopedRole`, `requireScopedPermission`                                                                                                    |
| `packages/auth-plugin/src/scoped/errors.ts`                           | `GrantResolutionError` (`503`-hinted)                                                                                                             |
| `packages/auth-plugin/src/policies/policy-guard.ts`                   | brand widened to `abilities: readonly string[]`; `requirePolicy` writes a one-element list (§3.9)                                                 |
| `packages/auth-plugin/src/policies/startup-scan.ts`                   | iterates the brand's abilities; `scoped-rbac` refusal names `AuthPlugin({ scopedRbac })` (§3.9)                                                   |
| `packages/auth-plugin/src/sign-in/auth-session-service.ts`            | sign-in timing: resolve in `signIn` for both outcomes; carry in the pending record; `promotePending` moves them; clear with the principal (§3.12) |
| `packages/auth-plugin/src/plugin/auth-plugin.ts`                      | option compile, define the built-in policy, `onInit` factory resolution                                                                           |
| `packages/auth-plugin/src/interfaces/index.ts`                        | `AuthPluginOptions.scopedRbac` and its types                                                                                                      |
| `packages/auth-plugin/src/index.ts`                                   | barrel                                                                                                                                            |
| `packages/decorator-plugin/src/decorators/scoped.ts`                  | `@ScopedRoles`, `@ScopedPermissions`                                                                                                              |
| `packages/decorator-plugin/src/plugin/policy-registration.ts`         | new `appendScopedRbacMiddleware`: one middleware per decorator, any-of / all-of over one scope resolution (§3.15)                                 |
| `packages/decorator-plugin/src/metadata/metadata-store.ts`            | route/class scoped-requirement slots                                                                                                              |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts`            | ordering; `buildRouteSchema` public-marker condition                                                                                              |
| `packages/decorator-plugin/src/index.ts`                              | barrel                                                                                                                                            |
| `packages/database-plugin/src/authorization/database-grant-source.ts` | `createDatabaseGrantSource`                                                                                                                       |
| `packages/database-plugin/src/authorization/database-role-source.ts`  | `createDatabaseRoleSource`                                                                                                                        |
| `packages/database-plugin/src/index.ts`                               | barrel                                                                                                                                            |
| `docs/authorization.md`                                               | "Scoped roles" section, fence-gated                                                                                                               |

Doc and process deliverables in the same PR: `PUBLIC_API.md` (common rows, auth-plugin,
decorator-plugin and database-plugin sections), three package READMEs, `ARCHITECTURE.md` §14 (C5),
`CHANGELOG.md` `Unreleased` → `Added` (no `docs/upgrading.md` entry — nothing breaks), the ROADMAP
corrections C1–C4, the ROADMAP Progress row flipped to `✅`, the CLAUDE.md "Current status" entry,
and this plan moved to `plans/archive/`. Every new symbol carries `@since 0.9.0`.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                        | src covered                                       | Key assertions                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/scoped-grants.test.ts`                         | scoped-authorization.ts                           | encoders; validator rows (grammar, length, non-string, read-once getters); reserved name constant                                                                                                                                                                                                                                                              |
| `common/test/unit/scope-sources.test.ts`                         | scope-sources.ts                                  | tenant present/absent → ref/`undefined`; param present/absent; custom type                                                                                                                                                                                                                                                                                     |
| `common/test/unit/barrel-exports.test.ts` (extend)               | index.ts                                          | new symbols pinned against the barrel                                                                                                                                                                                                                                                                                                                          |
| `auth-plugin/test/unit/scoped/scoped-options.test.ts`            | options.ts                                        | every §3.2/§3.13 refusal by name, `NaN`/`0`/negative rows                                                                                                                                                                                                                                                                                                      |
| `auth-plugin/test/unit/scoped/scoped-policy.test.ts`             | scoped-policy.ts                                  | ability generation; closure/wildcard/inheritance; prototype names; `grantableIn`; M98h records nothing                                                                                                                                                                                                                                                         |
| `auth-plugin/test/unit/scoped/scope-chain.test.ts`               | scope-chain.ts                                    | flat, hierarchy, diamond, cycle, depth/node bounds, resolver throw/timeout, tenant consistency rows                                                                                                                                                                                                                                                            |
| `auth-plugin/test/unit/scoped/grant-sources.test.ts`             | grant-resolver.ts                                 | static/claims/custom/factory; union; invalid grant dropped; any failure denies; bound denies; deadline                                                                                                                                                                                                                                                         |
| `auth-plugin/test/unit/scoped/grant-cache.test.ts`               | grant-resolver.ts (memo, cache)                   | per-request memo isolated by `context.state`; a failure memoised within the request only (one source call, one log for a two-entry ALL-of); no memo without context; cache TTL on a fake monotonic clock; LRU eviction; failure not cached; two issuers, one id; concurrent identical resolutions coalesce onto one source call, different principals never do |
| `auth-plugin/test/unit/scoped/custom-roles.test.ts`              | custom-roles.ts                                   | a grant resolves against roles defined in ITS OWN scope only; two chain scopes defining one name never collide; one batched `rolesFor` call per check, none when every grant is a catalogue role; shadowing ignored; unknown permission dropped; bounds deny                                                                                                   |
| `auth-plugin/test/unit/scoped/fail-closed.test.ts`               | grant-resolver.ts, scope-chain.ts                 | §3.14 table with canary ids absent from every log record; a source error whose MESSAGE carries a canary id never reaches the log (the check does not throw, so `PolicyService.#report` never runs); a throwing logger leaves the deny unchanged                                                                                                                |
| `auth-plugin/test/unit/scoped/scoped-guards.test.ts`             | scoped-guards.ts                                  | 501/401/403/allow; 401 before the scope source runs; any-of/all-of short-circuit; empty array refused; brand lists every ability; an unregistered ability rejects through `can` before the scope source runs                                                                                                                                                   |
| `auth-plugin/test/integration/scoped-startup-scan.test.ts`       | auth-plugin.ts                                    | unknown permission/role on a route fails `start()`; scoped guard without `scopedRbac` fails naming it; reserved policy name refused                                                                                                                                                                                                                            |
| `auth-plugin/test/integration/scoped-tenant-consistency.test.ts` | scope-chain.ts via a real kernel app              | §3.6 rows with `MultiTenancyPlugin` resolving the request tenant                                                                                                                                                                                                                                                                                               |
| `auth-plugin/test/integration/scoped-sign-in.test.ts`            | auth-session-service.ts                           | grants stored privately; read at check time; cleared on sign-out/regenerate; failure rejects `signIn` with `GrantResolutionError` (`503`) and records nothing; a forged claim of the same name is ignored; MFA path — grants resolved at `signIn` ride the pending record and arrive through TOTP `completeSignIn`, a recovery code and passkey step-up        |
| `auth-plugin/test/integration/scoped-scenarios.test.ts`          | end to end                                        | scenarios A–E (§6.1), each with its negative control                                                                                                                                                                                                                                                                                                           |
| `auth-plugin/test/unit/barrel-exports.test.ts` (extend)          | index.ts                                          | new exports pinned                                                                                                                                                                                                                                                                                                                                             |
| `auth-plugin/test/unit/policies/startup-scan.test.ts` (extend)   | startup-scan.ts                                   | a multi-ability brand with one unknown entry is refused; a one-element brand behaves as before; the `scoped-rbac` message names `scopedRbac`                                                                                                                                                                                                                   |
| `auth-plugin/test/unit/policies/require-policy.test.ts` (extend) | policy-guard.ts                                   | the brand is a one-element list; `policyGuardOf` rejects a malformed list                                                                                                                                                                                                                                                                                      |
| `decorator-plugin/test/unit/scoped-decorators.test.ts`           | decorators/scoped.ts, metadata-store.ts           | metadata recorded; method overrides class; register-time refusals                                                                                                                                                                                                                                                                                              |
| `decorator-plugin/test/integration/scoped-rbac-e2e.test.ts`      | policy-registration.ts, decorator-plugin.ts       | real kernel app + AuthPlugin: any-of/all-of; order after `@Roles`; `@Public` marker omitted; parity with `requireScopedPermission` (byte-identical bodies)                                                                                                                                                                                                     |
| `database-plugin/test/unit/grant-source.test.ts`                 | database-grant-source.ts, database-role-source.ts | memory adapter: chain/global/all; limit refusal; `$`-key and object-value refusal; role grouping                                                                                                                                                                                                                                                               |
| `database-plugin/test/integration/grant-source-real.test.ts`     | both bridges                                      | Drizzle on PostgreSQL (`OUTBOX_POSTGRES_URL`) and MongoDB (`MONGODB_URI`), guarded with `ignore:`                                                                                                                                                                                                                                                              |
| `database-plugin/test/unit/barrel-exports.test.ts` (extend)      | index.ts                                          | new exports pinned                                                                                                                                                                                                                                                                                                                                             |
| `test/guide-fence-compiler.test.ts`                              | `docs/authorization.md`                           | the new section's fences compile                                                                                                                                                                                                                                                                                                                               |

### 6.1 Reference scenarios (each through a real kernel application, configuration only)

| Scenario | Configuration                                                                                                                         | Allowed                                             | Negative control (must deny)                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A        | `MultiTenancyPlugin` header resolver; grants from `createDatabaseGrantSource` over the memory adapter; `inheritsFrom` = parent tenant | grant in parent tenant applies to child; global row | grant in tenant X, request in sibling tenant Y → 403                                                                                      |
| B        | three sources: static role×region, custom role×channel, global per-user roles; `timing: 'sign-in'` through password sign-in           | each list grants in its scope                       | a region grant does not apply in another region → 403 (the documented sign-in latency is asserted separately in `scoped-sign-in.test.ts`) |
| C        | `inheritsFrom` organisation → team → project                                                                                          | org grant applies on a project                      | project grant does not apply on its organisation                                                                                          |
| D        | `{ kind: 'claims' }` mapping an `orgs` claim; no store                                                                                | claim for org X allows in org X                     | claim for org X, scope org Y → 403                                                                                                        |
| E        | `customRoles` defines `regional-approver` in tenant X bundling `invoices:approve`                                                     | grant of the custom role in X allows the permission | same grant in tenant Y → 403; custom role shadowing a catalogue name ignored                                                              |

Negative controls (each observed failing, then reverted): truthiness instead of grant membership;
dropping `Object.hasOwn` in closure lookup; tenant consistency removed; cycle detection removed;
union continued past a failed source; cache keyed by `id` alone (two-issuer row must fail); sign-in
grants stored in `claims` (forged-claim row must fail); repository filter built without the subject
clause; the built-in check allowed to throw (the canary-in-error-message row must fail); custom
roles resolved against any chain scope instead of the grant's own (the name-collision row must
fail); `promotePending` not moving the pending grants (the MFA row must fail).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m110b-scoped-rbac
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

Plus a behavioral probe (`.verify-110b/driver.ts`, scratch, not committed) driving a real kernel app
with AuthPlugin + MultiTenancyPlugin + DecoratorPlugin + DatabasePlugin + errorHandler through
scenario A over HTTP, reading every refusal body and the log records for canary ids.

## 8. Risks & mitigations

- A slow grant source slows every guarded request → bounded by `sourceTimeoutMs` (deny on expiry);
  `cache` timing for hot paths; documented.
- `'sign-in'` timing makes revocation wait for sign-out → the latency is stated per mode in the
  option JSDoc, PUBLIC_API and the guide; `cache` is the documented middle ground.
- A large grant list on the cookie session strategy exceeds the cookie size →
  `maxGrantsPerPrincipal` bounds it, and the guide recommends the store strategy for `'sign-in'`
  timing.
- The repository source's `or(...)` filter is not portable to every adapter (Bigtable evaluates
  client-side; Cosmos queries cross-partition) → the real suites cover PostgreSQL and MongoDB; other
  adapters are documented as unverified and an adapter refusal denies (fail closed).
- A timed-out repository query keeps running on the database (`findAll` takes no signal) → stated in
  both factories' JSDoc and the guide; concurrent identical resolutions coalesce (§3.13), so one hot
  principal cannot multiply abandoned queries.
- Principal ids colliding across authentication strategies poison the cache → `principalKey`
  includes the `iss` claim; documented that other strategies must issue distinct ids.

## 9. Out of scope

- Deny rules and deny-overrides — fixed out by the ROADMAP; room is left because grants are a union
  of positives only.
- An ingress principal source — proposed **M110c**.
- Scoped decisions in M98h explanations — unowned (§3.17).
- Custom roles that inherit — rejected for this milestone; a custom role bundles permissions only.
- Rerouting the six global guards or `@Roles`/`@Permissions` through the scoped evaluator — fixed
  out by the maintainer decision (new names).

## 10. Design security review

**Reviewed flow.** A request reaches a scoped guard or decorator middleware → `401` for an anonymous
request before any scope source runs → the scope source resolves a `ScopeRef` (or `null`, or
`undefined` = unresolved) → `service.can(principal, 'scoped-rbac', ability, { scope, context })` →
the evaluator validates the scope, walks `inheritsFrom` (bounded), checks tenant consistency,
resolves grants (memo / cache / session per timing; every source bounded and validated), resolves
custom roles, evaluates the ability → allow or a `403` through the shared responder. At startup the
M110a scan refuses unknown abilities and seals.

**Assets.** The decision; scope identifiers (tenant and organisation ids may be business data);
principal ids; the grant lists themselves (they reveal who may do what where).

**Attackers.** (A1) an unauthenticated client; (A2) a signed-in principal reaching for a scope it
holds no grant in; (A3) a client controlling a route parameter, header or body that feeds a scope
source; (A4) a federated identity provider whose users control some claims; (A5) code in the same
process.

| #   | Threat                                                                                                                                                           | Resolution                                                                                                                                                                                                                                   | Carried by                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| T1  | (A3) a route-parameter scope names another tenant than the resolved request tenant                                                                               | Tenant consistency on the check's own scope (§3.6)                                                                                                                                                                                           | `scoped/scope-chain.ts`                                          |
| T2  | (A3) a crafted scope id (overlong, control characters) reaches a log or error message                                                                            | Ids validated (≤256) and NEVER logged — logs carry a fixed reason, the scope TYPE and an error NAME only; the built-in check never throws, so `PolicyService.#report` never serializes a source error whose message quotes bound ids (§3.14) | `scoped/grant-resolver.ts`, `scope-chain.ts`, `scoped-policy.ts` |
| T3  | (A2) a source failure or timeout allows                                                                                                                          | Every failure denies the whole check (§3.14)                                                                                                                                                                                                 | `grant-resolver.ts`                                              |
| T4  | (A5) the cache serves one principal's grants to another                                                                                                          | Key includes `[id, iss]` and the query; failures never cached                                                                                                                                                                                | `grant-resolver.ts`                                              |
| T5  | (A4) a federated token carries a forged grants claim                                                                                                             | Sign-in grants stored under a private session key, never in `claims`; the claims source reads only the claim its configured `map` names                                                                                                      | `sign-in/auth-session-service.ts`, §3.12                         |
| T6  | (A5) a caller-built memo injects grants                                                                                                                          | The memo is module-private, keyed by `context.state` identity; the target carries no memo                                                                                                                                                    | `grant-resolver.ts`                                              |
| T7  | A grant naming a prototype member (`constructor`) resolves a role                                                                                                | `Object.hasOwn` on frozen catalogue copies                                                                                                                                                                                                   | `scoped/scoped-policy.ts`                                        |
| T8  | (A3) a cyclic or deep `inheritsFrom` graph exhausts the process                                                                                                  | Cycle refusal, depth and node bounds, each call deadlined                                                                                                                                                                                    | `scope-chain.ts`                                                 |
| T9  | A custom role shadows a catalogue role, or grants a permission outside the catalogue                                                                             | Shadowing ignored; unknown permissions dropped; both counted                                                                                                                                                                                 | `scoped/custom-roles.ts`                                         |
| T10 | (A3) MongoDB operator injection through a scope id in the repository source                                                                                      | Only scalar strings reach `where`/`filter`; `$`-keys and object values refused                                                                                                                                                               | `database-plugin` bridges                                        |
| T11 | A typo'd permission silently denies forever                                                                                                                      | Startup scan refuses it (§3.9); imperative unknown ability rejects                                                                                                                                                                           | M110a scan                                                       |
| T12 | A refusal body discloses the scope or the missing permission                                                                                                     | Bodies come from `authorizationFailureInit` (fixed); no scope or ability text served                                                                                                                                                         | `common/errors/authorization-responder.ts`                       |
| T13 | Revocation is slower than an operator expects                                                                                                                    | Latency stated per timing mode in JSDoc, PUBLIC_API and the guide; default `'request'` is immediate                                                                                                                                          | §3.12                                                            |
| T14 | Under `'sign-in'` timing, a principal completing a second factor arrives with no grants (silent under-grant) — or with grants resolved for a different principal | Grants are resolved in `signIn` for the principal it accepted and carried INSIDE that principal's pending record; `promotePending` moves them in the same write that records the principal                                                   | `sign-in/auth-session-service.ts`                                |
| T15 | (A5) a custom role defined in one scope widens a same-named grant in another scope of the chain                                                                  | A grant resolves against custom roles defined in its own scope only (§3.11)                                                                                                                                                                  | `scoped/custom-roles.ts`                                         |

**Obligations on the committed-tree audit** (each a probe with a positive control, at a real kernel
application):

1. Drive T1 with `scopeFromParam` against a resolved tenant, through both entry points.
2. Plant canary scope ids and principal ids; prove they are absent from every response body and
   every log record across every §3.14 deny.
3. Prove a failing, hanging and over-bound source each deny (T3), with the handler not run.
4. Prove two principals sharing an `id` under different `iss` claims never share a cache entry (T4).
5. Prove a token carrying a claim named like the private session key grants nothing (T5).
6. Prove a cyclic `inheritsFrom` denies within the deadline (T8).
7. Drive T10 against the real MongoDB suite with a `$where` scope id.
8. Prove a principal completing TOTP, a recovery code and passkey step-up under `'sign-in'` timing
   holds exactly the grants resolved at its first factor (T14).
9. Prove two chain scopes defining the same custom role name cannot widen each other's grants (T15).
10. Confirm each §6 negative control exists and fails when its guard is removed.
