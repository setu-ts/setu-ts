# Milestone 98h — Authorization Decision Explanations

> **Status:** Planning on `docs/m98-capability-diagnostics`. Implementation and fixes belong on
> `feat/m98h-authorization-explanations`; `main` remains protected.

## 0. Objective & scope

Observe the actual RBAC evaluation once and publish a bounded, identity-free explanation using
approved rule aliases and fixed reason categories. The boolean `IAuthorizationService` remains
authoritative and unchanged; diagnostic failure cannot alter allow/deny or guard short-circuit
order.

- **In scope:** direct/inherited/wildcard/deny explanations for `RbacService`, compound evaluation
  steps actually executed, policy revision alias, a non-resolving registry identity predicate,
  custom-provider availability, typed source/token, `/v1/authorization`, native
  `authorization(after, limit)`, tests/docs, and both security gates.
- **NOT this milestone:** authentication/JWT explanations, principal/claim/resource display,
  arbitrary custom policy trees, hypothetical simulation, rerunning a decision, or changes to
  401/403/501 responses.

Implementation starts from main containing M98d's fixed inspector-support manifest; HealthPlugin
itself remains optional and is not required for authorization explanations.

## 1. Contracts verified from SOURCE (not names)

| Reference                 | Source (file:line)                                                    | Verified surface / fact                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `IAuthorizationService`   | `packages/common/src/services/auth.ts:152`                            | Four synchronous boolean methods; no reason or decision context.                                                                           |
| `RbacService`             | `packages/auth-plugin/src/services/rbac-service.ts:15`                | Knows direct permissions, wildcard, transitive roles and short-circuit order internally.                                                   |
| AuthPlugin registration   | `packages/auth-plugin/src/plugin/auth-plugin.ts:47`                   | Authorization exists only when `rbac` is configured and is replaceable in the registry.                                                    |
| Auth guards               | `packages/auth-plugin/src/guards/index.ts:92`                         | Resolve the live service, call it once, and short-circuit without `next()` on denial.                                                      |
| Decorator authorization   | `packages/decorator-plugin/src/plugin/authorization-middleware.ts:42` | Uses the same service; roles call `hasAnyRole`, permissions use short-circuiting repeated `hasPermission`.                                 |
| Registry replacement/seal | `packages/kernel/src/registry/service-registry.ts:187`                | Overrides may occur during startup; registry becomes immutable after bootstrap.                                                            |
| Non-resolving lookup      | `packages/kernel/src/registry/service-registry.ts:86`                 | `peekResolved` can compare an existing instance without running a factory, but is intentionally absent from the public registry interface. |
| M98 event inference limit | `packages/common/src/services/diagnostics.ts:226`                     | Kernel events contain status/outcome only; a 403 cannot identify the rule that failed.                                                     |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                              | Resolution (picked side)                                                                                                                                       | Doc deliverable (same PR)                                                                                                                                     |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | Existing public contracts promise booleans and current docs expose no explanation tree; ROADMAP asks for observed explanations.                                                                       | Preserve the boolean interface and attach an internal observer only to the first-party RBAC implementation.                                                    | Update `PUBLIC_API.md`, `ARCHITECTURE.md`, protocol/package docs, changelog and tracking docs.                                                                |
| C2 | ServiceRegistry has an internal non-resolving peek, while `IServiceRegistry` intentionally exposes only resolving `get`; exact provider checks through `get` could instantiate a custom lazy service. | Add only an optional identity predicate, `isCurrent?(token, instance)`, with no returned service or enumeration; absence conservatively disables explanations. | Document the new registry method, compatibility fallback and non-resolving semantics in `PUBLIC_API.md`, `ARCHITECTURE.md`, common/kernel docs and changelog. |

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
  at most 16 evaluated steps, `stepsEvaluated` (the true count, saturating) and `stepsTruncated`
  (§3.3), optional approved `viaRoleAlias`, fixed reason (`direct-role`, `inherited-role`,
  `direct-permission`, `direct-wildcard`, `role-permission`, `role-wildcard`, `not-held`,
  `compound-satisfied`, `compound-unsatisfied`), optional policy revision alias, and `ageMs`. It has
  no principal, request, route, credential, claim, resource, raw rule, error, or arbitrary detail
  field. Unevaluated compound branches have no entry, and a step count is a count only — it never
  carries a rule name that was not approved.
- **Why:** The devtool can explain the result without serializing policy or identity objects.
- **Test home:** collector and protocol exact-key/reason tests.

### 3.3 Rule approval and bounds

- **Decision:** `AuthorizationDiagnosticsOptions` requires `enabled: true`, `roles` and
  `permissions` exact-name to display-alias maps, and optional `policyRevision`. Every alias and the
  revision carry M98d's shape rule verbatim — non-empty UTF-8, 1–64 bytes, no control characters,
  unique within a map — so the five plans validate an alias identically. Accept 128 entries per map,
  16 evaluated steps/decision, 1,024 decisions retained, and 128/read. If any requested rule lacks
  an alias, the complete decision is dropped before buffering and a saturated counter increments;
  partial rule lists are never emitted. A granting principal role is included only when it has an
  approved role alias.

  `RbacService.hasAnyRole` and `hasAllPermissions` take an unbounded `readonly string[]`
  (`packages/auth-plugin/src/services/rbac-service.ts:162,174`), so a compound evaluation CAN exceed
  16 steps: `hasAnyRole` short-circuits on the first satisfying role, so overflow is reachable when
  the match sits past step 16 and on every unsatisfied compound over 16 inputs. The decision is then
  RETAINED with its real result and an explicit `stepsTruncated: true` plus `stepsEvaluated`, the
  true evaluated count; the step list holds only the first 16. It is not dropped, because the result
  is authoritative — the real service computed it — and an inspector that silently omits every large
  compound decision hides exactly the policies most worth explaining. The flag is required rather
  than inferable from `steps.length === 16`: a decision that evaluated exactly 16 steps is complete,
  and a consumer cannot tell the two apart without it. The devtool must not present a truncated
  trace as the explanation of the result.
- **Why:** Rule names and relationships can reveal security design; partial aliasing can still
  identify them by position. A trace that cannot show why is still worth keeping as long as it
  cannot claim to be complete.
- **Test home:** options, unapproved/drop, overflow and canary tests, including a `hasAnyRole` whose
  granting role sits past step 16 and an unsatisfied `hasAllPermissions` over 20 permissions — both
  asserting the correct result, `stepsTruncated: true`, the true `stepsEvaluated`, and exactly 16
  retained steps — beside a 16-step decision asserting `stepsTruncated: false`.

### 3.4 Actual-provider availability

- **Decision:** Add eager `CAPABILITIES.AUTHORIZATION_DIAGNOSTICS` (`authorization-diagnostics`) and
  `IAuthorizationDiagnosticsSource`. AuthPlugin always registers a source. It reports `disabled`
  without the option, `no-data` with active observed RBAC, `unsupported` with fixed coverage
  `rbac-not-configured`, `unsupported` with coverage `provider-identity-unavailable` when the
  registry lacks the optional identity predicate, and `unsupported` with coverage `custom-provider`
  when the current `CAPABILITIES.AUTHORIZATION` provider is not the exact RbacService instance the
  plugin created. Add this optional method to `IServiceRegistry`:

  ```typescript
  isCurrent?<T extends object>(token: CapabilityToken, instance: T): boolean;
  ```

  ServiceRegistry implements it as an identity comparison against the registration that `get` would
  select, without resolving a lazy factory, enumerating services, or exposing the current value.
  Keeping it optional avoids breaking third-party registry-shaped test/context implementations;
  AuthPlugin never falls back to resolving `get`. The enabled observer checks it before buffering
  and the source checks it again before every read. Absence latches `provider-identity-unavailable`;
  a false result latches `custom-provider`. Both are terminal for that source: detach, clear, and
  never resume even if startup code later restores the old registration. `collection-failed` remains
  reserved for failure in supported capture. Direct custom-service decisions are never guessed from
  booleans/status.
- **Why:** Records cannot claim to explain enforcement performed by a replacement service.
- **Test home:** registry non-resolution tests plus overrides during register, init, before and
  after AuthPlugin's bootstrap hook, and source reads before/after replacement.

### 3.5 Observer isolation

- **Decision:** Store the observer in a package-private WeakMap keyed by RbacService and attach it
  from AuthPlugin. Each public method computes its decision first, then invokes the observer inside
  `try/catch`, and returns the already-computed boolean unchanged. The observer's non-resolving
  `isCurrent` check happens before aliasing or buffering. Overflow, malformed aliases, source close
  and throwing observers only drop diagnostics. `onClose` detaches and clears the ring.
- **Why:** A diagnostic path cannot permit, deny, throw, or alter guard short-circuiting.
- **Test home:** observer-throw/full/closed parity tests through real guards and decorator
  middleware.

### 3.6 Fixed connector and client operation

- **Decision:** DiagnosticsPlugin optionally consumes the source and serves only canonical
  `GET /v1/authorization?after=N&limit=N`; absent source returns typed package `unsupported`.
  `AuthorizationDiagnosticsBatch` carries version, authenticated instance, state/coverage,
  decisions, next/lost/closed/droppedUnapproved. The projector copies exact own fields, catches
  source failures with fixed categories, and the client validates through
  `authorization(after, limit)`. It sets the fixed authenticated status manifest's `authorization`
  key true; a false key returns a frozen typed unsupported batch without sending the operation.
  `IAuthorizationDiagnosticsSource` exposes exactly:

  ```typescript
  read(instanceId: string, after: number, limit?: number): AuthorizationDiagnosticsBatch;
  ```

  The method is synchronous, requires a non-empty instance ID, accepts only a non-negative safe
  cursor and limit 1–128 (default 128), throws one fixed value-free `RangeError` otherwise, and
  returns a deeply frozen batch matching the supplied instance.

  Paging is M98a's committed cursor contract, adopted verbatim rather than restated — the same
  wording M98g adopts, so one paging model covers every capability. From
  `IDiagnosticsSource.read`/`DiagnosticsBatch`
  (`packages/common/src/services/diagnostics.ts:253-318`): `after` is EXCLUSIVE, so `decisions` are
  those whose sequence is strictly greater than it and `after: 0` starts at the oldest retained
  decision. A cursor older than the ring's oldest retained sequence is NOT an error — the read
  returns the oldest retained decisions and reports the gap in `lost`, which counts the sequences
  evicted between the requested cursor and the first returned record, and is therefore PER BATCH
  rather than cumulative. `next` is the last returned sequence, or the REQUESTED cursor when the
  batch is empty, so an idle poll re-sends the same cursor and cannot skip a decision that has not
  been recorded yet. A cursor beyond the current sequence is the one cursor that throws the fixed
  value-free `RangeError`. `closed` is `true` once §3.5's `onClose` detached the observer. The gap
  is exact rather than approximate, which is what makes it assertable: the reference implementation
  computes `start = max(after + 1, firstSequence)` and `lost = start - after - 1`
  (`packages/kernel/src/diagnostics/collector.ts:242-248`), and `after: 0` takes that same
  arithmetic with no special case — on an evicted ring it reports `firstSequence - 1`, not zero.
  `droppedUnapproved` is independent of `lost` and counts §3.3 approval drops, which consume no
  sequence: a decision refused for an unapproved rule alias is never assigned one, so it can neither
  appear in `lost` nor leave a hole a client could measure.
- **Why:** An authorization explanation is data-only and gains no policy-execution or mutation
  endpoint. Undefined paging is how a security view silently repeats or skips a decision; defining
  the eviction gap as reportable and per-batch is what lets a client say which decisions it never
  saw.
- **Test home:** protocol/connector/client/e2e security tests, including paging across eviction —
  overflow the 1,024-decision ring, resume from a pre-overflow cursor, and assert the oldest
  retained decisions with a per-batch `lost`; no DUPLICATE sequence across successive reads; a first
  returned sequence that MAY skip, with the gap `first - after - 1` EQUAL to that batch's `lost`,
  since the skip IS the eviction; every later sequence in the batch consecutive; an empty batch
  echoing its cursor; and a beyond-sequence cursor throwing. A security view must be able to say
  exactly how many decisions it did not see, so the equality is the assertion that matters.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                                  | Kind                      | Consumer / real code path that READS it                                            |
| ------------------------------------------------------------------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------- |
| Authorization diagnostic operation/reason/coverage types                                         | common types              | Collector, protocol/client and devtool explanation view.                           |
| `AuthorizationDecisionStep`, `AuthorizationDecisionObservation`, `AuthorizationDiagnosticsBatch` | common interfaces         | RBAC source and devtool.                                                           |
| `IServiceRegistry.isCurrent?`                                                                    | optional interface method | AuthPlugin verifies its known RbacService without resolving a replacement factory. |
| `IAuthorizationDiagnosticsSource`                                                                | common interface          | AuthPlugin provider and DiagnosticsPlugin consumer.                                |
| `CAPABILITIES.AUTHORIZATION_DIAGNOSTICS`                                                         | common token              | Same provider/consumer path.                                                       |
| `AuthorizationDiagnosticsOptions`                                                                | auth option type          | AuthPlugin validates and attaches collector.                                       |
| `IDiagnosticsClient.authorization`                                                               | interface method          | Native devtool reads decisions.                                                    |

`IServiceRegistry.isCurrent?(token, instance)` is read by AuthPlugin's enabled observer and source;
it never resolves a factory, and absence yields fixed unsupported coverage rather than a `get`
fallback. `IAuthorizationDiagnosticsSource.read(instanceId, after, limit?)` has the exact
synchronous contract in §3.6. `IDiagnosticsClient.authorization(after, limit?)` returns
`Promise<AuthorizationDiagnosticsBatch>`, applies the same cursor bounds, and negotiates support
before sending the operation.

Private evaluator results, WeakMap observer, collector, raw maps and projectors are not exported.

### 4.1 Options — every option names its consumer

| Option                       | Consumer            | Behavior (per implementation)                                         |
| ---------------------------- | ------------------- | --------------------------------------------------------------------- |
| `diagnostics.enabled: true`  | AuthPlugin          | Attaches collector only to authoritative first-party RBAC.            |
| `diagnostics.roles`          | evaluator projector | Approves/replaces requested and granting role names.                  |
| `diagnostics.permissions`    | evaluator projector | Approves/replaces requested permission names.                         |
| `diagnostics.policyRevision` | collector           | Adds one safe revision alias; never derives or hashes policy content. |

## 5. Implementation files

| File                                                                                                                           | Purpose                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `packages/common/src/registry.ts`, `src/services/diagnostics.ts`, `src/tokens.ts`, `src/index.ts`                              | Non-resolving identity method, authorization DTO/source contracts and token. |
| `packages/kernel/src/registry/service-registry.ts`                                                                             | Side-effect-free current-provider identity implementation.                   |
| `packages/auth-plugin/src/interfaces/index.ts`, `src/diagnostics/authorization-observation-collector.ts`                       | Options, bounded ring/source and attachment seam.                            |
| `packages/auth-plugin/src/services/rbac-service.ts`, `src/plugin/auth-plugin.ts`, `src/index.ts`                               | Single-pass evaluators, authoritative-provider check, lifecycle and exports. |
| `packages/diagnostics-plugin/src/interfaces/index.ts`, `src/plugin/diagnostics-plugin.ts`                                      | Client method, support key and optional source resolution.                   |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`, `src/transport/connector-handler.ts`, `src/client/client.ts`           | Authorization target, projection, dispatch and client.                       |
| `PUBLIC_API.md`, `ARCHITECTURE.md`, `docs/diagnostics-protocol.md`, package READMEs, `CHANGELOG.md`, `ROADMAP.md`, `CLAUDE.md` | Semantics, registry method, support and audit evidence.                      |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                              | src covered                              | Key assertions (and the signature each call type-checks against)                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/test/unit/registry-contract.test.ts`, `test/unit/diagnostics-contract.test.ts`, `test/unit/tokens.test.ts`, `test/unit/index.test.ts` | common registry/diagnostics/tokens/index | Optional identity method contract, source signature, types, exports and token.                                           |
| `packages/kernel/test/unit/registry/service-registry-current.test.ts`                                                                                  | service-registry                         | Exact identity, absent/multi/parent/override cases and proof that lazy factories are never invoked.                      |
| `packages/auth-plugin/test/unit/authorization-diagnostics-options.test.ts`, `test/unit/authorization-observation-collector.test.ts`                    | interfaces/collector                     | Alias/revision bounds, source read signature, ring/loss, absent identity predicate, replacement and canaries.            |
| `packages/auth-plugin/test/unit/rbac-service.test.ts`                                                                                                  | rbac-service                             | Existing boolean truth table plus direct/inherited/wildcard/deny reasons and exact evaluated steps.                      |
| `packages/auth-plugin/test/unit/auth-plugin.test.ts`, `test/unit/barrel-exports.test.ts`                                                               | plugin/index                             | Eager source; register/init/early-and-late-bootstrap replacement; detach/clear; exports.                                 |
| `packages/auth-plugin/test/unit/guards.test.ts`, `test/integration/auth-integration.test.ts`                                                           | rbac-service/collector through guards    | Same 401/403/next behavior with observer absent/enabled/throwing/full; one evaluation only.                              |
| `packages/decorator-plugin/test/unit/plugin/authorization-enforcement.test.ts`, `test/integration/roles-enforced.test.ts`                              | actual service path                      | Compound and permission short-circuits match actual calls; no fabricated branch.                                         |
| `packages/diagnostics-plugin/test/unit/protocol.test.ts`, `test/unit/connector-handler.test.ts`, `test/unit/plugin.test.ts`                            | protocol/connector/plugin                | Support key, canonical query, auth-before-read, exact projection, unsupported/source-failure handling.                   |
| `packages/diagnostics-plugin/test/unit/client.test.ts`, `test/index.test.ts`                                                                           | client/interfaces                        | False-key no-request, `authorization()` args, signed verification, exact DTO/instance checks.                            |
| `packages/diagnostics-plugin/test/e2e/authorization-explanations.test.ts`                                                                              | all paths                                | Real socket/guards; positive reasons; JWT/principal/claim/request/error canaries absent; custom replacement unsupported. |

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
- A truncated trace reads as the whole explanation: retain the real result but require
  `stepsTruncated`, so a partial step list can never be presented as complete (§3.3). The
  accompanying `stepsEvaluated` is a saturating count and never a name, so it discloses the size of
  a compound check and nothing about unapproved rules.
- Replaced provider is misrepresented: use non-resolving exact identity checks before capture and
  reads, then latch unsupported and clear.

## 9. Out of scope

- Authentication failures, tokens, claims, principal/resource inspection, and route/request
  correlation.
- Custom policy explanation adapters and hypothetical decision simulation.
- Full policy graph serialization or unapproved rule names.

## 10. Design security review — completed before implementation

**Reviewed flow:** authoritative RBAC method → private evaluator result → alias-only guarded
observer → non-resolving current-provider identity check → bounded ring → repeated provider check at
source read → authenticated fixed connector → signed frame → validating client. The principal is
used by the evaluator but is not an observer argument; minimization occurs before retention.

**Approved budgets:** 128 role aliases, 128 permission aliases, 16 steps/decision, 1,024 records,
128/read, 64-byte aliases/revision and 256 KiB/frame. Disabled, no-policy, identity-unavailable and
replaced-provider modes retain no decision ring.

| Finding                                                         | Resolution in this plan                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Calling authorization again can change results or side effects. | Explain the same private evaluator result; never replay.                                  |
| A 403 cannot identify the failed rule.                          | Capture only at the actual RBAC service, never infer from HTTP status.                    |
| Custom providers expose booleans only.                          | Non-resolving exact-provider checks before capture/read; replacement latches unsupported. |
| Names and principal roles reveal policy/identity.               | Approved aliases only; principal, claims and unapproved granting roles are absent.        |
| An `onBootstrap` check can precede a later override.            | Check at every capture/read; do not treat hook order as final-provider proof.             |

The implementation audit compares observed and returned decisions for direct/inherited/wildcard/deny
and compound short-circuits, including custom replacement. It plants canaries in JWTs, IDs, roles,
permissions, claims, requests, resources and thrown values; checks observer calls, ring, frames,
errors and logs; proves a lazy custom provider is never constructed by diagnostics, exercises a
replacement in a later bootstrap hook, proves useful approved explanations survive, and repeats
every M98b credential/replay/origin/authority/expiry/revocation/ instance/version/mutation refusal
for `/v1/authorization`.
