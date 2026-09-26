# Milestone 100c — Sign-In With an Outside Provider (`@setu-ts/auth-plugin`)

> **Status:** Planning on `docs/m100-auth-federation-mfa`. Implementation and fixes belong on
> `feat/m100c-oidc-sign-in`; `main` remains protected. Depends on 100a and 100b.

## 0. Objective & scope

Let a user sign in through an outside provider — "Sign in with Google / Microsoft / GitHub /
Keycloak" — and come back with a session the rest of the application recognises. This is the
relying-party side of OAuth 2.0 and OpenID Connect, over the authorization-code flow.

It also gives the framework the thing every later letter needs and that does not exist today: ONE
place that records "this session is signed in as this principal". Today an application writes
whatever key it likes into the session (the `full-stack` scaffold writes `userEmail`) and reads it
back through its own `toPrincipal`. 100d (second factor), 100e (passkeys) and 100f (SAML) all need
to create, hold back, or promote that record, so it is a contract, not a private key.

- **In scope:** an `IAuthSessionService` contract and `CAPABILITIES.AUTH_SESSION` token in `common`;
  a `signIn` option on `AuthPlugin` that registers the service and an `auth-session` strategy;
  sign-in `providers` with an `oidc` arm (discovery, ID token) and an `oauth2` arm (profile from a
  userinfo endpoint); plugin-registered login, callback and logout routes; PKCE S256, `state` and
  `nonce` held server-side in the session; ID token validation through 100b's verifier; session
  regeneration on sign-in; a same-origin `returnTo`; optional RP-initiated logout; a headless
  end-to-end test against a real Keycloak.
- **NOT this milestone:** a second factor (100d); Setu-TS acting as an authorization server or
  identity provider; the device flow; the implicit and hybrid flows; dynamic client registration;
  front- and back-channel logout; storing provider access or refresh tokens (the application may,
  through `onTokens`); account-linking policy (the application's `toPrincipal` decides).

## 1. Contracts verified from SOURCE (not names)

| Reference                 | Source (file:line)                                                             | Verified surface / fact                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ISession`                | `packages/common/src/services/session.ts:64-137`                               | `get`/`set`/`has`/`delete`/`clear`/`regenerate`/`destroy`; `regenerate` issues a new id and, on the store strategy, revokes the old entry. |
| `ISessionService`         | `packages/common/src/services/session.ts:150-181`                              | `from(ctx)` (throws without the session middleware) and read-only `fromHeaders(headers)`.                                                  |
| Session middleware order  | `packages/session-plugin/src/plugin/session-plugin.ts:29-35`                   | Session at 260, form CSRF at 275 — both before any route handler.                                                                          |
| Cookie budget             | `packages/session-plugin/src/options.ts:19-22,136-139`                         | Default 4096 bytes; exceeding it THROWS — an oversized stored principal fails loudly, not silently.                                        |
| Session cookie `SameSite` | `packages/session-plugin/src/options.ts:46,204`                                | Default `'lax'`: sent on a top-level cross-site GET navigation (the provider's redirect to the callback), NOT on a cross-site POST.        |
| Reserved session keys     | `session-plugin/src/services/session-tenant-binding.ts:23`, `csrf/token.ts:31` | Framework-owned session data uses `__`-prefixed keys (`__setu_tenant`, `__csrf`).                                                          |
| Token grammar             | `packages/common/src/tokens.ts` `createCapabilityToken`                        | Lowercase kebab-case with optional dots; `auth-session` is legal. `AUTH` is `'authentication'`, `SESSION` is `'session'`.                  |
| `IRouterApi.get/post`     | `packages/common/src/plugin.ts:91,100`                                         | Plugins register routes in `register()`; M68 makes a duplicate `METHOD path` throw naming the first owner.                                 |
| `IResponse.redirect`      | `packages/common/src/http.ts:248`                                              | `redirect(url, status?)` returns a `HandlerResult`.                                                                                        |
| Error responder           | `packages/common/src/errors/error-responder.ts`                                | `respondWithError` answers in the configured error format.                                                                                 |
| Session strategy (M73)    | `packages/auth-plugin/src/strategies/session-strategy.ts`                      | Maps an application-owned session payload through `toPrincipal`; stays unchanged and independent.                                          |
| 100b verifier and seam    | `plans/milestone-100b-external-token-verification.md` §3.4–3.8                 | Key selection, algorithm refusals, claim checks, `IAuthHttp.get` — reused; this plan adds `IAuthHttp.post`.                                |
| Keycloak 26.4 (probe)     | `quay.io/keycloak/keycloak:26.4 start-dev`                                     | Discovery advertises `code_challenge_methods_supported: ['plain','S256']` and an `end_session_endpoint`.                                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                      | Resolution (picked side)                                                                                                             | Doc deliverable (same PR)                                                         |
| -- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md` M36c maps `lib/route-guards.server.ts` to "`auth-plugin` guard factories + `userContext`" for React Router apps. | Stands for kernel routes; SSR pages gate through route middleware reading `userContext`, which a sign-in now populates via 100a.     | Extend the M36c footnote with the sign-in case and a pointer to the README.       |
| C2 | The `full-stack` scaffold's login writes `userEmail` into the session by hand.                                                | Unchanged here (a CLI decision); the README shows `IAuthSessionService.signIn` as the replacement for hand-written session identity. | README "Signing a user in" section, covering both a password form and a provider. |

## 3. Design decisions

### 3.1 `IAuthSessionService` — one owner of "who is signed in"

- **Decision:** `common` gains `CAPABILITIES.AUTH_SESSION = 'auth-session'` and:

  ```typescript
  interface IAuthSessionService {
    signIn(
      ctx: IRequestContext,
      principal: IPrincipal,
      options: SignInOptions,
    ): Promise<SignInOutcome>;
    current(ctx: IRequestContext): IPrincipal | null;
    signOut(ctx: IRequestContext): void;
  }
  interface SignInOptions {
    readonly methods: readonly AuthMethod[];
  }
  type AuthMethod = 'pwd' | 'otp' | 'hwk' | 'swk' | 'fed'; // RFC 8176 values
  type SignInOutcome = { readonly status: 'signed-in' };
  ```

  `signIn` stores `{ principal, methods, at }` under `__setu_auth_principal`, calls
  `session.regenerate()`, and resolves `signed-in`. `signOut` destroys the session. 100d widens
  `SignInOutcome` with a second arm; this milestone produces exactly one, so no dead variant ships.
- **Why:** 100c–100f all create, hold back or promote this record; a private key would leave four
  copies of the same write.
- **Test home:** `auth-session-service.test.ts`.

### 3.2 The `signIn` option gates everything here

- **Decision:** `AuthPluginOptions.signIn?: SignInConfig` with `basePath?` (default `/auth`) and
  `providers?`. When present: `provides` gains `AUTH_SESSION`; `register()` throws naming both
  plugins if `SessionPlugin` is absent (the M73 precedent); an internal `auth-session` strategy
  joins the chain after the M73 session strategy and returns the stored principal, adding
  `claims.amr = methods`. When absent, nothing here changes — so a JWT-only API is untouched.
- **Test home:** `sign-in-options.test.ts`, `auth-session-strategy.test.ts`.

### 3.3 Two provider arms, discriminated on `kind`

- **Decision:** `SignInProvider = OidcProvider | OAuth2Provider`. Common fields: `name` (kebab-case,
  used in paths), `clientId`, `clientSecret?`, `tokenEndpointAuth` (`'client_secret_basic'`,
  `'client_secret_post'` or `'none'`), `scopes`, `redirectUri`, `toPrincipal`, `onTokens?`,
  `failureRedirect?`. `oidc` adds `issuer` (discovery only; `scopes` must include `openid`).
  `oauth2` adds `authorizationEndpoint`, `tokenEndpoint`, `userinfoEndpoint`. A missing per-arm
  field is a compile error (the M30 `ChannelConfig` precedent). `'none'` with a secret, or a
  secret-based method without one, throws at construction; `redirectUri` must end with that
  provider's callback path, so the route and the value sent to the provider cannot disagree.
- **Why:** GitHub issues no ID token; forcing it through the OIDC arm would need a fake ID token.
- **Test home:** `sign-in-options.test.ts`.

### 3.4 Routes

- **Decision:** Per provider, `GET <basePath>/<name>/login` and `GET <basePath>/<name>/callback`;
  one `POST <basePath>/logout`. `POST` so the session plugin's form CSRF check applies when
  configured.
- **Test home:** `sign-in-routes.test.ts`.

### 3.5 Login: state, nonce and PKCE held server-side

- **Decision:** `login` creates `state` (32 random bytes), a PKCE verifier (32 random bytes, S256
  challenge through `runtime.subtle.digest`) and, for `oidc`, a `nonce`; stores
  `{ provider, verifier, nonce?, returnTo, createdAt }` under `__setu_auth_pending`, a map keyed by
  `state`, holding at most 5 entries (oldest evicted) that expire after 10 minutes on
  `runtime.now()`; then redirects to the authorization endpoint. PKCE is sent for every provider,
  including confidential clients.
- **Why:** Binding `state` to the victim's own session defeats login CSRF; five entries allow two
  tabs without letting the map grow.
- **Test home:** `login-flow.test.ts`, `pending-state.test.ts`.

### 3.6 Callback

- **Decision:** In order — each failure answers through `respondWithError` with 401 and a fixed
  detail, or redirects to `failureRedirect` with a fixed `error` code: a provider `error` parameter;
  a missing or unknown `state`; an entry for a different provider (the mix-up defence, also checked
  against RFC 9207 `iss` when present); an expired entry. The entry is deleted BEFORE the token
  request, so a replayed callback fails. The code is exchanged with the verifier. For `oidc` the ID
  token is verified with 100b's verifier (`audience = clientId`; `azp` must equal `clientId` when
  `aud` has several values) and its `nonce` must match. For `oauth2` the profile comes from
  `userinfoEndpoint`. `toPrincipal` returns a principal (`null` → 403); the callback then calls
  `IAuthSessionService.signIn(ctx, principal, { methods: ['fed'] })`, invokes `onTokens?` and
  redirects to the stored `returnTo`.
- **Test home:** `callback-flow.test.ts`.

### 3.7 `returnTo`

- **Decision:** Accepted only when it starts with a single `/`, contains no `\`, no scheme and no
  control character; anything else becomes `/`. Checked at login, stored in the entry, never read
  from the callback URL.
- **Why:** An open redirect after sign-in is a phishing primitive.
- **Test home:** `return-to.test.ts`.

### 3.8 Logout

- **Decision:** `POST <basePath>/logout` calls `signOut`. When an `oidc` provider sets
  `rpInitiatedLogout: { postLogoutRedirectUri }` and discovery advertises `end_session_endpoint`,
  the callback additionally stores the ID token (a stated cookie-size cost) and logout redirects to
  the provider with `id_token_hint`. Otherwise it redirects to `/`.
- **Test home:** `logout.test.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol (package)                                          | Kind  | Consumer / real code path that READS it                      |
| ------------------------------------------------------------------ | ----- | ------------------------------------------------------------ |
| `CAPABILITIES.AUTH_SESSION` (`common`)                             | token | Applications' password logins; 100d–100f; the callback here. |
| `IAuthSessionService` (`common`)                                   | type  | Resolved by the token above.                                 |
| `SignInOptions`, `AuthMethod`, `SignInOutcome` (`common`)          | types | `signIn` parameters and result.                              |
| `SignInConfig` (`auth-plugin`)                                     | type  | `AuthPluginOptions.signIn`.                                  |
| `SignInProvider`, `OidcProvider`, `OAuth2Provider` (`auth-plugin`) | types | `SignInConfig.providers`.                                    |
| `ProviderTokens` (`auth-plugin`)                                   | type  | `onTokens` parameter.                                        |

### 4.1 Options — every option names its consumer

| Option                             | Consumer           | Behavior                                                  |
| ---------------------------------- | ------------------ | --------------------------------------------------------- |
| `signIn`                           | `AuthPlugin`       | Registers `AUTH_SESSION` and the `auth-session` strategy. |
| `signIn.basePath`                  | route registration | Default `/auth`.                                          |
| `signIn.providers`                 | route registration | Login and callback routes per provider.                   |
| `SignInProvider.tokenEndpointAuth` | token exchange     | Basic header, form fields, or neither.                    |
| `SignInProvider.toPrincipal`       | callback           | Principal, or `null` → 403.                               |
| `SignInProvider.onTokens`          | callback           | Receives provider tokens; nothing stores them otherwise.  |
| `SignInProvider.failureRedirect`   | callback           | Redirect with a fixed error code instead of 401.          |
| `OidcProvider.rpInitiatedLogout`   | logout             | §3.8.                                                     |

## 5. Implementation files

| File                                                           | Purpose                                 |
| -------------------------------------------------------------- | --------------------------------------- |
| `packages/common/src/tokens.ts`                                | `AUTH_SESSION`.                         |
| `packages/common/src/services/auth-session.ts` (+ barrel)      | `IAuthSessionService` and its types.    |
| `packages/auth-plugin/src/index.ts`                            | Export the plugin-side types.           |
| `packages/auth-plugin/src/interfaces/index.ts`                 | `SignInConfig`, provider types.         |
| `packages/auth-plugin/src/sign-in/auth-session-service.ts`     | §3.1.                                   |
| `packages/auth-plugin/src/sign-in/routes.ts`                   | Login, callback, logout (§3.4–3.8).     |
| `packages/auth-plugin/src/sign-in/pending-state.ts`            | Pending-entry storage, bounds, expiry.  |
| `packages/auth-plugin/src/sign-in/pkce.ts`                     | Verifier and S256 challenge.            |
| `packages/auth-plugin/src/sign-in/token-exchange.ts`           | Token request per `tokenEndpointAuth`.  |
| `packages/auth-plugin/src/sign-in/return-to.ts`                | §3.7 check.                             |
| `packages/auth-plugin/src/strategies/auth-session-strategy.ts` | §3.2.                                   |
| `packages/auth-plugin/src/issuers/auth-http.ts`                | Add `post`.                             |
| `packages/auth-plugin/src/plugin/auth-plugin.ts`               | Validation, provides, routes, strategy. |
| `packages/auth-plugin/test/fixtures/keycloak-realm.json`       | Realm, confidential client, test user.  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                    | src covered                         | Key assertions                                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-plugin/test/unit/sign-in-options.test.ts`              | `auth-plugin.ts`                    | Every construction refusal; missing `SessionPlugin` refused at `register()`; `provides` gains `auth-session`.                                             |
| `auth-plugin/test/unit/auth-session-service.test.ts`         | `auth-session-service.ts`           | `signIn` writes the record and changes the session id; `current`; `signOut` destroys.                                                                     |
| `auth-plugin/test/unit/pkce.test.ts`                         | `pkce.ts`                           | RFC 7636 Appendix B vector.                                                                                                                               |
| `auth-plugin/test/unit/pending-state.test.ts`                | `pending-state.ts`                  | Five-entry cap, expiry on a fake clock, single use.                                                                                                       |
| `auth-plugin/test/unit/return-to.test.ts`                    | `return-to.ts`                      | Table: `/a` kept; `//evil`, `/\evil`, `https://evil`, `javascript:`, control characters → `/`.                                                            |
| `auth-plugin/test/unit/token-exchange.test.ts`               | `token-exchange.ts`, `auth-http.ts` | Each auth method's exact request; `Accept: application/json`; provider error bodies.                                                                      |
| `auth-plugin/test/integration/login-flow.test.ts`            | `routes.ts`                         | Real kernel app + `SessionPlugin`: redirect parameters, pending entry written.                                                                            |
| `auth-plugin/test/integration/callback-flow.test.ts`         | `routes.ts`                         | Fake provider seam: success, provider error, unknown/expired/replayed `state`, wrong provider, bad `nonce`, `toPrincipal` null → 403, session id changes. |
| `auth-plugin/test/integration/auth-session-strategy.test.ts` | `auth-session-strategy.ts`          | A password login through `signIn` authenticates the next request with no hand-added middleware (100a); `amr` present.                                     |
| `auth-plugin/test/integration/logout.test.ts`                | `routes.ts`                         | Session destroyed; RP-initiated redirect parameters.                                                                                                      |
| `auth-plugin/test/e2e/keycloak-sign-in-real.test.ts` (guard) | all                                 | Cookie-jar flow: login → Keycloak form → credentials → callback → protected route returns the Keycloak user. `ignore:` without `KEYCLOAK_URL`.            |
| `common/test/unit/barrel-exports.test.ts` (extended)         | `common` barrel                     | The new token and types are exported; compile-time assertion on the contract.                                                                             |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m100c-oidc-sign-in
deno task check:plan
deno task fmt:check && deno task lint && deno task check && deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% every changed src file
deno task check:docs
deno task publish:check && deno task release:verify <version>
```

## 8. Risks & mitigations

- Keycloak's login form markup changes between versions → the e2e finds the form by its stable
  `id="kc-form-login"` and the image tag is pinned.
- Providers disagree on token-endpoint responses (GitHub answers form-encoded unless asked for JSON)
  → the exchange sends `Accept: application/json`, with a unit case per known quirk.
- The callback depends on the session cookie arriving with the provider's redirect → it is a
  top-level GET, which a `SameSite=Lax` cookie accompanies; `response_mode=form_post` would be a
  cross-site POST that it does not, so the plugin always requests the default query response mode.
- A new `common` contract could break out-of-repo implementors → it is a new interface, not a
  widened one, so nothing existing breaks.

## 9. Out of scope

- A second factor — 100d widens `SignInOutcome`.
- Being an authorization server; device flow; implicit and hybrid flows; dynamic registration;
  front- and back-channel logout.
- Changing the `full-stack` scaffold's login — a CLI decision after this ships.

## 10. Design security review — completed before implementation

**Reviewed flow:** login → pending entry in the user's own session → provider → callback → entry
consumed → code exchange with verifier → ID token verified → principal mapped → `signIn`
(regenerate) → redirect to a validated same-origin path.

| Finding                                                        | Resolution in this plan                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Login CSRF (victim signed in as the attacker).                 | `state` bound to the victim's session and single-use (§3.5, §3.6).       |
| Authorization-code interception.                               | PKCE S256 for every provider (§3.5).                                     |
| ID token replay across logins.                                 | `nonce` stored per attempt and matched (§3.5, §3.6).                     |
| Mix-up between two configured providers.                       | Provider stored in the entry and matched; RFC 9207 `iss` checked (§3.6). |
| Session fixation.                                              | `signIn` regenerates the session id (§3.1).                              |
| Open redirect after sign-in.                                   | Same-origin path rule, never read from the callback (§3.7).              |
| Provider tokens persisted without the application choosing to. | Not stored; `onTokens` hands them over (§3.3).                           |
| Oversized principal silently lost.                             | Session plugin throws past its budget (§1).                              |

The implementation audit replays a captured callback, swaps `state` between two providers, submits
every `returnTo` from the §3.7 refusal table, and confirms the pre-sign-in session id is rejected
afterwards.
