# Milestone 90c — Credential Revocation and Token Type (`@setu-ts/auth-plugin`)

> **Status:** Complete (PR pending). Branch: `feat/m90c-integrity-recovery`. `main` is protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Close the four M90c auth findings: a refresh-token logout must revoke the paired access credential
when the application configures the same bounded revocation store in `AuthPlugin` and
`RefreshTokenService`; bearer authentication must reject a token whose signed `type` is `refresh`; a
replayed refresh token must revoke every issued descendant in its family; and authorization guards
must answer a generic 403 detail rather than disclose role or permission policy names. The
revocation store is deliberately application supplied and optional, preserving stateless JWT
deployments while making stateful logout real and explicit.

- **In scope:** Access-token `jti`/`type` claims for pairs from `RefreshTokenService`; an exported
  bounded access-token revocation-store port and memory implementation; refresh-family
  lineage/cascade revocation; optional shared-store wiring in `JwtOptions` and
  `RefreshTokenOptions`; JWT-strategy checks; generic 403 details in auth and the dependent
  decorator enforcement seam; all supporting docs and changelog entries.
- **NOT this milestone:** A distributed access-token revocation implementation (the new port is its
  extension point); session-credential revocation (already owned by M73/session-plugin); rate
  limiting (M90a); and OAuth/OIDC token exchange.

## 1. Contracts verified from SOURCE (not names)

| Reference                 | Source (file:line)                                                       | Verified surface / fact                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IJwtService`             | `packages/common/src/services/auth.ts:37-71`                             | `sign(payload, options)`, `verify<T>(token)`, and `decode<T>(token)` are its entire committed surface; no revocation hook exists.                |
| `IAuthStrategy`           | `packages/common/src/services/auth.ts:103-118`                           | Passive authentication returns `Promise<IPrincipal \| null>` from `authenticate(request)`.                                                       |
| `JwtOptions`              | `packages/auth-plugin/src/interfaces/index.ts:14-31`                     | JWT configuration already owns bearer header/scheme and is the appropriate opt-in location for the strategy's revocation store.                  |
| `JwtStrategy`             | `packages/auth-plugin/src/strategies/jwt-strategy.ts:12-74`              | It verifies bearer JWTs then maps claims; today every successfully verified token, including `type: 'refresh'`, becomes a principal.             |
| `RefreshTokenService`     | `packages/auth-plugin/src/services/refresh-token-service.ts:75-181`      | It currently gives only the refresh JWT a `jti`/`type`, revokes one record on rotation/logout, and issues its successor without lineage.         |
| `RefreshTokenStore`       | `packages/auth-plugin/src/stores/refresh-token-store.ts:12-43`           | Store records have one `jti`; `get` retains revoked records; `revoke(jti)` only addresses one record.                                            |
| `MemoryRefreshTokenStore` | `packages/auth-plugin/src/stores/refresh-token-store.ts:53-85`           | The shipped store is an in-process map with lazy expiry, so it can implement family scans without new dependencies.                              |
| Guard error seam          | `packages/auth-plugin/src/guards/index.ts:96-249`                        | All four authorization guards use `respondWithError`; their 403 details currently interpolate roles/permissions.                                 |
| Plugin construction       | `packages/auth-plugin/src/plugin/auth-plugin.ts:52-148`                  | `AuthPlugin` constructs the JWT strategy while `RefreshTokenService` is app-instantiated, so a shared option—not a hidden singleton—is required. |
| Decorator enforcement     | `packages/decorator-plugin/src/plugin/authorization-middleware.ts:1-105` | Decorated routes intentionally answer byte-identically with auth guards through a separate package-boundary implementation.                      |
| Existing public docs      | `PUBLIC_API.md:2076-2121`; `packages/auth-plugin/README.md:238-274`      | Refresh service is documented as app-instantiated and store-backed; the docs must show explicitly sharing a revocation store with `AuthPlugin`.  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                     | Resolution (picked side)                                                                                                                   | Doc deliverable (same PR)                                                     |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| C1 | None found: the current source and the auth README/PUBLIC_API describe per-`jti` refresh revocation, rather than claiming access-token or family revocation. | Source is the baseline; expand the living documentation to state the new, opt-in shared-store behavior and its bounded-expiry requirement. | Update `packages/auth-plugin/README.md`, `PUBLIC_API.md`, and `CHANGELOG.md`. |

## 3. Design decisions

### 3.1 Shared bounded access-token revocation

- **Decision:** Add exported `IAccessTokenRevocationStore` (`revoke(jti, expiresAt)` /
  `isRevoked(jti)`) and `MemoryAccessTokenRevocationStore`. Both `JwtOptions` and
  `RefreshTokenOptions` receive the same optional `accessTokenRevocationStore` instance.
  `RefreshTokenService` refuses that option unless `accessToken.expiresIn` is set, then stores a
  revocation entry only through the access credential's expiry; `JwtStrategy` consults it for a
  signed access-token `jti` after cryptographic verification.
- **Why:** The plugin and refresh service cannot safely share hidden state, and a store entry must
  expire with the credential it invalidates to stay bounded. An explicit injected port lets
  Redis/database implementations serve multi-instance applications without an npm dependency.
- **Test home:** `test/unit/access-token-revocation-store.test.ts`,
  `test/unit/refresh-token-service.test.ts`, `test/unit/jwt-strategy.test.ts`,
  `test/unit/auth-plugin.test.ts`, and `test/integration/refresh-rate-limit-integration.test.ts`.

### 3.2 Token use and bearer mapping

- **Decision:** Every pair minted by `RefreshTokenService` carries distinct random `jti`s and
  explicit signed `type: 'access'` or `type: 'refresh'`. `JwtStrategy` rejects exactly
  `type: 'refresh'`, preserving already-documented direct `IJwtService.sign({ sub: ... })`
  access-token flows; `type` and `jti` are omitted from `IPrincipal.claims`.
- **Why:** A refresh JWT has an authoritative type already, so rejecting it closes X22-2 without
  silently breaking existing manually minted access tokens. Pair tokens become unambiguous and
  revocable.
- **Test home:** `test/unit/jwt-strategy.test.ts` and `test/unit/refresh-token-service.test.ts`.

### 3.3 Refresh-family replay and logout

- **Decision:** Add optional lineage fields to `RefreshTokenRecord` (`familyId`, access `jti`, and
  access expiry), required atomic `rotate(jti, successor)` to `RefreshTokenStore`, and required
  family-linearizable `revokeFamily(jti)`. `rotate` conditionally consumes a live parent and stores
  its successor as one operation; a concurrent caller observes the revoked parent, then revokes the
  whole family. Replay and logout call `revokeFamily`, then revoke each returned access `jti`
  through the optional access revocation store.
- **Why:** A separate async `get` then `revoke` lets two remote callers mint descendants from one
  parent. Atomic rotation preserves single-use credentials. Returning affected records keeps the
  refresh store focused on lineage and the separate revocation port focused on access credentials.
- **Test home:** `test/unit/memory-refresh-token-store.test.ts`,
  `test/unit/refresh-token-service.test.ts`, and
  `test/integration/refresh-rate-limit-integration.test.ts`.

### 3.4 Forbidden response confidentiality

- **Decision:** All four policy-failure guard paths retain status 403/title `Forbidden`,
  short-circuiting behavior, and configured error formatting, but use the constant detail
  `Insufficient privileges` rather than interpolate role or permission requirements. Apply the same
  detail in decorator-plugin's deliberately byte-identical enforcement seam.
- **Why:** Authorization policy names are deployment information and should not be disclosed to a
  caller who already failed the policy.
- **Test home:** `test/unit/guards.test.ts` and `test/unit/guard-format.test.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                      | Kind                      | Consumer / real code path that READS it                                                                                                  |
| -------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `IAccessTokenRevocationStore`                                        | interface                 | `JwtStrategy` reads `isRevoked`; `RefreshTokenService` calls `revoke`; application supplies an implementation.                           |
| `MemoryAccessTokenRevocationStore`                                   | class                     | Application can construct the single-process implementation; its methods implement the two production call paths above.                  |
| `AuthPlugin`                                                         | function                  | Application plugin registration constructs `JwtStrategy` with JWT options.                                                               |
| `AuthPluginOptions`, `JwtOptions`                                    | interfaces                | Application configures the plugin; the plugin reads `jwt.accessTokenRevocationStore`.                                                    |
| `RefreshTokenService`, `RefreshTokenOptions`, `TokenPair`            | class/interfaces          | Login, refresh, and logout route handlers issue/revoke pairs; service reads its supplied store.                                          |
| `RefreshTokenStore`, `RefreshTokenRecord`, `MemoryRefreshTokenStore` | interface/interface/class | Refresh service atomically rotates lineage and calls `revokeFamily`; application can supply a durable implementation.                    |
| Existing auth exports                                                | functions/classes/types   | Unchanged exported guards, middleware, rate-limit, password, and common-contract re-exports retain their existing application consumers. |

### 4.1 Options — every option names its consumer

| Option                                                        | Consumer                               | Behavior (per implementation)                                                                                                               |
| ------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `jwt.accessTokenRevocationStore?`                             | `AuthPlugin` → `JwtStrategy`           | When present, a verified typed access token with a `jti` is refused if `isRevoked(jti)` is true; absent preserves stateless authentication. |
| `accessTokenRevocationStore?`                                 | `RefreshTokenService`                  | Requires `accessToken.expiresIn`; logout/replay writes access identifiers through their expiry; absent retains refresh-only behavior.       |
| `RefreshTokenRecord.familyId?`                                | `MemoryRefreshTokenStore.revokeFamily` | Service-issued records share a family; old custom records fall back to their own `jti` as a one-member family.                              |
| `RefreshTokenRecord.accessTokenJti?`, `accessTokenExpiresAt?` | `RefreshTokenService`                  | Service reads them from the records returned by family revocation and skips absent legacy fields safely.                                    |

## 5. Implementation files

| File                                                               | Purpose                                                                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `src/stores/access-token-revocation-store.ts`                      | New bounded revocation port and in-memory implementation.                                                       |
| `src/stores/refresh-token-store.ts`                                | Add lineage metadata and family-revocation contract/memory behavior.                                            |
| `src/services/refresh-token-service.ts`                            | Mint typed/jti-bearing pairs, calculate access expiry, rotate or revoke families, and write access revocations. |
| `src/strategies/jwt-strategy.ts`                                   | Reject refresh-type bearer tokens and check the optional revocation port.                                       |
| `src/interfaces/index.ts`                                          | Add the optional shared revocation-store JWT option.                                                            |
| `src/plugin/auth-plugin.ts`                                        | Pass configured revocation store into the JWT strategy.                                                         |
| `src/guards/index.ts`                                              | Use one generic forbidden detail for every policy failure.                                                      |
| `packages/decorator-plugin/src/plugin/authorization-middleware.ts` | Keep decorator-enforced policy failures byte-identical with auth guards.                                        |
| `src/index.ts`                                                     | Export the new store contract and memory implementation.                                                        |
| `README.md`, `PUBLIC_API.md`, `CHANGELOG.md`                       | Document configuration, behavior, added public surface, and migration impact.                                   |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                           | src covered                                            | Key assertions (and the signature each call type-checks against)                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/access-token-revocation-store.test.ts`                                                                                                   | `src/stores/access-token-revocation-store.ts`          | `revoke(jti, expiresAt)` marks only until `runtime.now() >= expiresAt`; `isRevoked(jti)` lazily removes expired values.                                                                                                               |
| `test/unit/memory-refresh-token-store.test.ts`                                                                                                      | `src/stores/refresh-token-store.ts`                    | Atomic `rotate(jti, successor)` admits one concurrent consumer, and `revokeFamily(jti): Promise<readonly RefreshTokenRecord[]>` revokes all matching family records, returns them, and treats legacy/no-family records as singletons. |
| `test/unit/refresh-token-service.test.ts`                                                                                                           | `src/services/refresh-token-service.ts`                | Issued pairs have distinct typed JTIs; configuration without access expiry throws when a revocation store is supplied; logout/replay revokes paired/descendant access ids; normal rotation leaves the new pair usable.                |
| `test/unit/jwt-strategy.test.ts`                                                                                                                    | `src/strategies/jwt-strategy.ts`                       | `authenticate(request): Promise<IPrincipal \| null>` rejects `type: 'refresh'`, rejects revoked typed access IDs, and preserves direct token compatibility.                                                                           |
| `test/unit/auth-plugin.test.ts`                                                                                                                     | `src/interfaces/index.ts`, `src/plugin/auth-plugin.ts` | The configured `jwt.accessTokenRevocationStore` reaches the registered passive strategy and absent option changes no setup.                                                                                                           |
| `test/unit/guards.test.ts`, `test/unit/guard-format.test.ts`                                                                                        | `src/guards/index.ts`                                  | Each failed role/permission guard is 403, does not call next, preserves configured formats, and never includes policy names.                                                                                                          |
| `packages/decorator-plugin/test/unit/plugin/authorization-enforcement.test.ts`, `packages/decorator-plugin/test/integration/roles-enforced.test.ts` | decorator authorization middleware                     | Decorator spelling keeps the generic detail and remains byte-identical with `requireRole`.                                                                                                                                            |
| `test/unit/barrel-exports.test.ts`                                                                                                                  | `src/index.ts`                                         | New port/type/class are publicly reachable alongside all existing exports.                                                                                                                                                            |
| `test/integration/refresh-rate-limit-integration.test.ts`                                                                                           | service + plugin wiring                                | A shared memory store permits a fresh access credential, rejects it after logout, and rejects a descendant family after replay.                                                                                                       |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m90c-integrity-recovery, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

## 8. Risks & mitigations

- A revocation list with no expiry leaks memory indefinitely → require `accessToken.expiresIn`,
  reject non-finite entries, and sweep expired in-memory entries on every store operation.
- A custom refresh store may hold legacy records with no lineage → type optional fields and treat a
  missing family ID as a one-record family; document the required atomic `rotate` and `revokeFamily`
  implementations for durable stores.
- Multi-instance logout is ineffective with separate process-local stores → label the memory
  implementation single-process and direct deployments to provide one shared durable implementation
  to both constructors.
- Policy response refactoring can accidentally alter status/body-format behavior → keep
  `respondWithError` and cover all guards, decorator, and format paths in existing tests.

## 9. Out of scope

- A Redis or database implementation of `IAccessTokenRevocationStore`; applications supply it until
  a dedicated adapter milestone owns one.
- Bulk/user-wide credential invalidation and admin session management.
- Altering generic `IJwtService` verification; the optional strategy seam avoids a `common` contract
  change.
