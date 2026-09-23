# Milestone 98h — Authorization Decision Explanations

> **Status:** Planning on `docs/m98-capability-diagnostics`. Implementation and fixes belong on
> `feat/m98h-authorization-explanations`; `main` remains protected.

## 0. Objective & scope

Observe the actual RBAC evaluation once and publish a bounded, identity-free explanation using
approved rule aliases and fixed reason categories. The boolean `IAuthorizationService` remains
authoritative and unchanged; diagnostic failure cannot alter allow/deny or guard short-circuit
order.

- **In scope:** direct/inherited/wildcard/deny explanations for `RbacService`, compound evaluation
  steps actually executed, policy revision alias, custom-provider availability, typed source/token,
  `/v1/authorization`, native `authorization(after, limit)`, tests/docs, and both security gates.
- **NOT this milestone:** authentication/JWT explanations, principal/claim/resource display,
  arbitrary custom policy trees, hypothetical simulation, rerunning a decision, or changes to
  401/403/501 responses.

## 1. Contracts verified from SOURCE (not names)

| Reference                 | Source (file:line)                                                    | Verified surface / fact                                                                                    |
| ------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `IAuthorizationService`   | `packages/common/src/services/auth.ts:152`                            | Four synchronous boolean methods; no reason or decision context.                                           |
| `RbacService`             | `packages/auth-plugin/src/services/rbac-service.ts:15`                | Knows direct permissions, wildcard, transitive roles and short-circuit order internally.                   |
| AuthPlugin registration   | `packages/auth-plugin/src/plugin/auth-plugin.ts:47`                   | Authorization exists only when `rbac` is configured and is replaceable in the registry.                    |
| Auth guards               | `packages/auth-plugin/src/guards/index.ts:92`                         | Resolve the live service, call it once, and short-circuit without `next()` on denial.                      |
| Decorator authorization   | `packages/decorator-plugin/src/plugin/authorization-middleware.ts:42` | Uses the same service; roles call `hasAnyRole`, permissions use short-circuiting repeated `hasPermission`. |
| Registry replacement/seal | `packages/kernel/src/registry/service-registry.ts:187`                | Overrides may occur during startup; registry becomes immutable after bootstrap.                            |
| M98 event inference limit | `packages/common/src/services/diagnostics.ts:226`                     | Kernel events contain status/outcome only; a 403 cannot identify the rule that failed.                     |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                        | Resolution (picked side)                                                                                    | Doc deliverable (same PR)                                                                      |
| -- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| C1 | Existing public contracts promise booleans and current docs expose no explanation tree; ROADMAP asks for observed explanations. | Preserve the boolean interface and attach an internal observer only to the first-party RBAC implementation. | Update `PUBLIC_API.md`, `ARCHITECTURE.md`, protocol/package docs, changelog and tracking docs. |

## 3. Design decisions

### 3.1 Refactor evaluation without changing it

- **Decision:** Extract private pure evaluators for one role and one permission. Public `hasRole`
  and `hasPermission` call one evaluator and emit one guarded decision after obtaining the boolean.
  `hasAnyRole`/`hasAllPermissions` loop those private evaluators directly, retain current order and
  stop point, then emit one compound decision containing only the steps actually evaluated. They do
  not call public methods, preventing nested duplicate records. Existing permission/inheritance
  caches remain authoritative.
- **Why:** The record describes the evaluation that produced the returned boolean, not a replay.
- **Test home:** RBAC truth-table and exact callback-count tests.

### 3.2 Fixed explanation vocabulary

- **Decision:** `AuthorizationDecisionObservation` contains sequence, opaque `d<N>` decision ID,
  operation (`role`, `permission`, `any-role`, `all-permissions`), result, approved rule alias(es),
  at most 16 evaluated steps, optional approved `viaRoleAlias`, fixed reason (`direct-role`,
  `inherited-role`, `direct-permission`, `direct-wildcard`, `role-permission`, `role-wildcard`,
  `not-held`, `compound-satisfied`, `compound-unsatisfied`), optional policy revision alias, and
  `ageMs`. It has no principal, request, route, credential, claim, resource, raw rule, error, or
  arbitrary detail field. Unevaluated compound branches have no entry.
- **Why:** The devtool can explain the result without serializing policy or identity objects.
- **Test home:** collector and protocol exact-key/reason tests.

### 3.3 Rule approval and bounds

- **Decision:** `AuthorizationDiagnosticsOptions` requires `enabled: true`, `roles` and
  `permissions` exact-name to display-alias maps, and optional safe `policyRevision`. Accept 128
  entries per map, unique 1–64-byte aliases, 16 evaluated steps/decision, 1,024 decisions retained,
  and 128/read. If any requested rule lacks an alias, the complete decision is dropped before
  buffering and a saturated counter increments; partial rule lists are never emitted. A granting
  principal role is included only when it has an approved role alias.
- **Why:** Rule names and relationships can reveal security design; partial aliasing can still
  identify them by position.
- **Test home:** options, unapproved/drop, overflow and canary tests.

### 3.4 Actual-provider availability

- **Decision:** Add eager `CAPABILITIES.AUTHORIZATION_DIAGNOSTICS` (`authorization-diagnostics`) and
  `IAuthorizationDiagnosticsSource`. AuthPlugin always registers a source. It reports `disabled`
  without the option, `no-data` with active observed RBAC, `unsupported` with fixed coverage
  `rbac-not-configured`, and `unsupported` with coverage `custom-provider` when the final
  `CAPABILITIES.AUTHORIZATION` provider at `onBootstrap` is not the exact RbacService instance the
  plugin created. `collection-failed` remains reserved for failure in supported capture. On
  replacement the plugin detaches/clears the collector. Registry sealing makes the bootstrap result
  stable. Direct custom-service decisions are never guessed from booleans/status.
- **Why:** Records cannot claim to explain enforcement performed by a replacement service.
- **Test home:** override-before-bootstrap and custom-provider integration tests.

### 3.5 Observer isolation

- **Decision:** Store the observer in a package-private WeakMap keyed by RbacService and attach it
  from AuthPlugin. Each public method computes its decision first, then invokes the observer inside
  `try/catch`, and returns the already-computed boolean unchanged. Overflow, malformed aliases,
  source close and throwing observers only drop diagnostics. `onClose` detaches and clears the ring.
- **Why:** A diagnostic path cannot permit, deny, throw, or alter guard short-circuiting.
- **Test home:** observer-throw/full/closed parity tests through real guards and decorator
  middleware.

### 3.6 Fixed connector and client operation

- **Decision:** DiagnosticsPlugin optionally consumes the source and serves only canonical
  `GET /v1/authorization?after=N&limit=N`; absent source returns typed package `unsupported`.
  `AuthorizationDiagnosticsBatch` carries version, authenticated instance, state/coverage,
  decisions, next/lost/closed/droppedUnapproved. The projector copies exact own fields, catches
  source failures with fixed categories, and the client validates through
  `authorization(after, limit)`.
- **Why:** An authorization explanation is data-only and gains no policy-execution or mutation
  endpoint.
- **Test home:** protocol/connector/client/e2e security tests.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                                  | Kind              | Consumer / real code path that READS it                  |
| ------------------------------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------- |
| Authorization diagnostic operation/reason/coverage types                                         | common types      | Collector, protocol/client and devtool explanation view. |
| `AuthorizationDecisionStep`, `AuthorizationDecisionObservation`, `AuthorizationDiagnosticsBatch` | common interfaces | RBAC source and devtool.                                 |
| `IAuthorizationDiagnosticsSource`                                                                | common interface  | AuthPlugin provider and DiagnosticsPlugin consumer.      |
| `CAPABILITIES.AUTHORIZATION_DIAGNOSTICS`                                                         | common token      | Same provider/consumer path.                             |
| `AuthorizationDiagnosticsOptions`                                                                | auth option type  | AuthPlugin validates and attaches collector.             |
| `IDiagnosticsClient.authorization`                                                               | interface method  | Native devtool reads decisions.                          |

Private evaluator results, WeakMap observer, collector, raw maps and projectors are not exported.

### 4.1 Options — every option names its consumer

| Option                       | Consumer            | Behavior (per implementation)                                         |
| ---------------------------- | ------------------- | --------------------------------------------------------------------- |
| `diagnostics.enabled: true`  | AuthPlugin          | Attaches collector only to authoritative first-party RBAC.            |
| `diagnostics.roles`          | evaluator projector | Approves/replaces requested and granting role names.                  |
| `diagnostics.permissions`    | evaluator projector | Approves/replaces requested permission names.                         |
| `diagnostics.policyRevision` | collector           | Adds one safe revision alias; never derives or hashes policy content. |

## 5. Implementation files

| File                                                                                                     | Purpose                                                                      |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| common diagnostics/tokens/index source                                                                   | Authorization DTO/source contracts, token and exports.                       |
| `packages/auth-plugin/src/interfaces/index.ts`, `src/diagnostics/authorization-observation-collector.ts` | Options, bounded ring/source and attachment seam.                            |
| `packages/auth-plugin/src/services/rbac-service.ts`, `src/plugin/auth-plugin.ts`, `src/index.ts`         | Single-pass evaluators, authoritative-provider check, lifecycle and exports. |
| diagnostics interfaces/plugin/protocol/connector/client source                                           | Fixed authorization operation and client method.                             |
| Public, architecture, protocol, package, release and tracking docs                                       | Semantics, custom-provider limits and audit evidence.                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                 | src covered                           | Key assertions (and the signature each call type-checks against)                                                         |
| --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| common diagnostics/token/index tests                      | common changed files                  | Types, exports and legal token.                                                                                          |
| auth options/collector tests                              | interfaces/collector                  | Alias/revision bounds, ring/loss, exact fields, no identity/rule canaries.                                               |
| auth `test/unit/rbac-service.test.ts`                     | rbac-service                          | Existing boolean truth table plus direct/inherited/wildcard/deny reasons and exact evaluated steps.                      |
| auth `test/unit/plugin.test.ts`, `test/index.test.ts`     | plugin/index                          | eager source; disabled/no-rbac/replaced/authoritative states; detach/clear; exports.                                     |
| auth guard integration tests                              | rbac-service/collector through guards | Same 401/403/next behavior with observer absent/enabled/throwing/full; one evaluation only.                              |
| decorator authorization integration tests                 | actual service path                   | Role compound and permission `.some` short-circuit observations match actual calls; no fabricated skipped branch.        |
| diagnostics protocol/connector/plugin tests               | protocol/connector/plugin             | canonical query, auth-before-read, exact projection, unsupported/source-failure handling.                                |
| diagnostics client/index tests                            | client/interfaces                     | `authorization()` args, signed verification, exact DTO/instance checks.                                                  |
| diagnostics `test/e2e/authorization-explanations.test.ts` | all paths                             | Real socket/guards; positive reasons; JWT/principal/claim/request/error canaries absent; custom replacement unsupported. |

## 7. Verification gates

```bash
git branch --show-current   # feat/m98h-authorization-explanations during implementation
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage
```

Enforce the ANSI-stripped 90% per-file branch/function/line bar. On the committed tree run
`deno task publish:check` and `deno task release:verify <version>`. Record the reviewed revision,
real guard and decorator exercises, findings, dispositions and custom-provider limitation in the
implementation PR.

## 8. Risks & mitigations

- Explanation drifts from enforcement: emit from the private evaluator result used for the returned
  boolean.
- Observer changes allow/deny: compute first, guard observer, return stored result.
- Rules or identities leak: explicit aliases; observer signature excludes principal data and
  arbitrary text.
- Compound tree invents skipped work: record only loop iterations actually evaluated.
- Replaced provider is misrepresented: compare exact provider at bootstrap and detach first-party
  collector.

## 9. Out of scope

- Authentication failures, tokens, claims, principal/resource inspection, and route/request
  correlation.
- Custom policy explanation adapters and hypothetical decision simulation.
- Full policy graph serialization or unapproved rule names.

## 10. Design security review — completed before implementation

**Reviewed flow:** authoritative RBAC method → private evaluator result → alias-only guarded
observer → bounded ring → typed source → authenticated fixed connector → signed frame → validating
client. The principal is used by the evaluator but is not an observer argument; minimization occurs
before retention.

**Approved budgets:** 128 role aliases, 128 permission aliases, 16 steps/decision, 1,024 records,
128/read, 64-byte aliases/revision and 256 KiB/frame. Disabled, no-policy and replaced-provider
modes retain no decision ring.

| Finding                                                         | Resolution in this plan                                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Calling authorization again can change results or side effects. | Explain the same private evaluator result; never replay.                           |
| A 403 cannot identify the failed rule.                          | Capture only at the actual RBAC service, never infer from HTTP status.             |
| Custom providers expose booleans only.                          | Explicit unsupported-service coverage after exact-provider check.                  |
| Names and principal roles reveal policy/identity.               | Approved aliases only; principal, claims and unapproved granting roles are absent. |

The implementation audit compares observed and returned decisions for direct/inherited/wildcard/deny
and compound short-circuits, including custom replacement. It plants canaries in JWTs, IDs, roles,
permissions, claims, requests, resources and thrown values; checks observer calls, ring, frames,
errors and logs; proves useful approved explanations survive; and repeats every M98b
credential/replay/origin/authority/expiry/revocation/ instance/version/mutation refusal for
`/v1/authorization`.
