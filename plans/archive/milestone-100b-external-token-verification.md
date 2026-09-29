# Milestone 100b — Tokens From an Outside Issuer (`@setu-ts/auth-plugin`)

> **Status:** Complete on `feat/m100b-external-token-verification`. Depends on 100a.

## 0. Objective & scope

Let an API accept access tokens issued by an outside identity provider — Auth0, Entra ID, Google,
Keycloak, Cognito — by verifying them against that provider's published key set, which rotates.
Today `JwtService` verifies only its own tokens, with one static key, over two algorithms.

- **In scope:** an `issuers` option; OpenID discovery of the key-set URL; key-set fetching, caching
  and rotation; RS256, PS256, ES256, ES384 and EdDSA (Ed25519) verification over `runtime.subtle`;
  claim validation with clock skew; an injectable HTTP seam; an `auth` health indicator reporting
  cached key-set state; a real-provider test against Keycloak.
- **NOT this milestone:** signing in a user through a provider (100c, which reuses this verifier);
  RS384/RS512/PS384/PS512/ES512 (not probed on every runtime — additive later); token introspection
  (RFC 7662) for opaque tokens; `typ: at+jwt` (RFC 9068) enforcement; mTLS-bound tokens.

## 1. Contracts verified from SOURCE (not names)

| Reference                  | Source (file:line)                                                           | Verified surface / fact                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JwtService.verify`        | `packages/auth-plugin/src/services/jwt-service.ts:118-190`                   | One configured algorithm (`'HS256' \| 'RS256'`), one cached verify key; `exp`/`nbf` checked with no skew; `aud`/`iss` exact.                     |
| `JwtStrategy`              | `packages/auth-plugin/src/strategies/jwt-strategy.ts:60-90`                  | Maps `sub`/`roles`/`permissions` + remaining claims; any verify failure returns `null` (never throws).                                           |
| Strategy chain order       | `packages/auth-plugin/src/plugin/auth-plugin.ts:106-167`                     | jwt → api-key → session → caller strategies; duplicate strategy names throw at `register()`.                                                     |
| `IAuthStrategy`            | `packages/common/src/services/auth.ts:110`                                   | `name` + `authenticate(request): Promise<IPrincipal \| null>`.                                                                                   |
| `IPrincipal`               | `packages/common/src/services/auth.ts:16`                                    | `id`, optional `roles`, `permissions`, `claims`.                                                                                                 |
| `IRuntimeServices`         | `packages/common/src/runtime.ts:309-379`                                     | `subtle`, `hrtime()` (monotonic), `now()`, `setTimeout`/`clearTimeout`.                                                                          |
| HTTP seam precedent        | `packages/notification-plugin/src/interfaces/index.ts:176`                   | `INotificationHttp` — injectable, defaults to `fetch`; the M30/M50 pattern this plan follows.                                                    |
| Degraded health            | `packages/health-plugin/src/plugin/health-plugin.ts:290,311`                 | `degraded` answers 200 on `/health` and `/ready`; only `down` answers 503.                                                                       |
| Health claim table         | `packages/cli/src/utils/plugin-claims.ts`, `test/plugin-claims-gate.test.ts` | Every `ctx.health.register` name must appear in the CLI table or the root gate fails; `auth-plugin` has no entry today.                          |
| Web Crypto support (probe) | measured, Deno 2.9.6 / Node 24.18 / Bun 1.4.2 / workerd (wrangler dev)       | RS256, PS256, ES256, ES384, Ed25519 each generated, exported as JWK, re-imported from JWK and verified — `ok` on all four runtimes.              |
| Keycloak 26.4 (probe)      | `quay.io/keycloak/keycloak:26.4 start-dev`, ready in 11 s                    | Discovery document returns `issuer`, `jwks_uri`; the key set carries TWO RSA keys: one `alg: RS256` and one `alg: RSA-OAEP` (an encryption key). |

The Keycloak key set is the reason §3.4 filters by `use`, `alg` and `key_ops`: an encryption key
must never be used to verify a signature, whatever its `kid`.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                            | Resolution (picked side)                                                                 | Doc deliverable (same PR)                                                                        |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| C1 | `auth-plugin` README and `PUBLIC_API.md` describe authentication as "JWT and API key", with no statement that only self-issued tokens are accepted. | Document both paths: `jwt` for tokens this app issues, `issuers` for tokens it does not. | README "Accepting tokens from an identity provider" section; `PUBLIC_API.md` AuthPlugin options. |
| C2 | `ARCHITECTURE.md` auth row lists `IJwtService` as the verification surface.                                                                         | `issuers` is a strategy, not a new service; `IJwtService` stays self-issued only.        | One sentence in the ARCHITECTURE auth row.                                                       |

## 3. Design decisions

### 3.1 One strategy, routed by issuer

- **Decision:** `AuthPluginOptions.issuers?: readonly TrustedIssuer[]` builds ONE internal
  `IssuerStrategy` named `issuers`, inserted immediately after the JWT strategy. It reads the same
  header and scheme as `jwt` (default `Authorization: Bearer`), decodes the payload WITHOUT trusting
  it only to read `iss`, selects the configured issuer whose `issuer` string matches exactly, and
  verifies. No match → `null`, the chain continues.
- **Why:** A token names its issuer; trying every issuer's keys would multiply work and error noise.
  Decoding to route is safe because nothing from the unverified payload is used except as a lookup
  key into configuration.
- **Test home:** `issuer-strategy.test.ts` (routing, unknown issuer, mixed jwt+issuers chain).

### 3.2 `TrustedIssuer` shape and refusals

- **Decision:**
  `{ name, issuer, audience, keys: { jwksUri } | { discovery: true }, algorithms?,
  clockToleranceSec?, toPrincipal }`.
  `audience` is REQUIRED: without it, any token the same provider minted for a different API would
  be accepted (the confused-deputy case). `toPrincipal(
  claims)` is required (the M73 precedent —
  the plugin never guesses where a vendor puts roles). Construction throws on: duplicate `name`,
  duplicate `issuer`, an empty `audience`, an algorithm outside the five supported, and a
  non-`https` key or discovery URL whose host is not loopback.
- **Why:** Every refusal is a configuration that would silently weaken verification.
- **Known gap, named rather than hidden:** without RFC 9068 `typ: at+jwt` enforcement (out of scope,
  §0), a provider's ID token whose `aud` is the configured `audience` verifies as an access token.
  That happens when an API reuses its own client id as its audience. The README tells applications
  to give the API its own audience (resource identifier) distinct from any sign-in client id, and
  `toPrincipal` receives the full claims, so an application can refuse ID-token-only claims itself.
- **Test home:** `trusted-issuer-options.test.ts`.

### 3.3 Discovery

- **Decision:** `discovery: true` fetches `<issuer>/.well-known/openid-configuration`, built after
  removing ONE terminating `/` from the issuer (OIDC Discovery §4 — Auth0 issuers end in `/`, and a
  naive join yields `…//.well-known`), requires the document's `issuer` to equal the configured one
  exactly (OpenID Connect Discovery §4.3 — a mismatch means a spoofed or misrouted document) and
  reads `jwks_uri`, which must pass the same https-or-loopback rule. Failure is a refresh failure
  (§3.5), not a startup error, retried under the same `minRefreshIntervalMs` cooldown as a key-set
  fetch; a successful document is cached for the key-set TTL. The whole document is kept (not only
  `jwks_uri`), because 100c reads `authorization_endpoint`, `token_endpoint` and
  `end_session_endpoint` from the same cache.
- **Multi-tenant Entra ID is NOT supported:** its `common`/`organizations` discovery documents carry
  `issuer: …/{tenantid}/v2.0`, a template that cannot equal a configured issuer. A single-tenant
  Entra issuer works; the README says which.
- **Test home:** `discovery.test.ts`.

### 3.4 Key selection and algorithm checks — before any key is used

- **Decision:** Per token: the header `alg` must be in the issuer's allowlist (default all five);
  `none` and every `HS*` are refused unconditionally, before key lookup, because an issuer key set
  is asymmetric and accepting an HMAC `alg` against a public key is the algorithm-confusion attack.
  Candidate keys are those whose `kty` matches the `alg` AND whose `crv` matches it for EC and OKP
  keys (ES256 ↔ P-256, ES384 ↔ P-384, EdDSA ↔ Ed25519 — without the `crv` check an ES256 token would
  be verified against a P-384 key, which Web Crypto accepts once the key is imported by its own
  curve), whose `use` is absent or `sig`, whose `alg` (when present) equals the token's, and whose
  `key_ops` (when present) include `verify`. With a `kid` the candidate must match it; without a
  `kid` there must be exactly one candidate. ECDSA signatures are the raw `r‖s` form, which is what
  Web Crypto's `ECDSA` verify expects, so no DER conversion is needed. PS256 verifies with
  `{ name: 'RSA-PSS', saltLength: 32 }` (RFC 7518 §3.5: salt length equals the hash length). The
  `EdDSA` allowlist entry also admits the fully-specified `alg: 'Ed25519'` (RFC 9864), since
  providers are moving to that spelling; both require an `OKP`/`Ed25519` key.
- **Test home:** `key-selection.test.ts` — includes a Keycloak-shaped set with an `enc` key sharing
  a `kid` pattern, an `HS256` token signed with the public key's bytes as the secret, an ES256 token
  whose only candidate is a P-384 key (refused), a PS256 round trip, and an `alg: 'Ed25519'` token.

### 3.5 Key-set cache, rotation and bounds

- **Decision:** One cache entry per issuer, timed on `runtime.hrtime()` (monotonic). The three
  timings are per-issuer options under `TrustedIssuer.keySet` — `ttlMs` (default 10 minutes),
  `minRefreshIntervalMs` (default 60 s), `fetchTimeoutMs` (default 5 s) — each validated as a finite
  positive number at construction (the M90a `NaN` lesson). They are options rather than constants
  because the Keycloak rotation e2e must shorten the cooldown to run in seconds. An unknown `kid`
  triggers at most one refetch per `minRefreshIntervalMs`, so a stream of forged `kid`s cannot turn
  requests into outbound fetches. Concurrent misses share one in-flight fetch. On fetch failure the
  last good set is kept, but only up to `keySet.maxStaleMs` (default 24 hours) past the moment it
  was last confirmed current; beyond that the set is dropped and every token from that issuer is
  refused until a fetch succeeds. Without the cap, a key the provider removed after a compromise
  would keep authenticating for as long as its key-set endpoint stayed unreachable — which an
  attacker able to block that endpoint could arrange. The health indicator reports `expired` for
  such an issuer. Each fetch is bounded by `fetchTimeoutMs` (via `AbortSignal` and `runtime`
  timers), a 64 KiB response limit and a 64-key limit; exceeding one of them is a refresh failure.
  The byte limit is enforced BY THE SEAM while reading (§3.8), not after — a limit checked on a
  finished `string` has already buffered the oversized body it exists to refuse.
- **Why:** A key set that expires hard during a provider outage would sign every user out.
- **Test home:** `key-set-cache.test.ts` with a fake clock and a fake HTTP seam.

### 3.6 Claim validation

- **Decision:** `iss` exact; `aud` contains the configured audience (string or array); `exp`
  required; `exp`, `nbf` and a future `iat` checked with `clockToleranceSec` (default 30).
  Construction refuses a `clockToleranceSec` that is not a finite number in `[0, 300]`: every claim
  check is a comparison, and a comparison against `NaN` is always `false`, so `NaN` (what
  `Number(env.X)` yields for an unset variable) would silently disable `exp`/`nbf`/`iat` — the M90a
  fail-open class — and `Infinity` would do the same honestly. The same finite-positive rule already
  covers the three `keySet` timings and `maxStaleMs`. Verification failures return `null` and are
  logged at `debug` with a fixed reason code — never the token — through a logger thunk read at call
  time (the M52b lesson).
- **Test home:** `claims.test.ts`.

### 3.7 Health

- **Decision:** When `issuers` is configured, the plugin registers an `auth` indicator. It reads
  only cached state, performs no I/O, and reports `up` when every issuer has a current set,
  `degraded` with `{ issuers: { <name>: 'stale' | 'unfetched' } }` otherwise — never `down`, because
  an identity-provider outage must not restart the application. `auth` is added to the CLI claim
  table.
- **Test home:** `issuers-health.test.ts`; `test/plugin-claims-gate.test.ts` (existing gate).

### 3.8 HTTP seam

- **Decision:** `AuthPluginOptions.http?: IAuthHttp` —
  `get(url, { signal, maxBytes }) → { status, body: string }` — defaulting to
  `createDefaultAuthHttp()` over `fetch` (internal seam, unit-tested directly). The default reads
  the body stream, cancels it and rejects with a size error the moment the running total passes
  `maxBytes` (the M90a `maxBodyBytes` shape — cancel, never abandon), and never calls `text()`. 100c
  reuses it for its token endpoint by adding `post`.
- **Test home:** `auth-http.test.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol   | Kind | Consumer / real code path that READS it                                    |
| ----------------- | ---- | -------------------------------------------------------------------------- |
| `TrustedIssuer`   | type | `AuthPluginOptions.issuers`; applications declare one per provider.        |
| `IssuerKeySource` | type | `TrustedIssuer.keys` (`{ jwksUri }` \| `{ discovery: true }`).             |
| `IssuerAlgorithm` | type | `TrustedIssuer.algorithms` allowlist.                                      |
| `IAuthHttp`       | type | `AuthPluginOptions.http`; tests and applications behind a proxy inject it. |

### 4.1 Options — every option names its consumer

| Option                            | Consumer                    | Behavior (per implementation)                                           |
| --------------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `issuers`                         | `register()` chain assembly | Builds the `issuers` strategy (§3.1).                                   |
| `TrustedIssuer.audience`          | claim validation            | Required; must be contained in `aud` (§3.6).                            |
| `TrustedIssuer.algorithms`        | key selection               | Allowlist, default all five (§3.4).                                     |
| `TrustedIssuer.clockToleranceSec` | claim validation            | Default 30 (§3.6).                                                      |
| `TrustedIssuer.keySet`            | key-set cache               | `ttlMs`, `minRefreshIntervalMs`, `fetchTimeoutMs`, `maxStaleMs` (§3.5). |
| `TrustedIssuer.toPrincipal`       | strategy                    | Maps verified claims; `null` → anonymous.                               |
| `http`                            | key-set fetcher             | Replaces the default `fetch` seam (§3.8).                               |

## 5. Implementation files

| File                                                     | Purpose                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/auth-plugin/src/index.ts`                      | Export the four types.                                                                 |
| `packages/auth-plugin/src/interfaces/index.ts`           | `TrustedIssuer`, `IssuerKeySource`, `IssuerAlgorithm`, `IAuthHttp`, `issuers`, `http`. |
| `packages/auth-plugin/src/strategies/issuer-strategy.ts` | Routing and claim validation (§3.1, §3.6).                                             |
| `packages/auth-plugin/src/issuers/key-set-cache.ts`      | Fetch, cache, rotation, bounds (§3.3, §3.5).                                           |
| `packages/auth-plugin/src/issuers/key-selection.ts`      | Algorithm and key checks, JWK import (§3.4).                                           |
| `packages/auth-plugin/src/issuers/auth-http.ts`          | Default HTTP seam (§3.8).                                                              |
| `packages/auth-plugin/src/plugin/auth-plugin.ts`         | Option validation, chain insertion, health (§3.2, §3.7).                               |
| `packages/cli/src/utils/plugin-claims.ts`                | Add `['auth-plugin', ['auth']]`.                                                       |
| CI (`ci.yml`, `release.yml`), `test/apps-gate.test.ts`   | Keycloak container step and its pin.                                                   |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                         | src covered          | Key assertions                                                                                                                                                                                                              |
| ------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/issuer-strategy.test.ts`               | `issuer-strategy.ts` | Routes by `iss`; unknown issuer → null; a self-issued JWT still authenticates first; malformed token → null.                                                                                                                |
| `test/unit/key-selection.test.ts`                 | `key-selection.ts`   | Real-crypto round trip per algorithm; `none`/`HS256` refused; `enc` key ignored; `kid`-less multi-key refused.                                                                                                              |
| `test/unit/key-set-cache.test.ts`                 | `key-set-cache.ts`   | TTL on a fake monotonic clock; refetch cooldown; coalescing; last-good on failure, then dropped past `maxStaleMs` (token refused); size and key-count limits.                                                               |
| `test/unit/discovery.test.ts`                     | `key-set-cache.ts`   | Issuer mismatch refused; non-https refused; loopback allowed; a trailing-`/` issuer builds one `/.well-known` path; failed discovery retried only after the cooldown.                                                       |
| `test/unit/claims.test.ts`                        | `issuer-strategy.ts` | `aud` array/string; `exp` required; skew both sides; future `iat`; `clockToleranceSec` of `NaN`, `Infinity`, `-1` and `301` refused at construction.                                                                        |
| `test/unit/auth-http.test.ts`                     | `auth-http.ts`       | Default seam: status, body, abort on timeout; a body past `maxBytes` rejects and the source stream is cancelled (a never-ending fake stream would hang otherwise).                                                          |
| `test/unit/trusted-issuer-options.test.ts`        | `auth-plugin.ts`     | Every §3.2 refusal by name.                                                                                                                                                                                                 |
| `test/integration/issuers-health.test.ts`         | `auth-plugin.ts`     | Real kernel app: `up`, `degraded` stale/unfetched, never `down`; no fetch during a probe.                                                                                                                                   |
| `test/e2e/keycloak-issuer-real.test.ts` (guarded) | all                  | Real Keycloak realm (committed import JSON): a client-credentials token authenticates; a token for another client's audience does not; key rotation via the admin API is picked up. `ignore:` when `KEYCLOAK_URL` is unset. |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m100b-external-token-verification
deno task check:plan
deno task fmt:check && deno task lint && deno task check && deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% every changed src file
deno task check:docs
deno task publish:check && deno task release:verify <version>
```

## 8. Risks & mitigations

- Multi-tenant Entra ID (`{tenantid}` issuer template) → refused by exact issuer matching; stated in
  the README (§3.3). Supporting it is an additive `issuer` pattern with its own design review.
- A provider publishing an algorithm outside the five → its tokens are refused, not mis-verified;
  the refusal is logged with the algorithm so the operator can see it.
- The Keycloak suite skips silently if CI drops the container → the service, port and variable are
  pinned in `test/apps-gate.test.ts` (the M53 precedent), and it is not in `ALLOW_SKIP`.

## 9. Out of scope

- Opaque-token introspection, RFC 9068 `typ` enforcement, sender-constrained tokens — no current
  consumer; each is additive to `TrustedIssuer`.
- Signing in through a provider — 100c.

## 10. Design security review — completed before implementation

**Reviewed flow:** request header → unverified decode for `iss` only → configuration lookup →
algorithm allowlist → key filter (`kty`, `use`, `alg`, `key_ops`, `kid`) → signature verify → claim
checks → `toPrincipal`.

| Finding                                                  | Resolution in this plan                                     |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| Algorithm confusion (`HS256` over a public key, `none`). | Refused before key lookup (§3.4).                           |
| Encryption key reused for signatures.                    | `use`/`key_ops` filter; Keycloak-shaped fixture (§1, §3.4). |
| Token for another API at the same provider.              | `audience` required and checked (§3.2, §3.6).               |
| Spoofed discovery document.                              | `issuer` equality and https-or-loopback (§3.3).             |
| Forged `kid` flood causing outbound fetches.             | One refetch per cooldown, coalesced (§3.5).                 |
| Removed key trusted indefinitely while fetches fail.     | `maxStaleMs` cap on the last good set (§3.5).               |
| `NaN` skew disabling time checks.                        | `clockToleranceSec` validated finite and bounded (§3.6).    |
| Oversized key-set response.                              | 64 KiB enforced while streaming; 64-key bound (§3.5, §3.8). |
| Curve substitution (ES256 against a P-384 key).          | `crv` must match the `alg` (§3.4).                          |
| Provider ID token presented as an access token.          | Named gap; distinct API audience documented (§3.2).         |
| Token material in logs.                                  | Fixed reason codes only (§3.6).                             |

The implementation audit re-runs each row as a negative control against the committed tree,
including a real Keycloak token re-signed with `alg: HS256` using the realm's public key.

## 11. Implementation notes — deviations from this plan

- **Option validation lives in `src/issuers/trusted-issuer.ts`**, not inline in `auth-plugin.ts`;
  `AuthPlugin(...)` calls it at construction, so every §3.2 refusal still throws there.
- **`toPrincipal` throwing** is caught and reported as `verification-error`; the request stays
  anonymous. Its test lives in `issuer-strategy.test.ts`.
- **Health reports every issuer's state**, including `expired` (§3.5's past-`maxStaleMs` state),
  rather than only `stale`/`unfetched` as §3.7 listed. The indicator performs no I/O, so it reads
  `unfetched` until the first token from that issuer arrives.
- **A token with a `crit` header is refused** (`crit-unsupported`): no extension is understood, and
  RFC 7515 §4.1.11 requires refusing one that is not.
- **The default HTTP seam does not follow redirects** (`redirect: 'manual'`), so a validated `https`
  URL cannot be bounced to another scheme or host; the redirect's non-200 status is refused. The
  first implementation used `'error'`, which code review found Cloudflare Workers THROWS on
  (measured on workerd: "won't be implemented … at the edge"), failing every key-set fetch there.
- **Key sets are closed at `onStopping`, not only `onClose`.** The kernel drains in-flight requests
  before `onClose`, so a request parked on a key-set fetch held shutdown for up to `fetchTimeoutMs`
  (measured: 10 s with an `onClose`-only abort, 89 ms with `onStopping`).
- **Two refusals beyond §3.2**, both from code review: `keySet.ttlMs` above `keySet.maxStaleMs` (the
  cap would drop a set still fresh by TTL, refusing a valid token each cycle), and `http` without
  `issuers` (nothing would read it).
- **The key-set cache tracks "ever fetched" explicitly.** Using a zero timestamp as the sentinel
  broke under a monotonic clock that reads `0`, which the test fake did.
- **Keycloak is a CI step in `ci.yml`, `release.yml` and `drift.yml`**, compared byte-for-byte by
  `test/unit/release-notes.test.ts`, because the backend-parity test requires every suite-running
  workflow to start it, not only the PR job.
- **Security audit round 1 (commit `2e7e3269`, failed on three findings, all fixed):**
  - **F1 (Medium):** one forged-`kid` token held every concurrent valid request behind its refresh
    (measured 4985 ms against 2 ms), because `keys()` always awaited an in-flight refresh. A caller
    whose set is fresh and who did not force a refresh now reads the cache without waiting. A caller
    past its TTL still waits, which is ordinary expiry that no attacker can trigger.
  - **F2 (Low):** a `fetchTimeoutMs` above 2³¹−1 ms overflowed the timer, aborting every fetch. It
    is now refused at construction, without echoing the value.
  - **F3 (Low):** `sub` is unique only within one issuer. The `toPrincipal` JSDoc, the README and
    PUBLIC_API now say to namespace the id when more than one issuer is configured.
- **Security audit round 2 (commit `e184b5e4`)** confirmed F1–F3 fixed with probes and negative
  controls, and found **N1 (Low, fixed)**. The namespacing note said "more than one issuer", but a
  self-issued `jwt` plus one issuer collide the same way, because `JwtStrategy` also maps `sub` to
  the id. The note now covers every identity source in the JSDoc, README and PUBLIC_API, and the
  README example namespaces unconditionally.
