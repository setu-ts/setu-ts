# Milestone 100f — SAML 2.0 Service Provider (`@setu-ts/auth-plugin`)

> **Status:** Implemented. Developed on the session-designated branch
> `claude/gracious-lovelace-4575ac` rather than `feat/m100f-saml-sp` — the harness pins the branch;
> recorded as a deviation. Depends on 100a, 100c and 100d. See §11 for what implementation
> corrected.

## 0. Objective & scope

Let an enterprise sign its users in through its SAML identity provider (Entra ID, Okta, ADFS,
Keycloak, Google Workspace), as a service provider (SP), landing in the same signed-in session as
every other method.

- **In scope:** a `saml` arm of `signIn.providers`; SP-initiated login over the HTTP-Redirect
  binding; an assertion consumer service (ACS) over the HTTP-POST binding; SP metadata; signed
  assertions required; audience, recipient, time and `InResponseTo` checks; assertion-id replay
  protection; binding the response to the browser that started the login; `@node-saml/node-saml`
  loaded lazily or injected; a real Keycloak end-to-end test.
- **NOT this milestone:** IdP-initiated login (refused — there is no request to bind to); encrypted
  assertions; single logout (SLO); the Artifact binding; SAML attribute-to-role mapping policy (the
  application's `toPrincipal` decides); acting as an IdP.

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                                                   | Verified surface / fact                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider arms and sign-in routes     | `plans/milestone-100c-oidc-sign-in.md` §3.3–3.7                                                      | `SignInProvider` union discriminated on `kind`; login route, pending entry, `returnTo` rule, `signIn(ctx, principal, { methods })`.                                                                                                                                                          |
| Pending sign-in / MFA                | `plans/milestone-100d-totp-mfa.md` §3.1                                                              | `signIn` may answer `second-factor-required`; a SAML sign-in passes `methods: ['fed']` and the application's `mfa.required` decides.                                                                                                                                                         |
| Session cookie `SameSite`            | `packages/session-plugin/src/options.ts:46,204`                                                      | Default `'lax'`: NOT sent on the IdP's cross-site POST to the ACS. The session cannot carry the pending request, unlike 100c's GET callback.                                                                                                                                                 |
| Lazy `npm:` import rules             | CLAUDE.md "A lazily-loaded optional dep must ACTUALLY load"; `scripts/npm-specifier-audit.ts` (M70e) | The specifier must be a literal `import('npm:…')`; a guarded real-import test is required.                                                                                                                                                                                                   |
| `@node-saml/node-saml@5.1.0` (probe) | installed; `npm audit`: 0 advisories                                                                 | Verified an RSA-SHA256, exclusive-c14n signed assertion on Deno 2.9.6, Node 24.18, Bun 1.4.2 and workerd; refused a tampered NameID, an unsigned assertion, and an unsigned assertion placed BEFORE a signed one (signature wrapping: "Invalid signature: multiple assertions") on all four. |
| node-saml options (source, 5.1.0)    | `lib/saml.js:85,89,92`, `lib/types.d.ts:22-26,68`                                                    | `wantAuthnResponseSigned` defaults to `true`; `validateInResponseTo` defaults to `'never'`; request ids live in `options.cacheProvider` (`saveAsync`/`getAsync`/`removeAsync`), an in-memory provider when none is given; the IdP certificate option is `idpCert: string \| string[]`.       |
| workerd bundling (probe)             | `wrangler dev`, compatibility date 2025-09-01                                                        | node-saml and samlify both FAIL to bundle without `nodejs_compat` (`Could not resolve "crypto"`, `"fs"`, `"path"`); with the flag node-saml verified as above.                                                                                                                               |
| `samlify@2.13.1` (probe)             | same                                                                                                 | Imports on all four runtimes (workerd with `nodejs_compat`); verification not probed.                                                                                                                                                                                                        |
| Keycloak 26.4 (probe)                | `quay.io/keycloak/keycloak:26.4 start-dev`                                                           | Serves an IdP descriptor at `/realms/<realm>/protocol/saml/descriptor`.                                                                                                                                                                                                                      |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                               | Resolution (picked side)                                                                         | Doc deliverable (same PR)                                                    |
| -- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| C1 | `docs/plugins.md:56` lists `ioredis` as `auth-plugin`'s only npm driver.                                                               | The `saml` arm adds `@node-saml/node-saml`, loaded lazily, and needs `nodejs_compat` on Workers. | Update that row and the README's runtime note.                               |
| C2 | The M100 ROADMAP section was drafted to decide the library by a signature-wrapping corpus; the opening commit already names node-saml. | Decided by the §1 probes; the full corpus runs as a committed test (§6), not as a pre-condition. | None — the ROADMAP paragraph already names the library; checked, not edited. |

## 3. Design decisions

### 3.1 Library: `@node-saml/node-saml`, inject-or-lazy

- **Decision:** `import('npm:@node-saml/node-saml@^5')` is awaited in `register()` (which becomes
  async, as M44's did) whenever a `saml` provider is configured, and cached; or an
  application-supplied module through `saml.module` (the §12.2 inject-or-lazy pattern). A load
  failure throws `SamlRuntimeLoadError` from `register()`, naming the specifier and, on Workers,
  `nodejs_compat` — at startup, never at the first login, which is why the import is not deferred to
  first use.
- **Why:** A hand-written XML signature verifier is the most common source of SAML bypasses; the
  probe showed node-saml refusing a signature-wrapping arrangement on all four runtimes, with no
  open advisories. samlify was not verified end to end, so it is not chosen.
- **Test home:** `saml-loader.test.ts` (seam), `saml-real-import.test.ts` (guarded real import).

### 3.2 The `saml` arm

- **Decision:**
  `SamlProvider = { kind: 'saml', name, entityId, idp: { entityId, ssoUrl, certs },
  acsUrl, toPrincipal(profile), failureRedirect? }`
  joins the `SignInProvider` union. `certs` accepts several PEM certificates so a rotation can
  overlap, and is passed as `idpCert`. `acsUrl` must end with the provider's ACS path. The library
  is configured with `wantAssertionsSigned: true`, `wantAuthnResponseSigned: false`,
  `audience = entityId`, `idpIssuer = idp.entityId`, `validateInResponseTo: 'always'`,
  `acceptedClockSkewMs: 60_000`, and `cacheProvider` = an adapter over the provider's
  `ISamlRequestStore` (§3.4).
- **Every security option is set explicitly, never inherited.** Two node-saml defaults would
  otherwise decide behaviour (§1): `validateInResponseTo` defaults to `'never'`, which would accept
  unsolicited responses; and `wantAuthnResponseSigned` defaults to `true`, which refuses every IdP
  that signs only the assertion (common — Entra ID's default). The assertion signature is what
  authenticates the user, so `wantAssertionsSigned: true` with the response signature optional is
  the standard SP posture, and the wrapping and tampering cases in §6 run under exactly this
  configuration. `saml-options.test.ts` asserts each option handed to the library field by field.
- **Test home:** `saml-options.test.ts`.

### 3.3 Routes

- **Decision:** `GET <basePath>/<name>/login` (redirect binding, AuthnRequest),
  `POST <basePath>/<name>/acs` (POST binding) and `GET <basePath>/<name>/metadata` (SP descriptor
  with the ACS URL and `AuthnRequestsSigned="false"`).
- **Test home:** `saml-routes.test.ts`.

### 3.4 Pending requests live server-side, bound to the browser by a second cookie

- **Decision:** The IdP returns by cross-site POST, which the `SameSite=Lax` session cookie does not
  accompany (§1), so the pending request cannot live in the session as it does in 100c. At login the
  plugin stores `{ requestId, provider, returnTo, binding, expiresAt }` in an `ISamlRequestStore`
  (memory default; applications with several replicas supply a shared one), and sets
  `__Host-setu-saml` — `SameSite=None; Secure; HttpOnly; Path=/; Max-Age=600` — holding `binding`,
  32 random bytes. At the ACS the `InResponseTo` entry is consumed (single use), and the cookie's
  value must equal its `binding`; the cookie is then cleared.
- **One store, not two.** node-saml validates `InResponseTo` against its own `cacheProvider` (§1),
  in memory unless given one. The plugin passes an adapter over `ISamlRequestStore` as that
  `cacheProvider`, so the request id the library checks and the pending entry the plugin consumes
  are the same record. Leaving the library's default in place would create a second, per-process
  store: several replicas would then fail even with a shared `ISamlRequestStore`, because the
  library's check runs first on whichever replica receives the POST.
- **Consumption happens in `removeAsync`, and the ACS trusts only what it returned.** node-saml
  5.1.0 checks a request id with `getAsync`, then calls `removeAsync` on BOTH its success path and
  its failure paths (`lib/saml.js:628`, `:803-828`). The adapter is built per ACS request:
  `getAsync` reads without consuming; `removeAsync` calls `store.consumeRequest(id)`, which
  atomically deletes the entry and returns it (or `null` if it was already gone), and the adapter
  captures that return value. After the library resolves, the ACS reads `provider`, `returnTo` and
  `binding` from the CAPTURED record only; nothing captured means a replayed or concurrently
  consumed response, which is refused. So of two concurrent posts of one response both may pass
  `getAsync`, but exactly one captures the record, and a response that fails validation still
  consumes its entry (fail closed).
- **One binding cookie per browser.** A second login started in another tab overwrites the cookie,
  so the first tab's response is refused (fails closed). Accepted and stated in the README; the
  failure is a retry, never a wrong sign-in.
- **Why:** Without the binding, an attacker could start a login, obtain a valid response for their
  own account, and make the victim's browser post it — the SAML form of login CSRF.
- **Test home:** `saml-pending.test.ts` (includes a store shared by two plugin instances standing in
  for replicas: a login started on one completes on the other).

### 3.5 Assertion checks and replay

- **Decision:** The library verifies the signature, issuer, audience, `Recipient`, `NotBefore`,
  `NotOnOrAfter` and `InResponseTo`. The plugin additionally records each assertion `ID` through
  `ISamlRequestStore.claimAssertionId(id, notOnOrAfter)`, refusing a second use. An unsolicited
  response (no `InResponseTo`) is refused. Failures answer through `respondWithError` with 401 and a
  fixed detail, or redirect to `failureRedirect` with a fixed code; the library's message is logged
  at `debug` and never returned.
- **Test home:** `saml-acs.test.ts`.

### 3.6 Sign-in

- **Decision:** `toPrincipal(profile)` maps the NameID and attributes; `null` → 403. Then
  `signIn(ctx, principal, { methods: ['fed'] })` — which regenerates the session and may answer
  `second-factor-required` (100d) — and a redirect to the stored `returnTo`.
- **The ACS runs on a NEW session.** The `Lax` session cookie does not accompany the IdP's POST, so
  the session middleware loads an empty session and `signIn` writes into that; its cookie then
  replaces the browser's previous one. Whatever the previous session held is gone, and on the store
  strategy its entry is orphaned until its own expiry rather than revoked, because the ACS never
  learns its id. The README states this; applications must not keep state across a SAML sign-in in
  the session. (100c's callback is a top-level GET and keeps the session.)

### 3.7 CSRF composition at the ACS

- **Decision:** No code change in the two CSRF middlewares; documented configuration plus a test.
  The ACS receives a cross-site `POST` carrying no form token, so the session plugin's
  `csrfFormMiddleware` answers `403` unless the ACS path is in `CsrfFormOptions.exclude`, and
  `http-security-plugin`'s Origin check answers `403` unless the IdP origin is in `trustedOrigins`.
  The ACS's own defences — the signed assertion, the single-use `InResponseTo`, and the binding
  cookie (§3.4) — are what protect it, which is why exempting it is sound. The README states both
  settings, and that `trustedOrigins` admits the IdP's origin on EVERY route (acceptable, since the
  IdP is already trusted to assert identity).
- **Why a test:** two documented features of one application answering `403` when composed is the
  M90h X33-2 defect class; the test pins the documented configuration working and the failure
  without it.
- **Test home:** `saml-csrf-composition.test.ts`.
- **Test home:** `saml-acs.test.ts`; the Keycloak e2e.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                               | Kind        | Consumer / real code path that READS it            |
| --------------------------------------------- | ----------- | -------------------------------------------------- |
| `SamlProvider`                                | type        | The `saml` arm of `SignInConfig.providers`.        |
| `ISamlRequestStore`, `MemorySamlRequestStore` | type, class | `SamlProvider.store` / default.                    |
| `SamlRuntimeLoadError`                        | class       | Thrown at `register()`; applications `instanceof`. |

### 4.1 Options — every option names its consumer

| Option                  | Consumer                 | Behavior                                         |
| ----------------------- | ------------------------ | ------------------------------------------------ |
| `SamlProvider.idp`      | library configuration    | Issuer, SSO URL, certificates (several allowed). |
| `SamlProvider.entityId` | library, metadata        | Audience and SP entity id.                       |
| `SamlProvider.acsUrl`   | library, metadata, route | Must end with the ACS path (§3.2).               |
| `SamlProvider.store`    | pending and replay       | Default `MemorySamlRequestStore`.                |
| `SamlProvider.module`   | loader                   | Injected library module; skips the lazy import.  |

## 5. Implementation files

| File                                                       | Purpose                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/auth-plugin/src/saml/loader.ts`                  | Inject-or-lazy load (§3.1).                                                               |
| `packages/auth-plugin/src/saml/routes.ts`                  | Login, ACS, metadata (§3.3–3.6).                                                          |
| `packages/auth-plugin/src/saml/binding-cookie.ts`          | `__Host-setu-saml` set, read, clear.                                                      |
| `packages/auth-plugin/src/stores/saml-request-store.ts`    | Port and memory store.                                                                    |
| `packages/auth-plugin/src/interfaces/index.ts`, `index.ts` | `SamlProvider`, exports.                                                                  |
| `packages/auth-plugin/src/errors.ts`                       | `SamlRuntimeLoadError`.                                                                   |
| `packages/auth-plugin/test/fixtures/saml-idp.ts`           | Test IdP: signs responses with xml-crypto from a generated key; builds wrapping variants. |
| `packages/auth-plugin/test/fixtures/keycloak-realm.json`   | Add a SAML client to 100c's realm.                                                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                             | src covered                      | Key assertions                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/unit/saml-loader.test.ts`                       | `loader.ts`                      | Injected module used; failed load → `SamlRuntimeLoadError` naming the specifier and `nodejs_compat`.                                                                                                                                                   |
| `test/unit/saml-options.test.ts`                      | `routes.ts`                      | Each construction refusal; configuration handed to the library field by field.                                                                                                                                                                         |
| `test/unit/binding-cookie.test.ts`                    | `binding-cookie.ts`              | Attributes exact (`__Host-`, `SameSite=None`, `Secure`, `HttpOnly`, `Path=/`, `Max-Age`); cleared after use.                                                                                                                                           |
| `test/unit/memory-saml-request-store.test.ts`         | `saml-request-store.ts`          | Single-use consume; two concurrent `consumeRequest` calls → exactly one record returned; assertion-id replay refused; expiry.                                                                                                                          |
| `test/integration/saml-acs.test.ts`                   | `routes.ts`, `binding-cookie.ts` | Real kernel app + test IdP: valid → signed in; tampered, unsigned, wrapped (evil-first and evil-last), wrong audience, expired, unsolicited, replayed assertion, missing or mismatched binding cookie → refused; library message absent from the body. |
| `test/integration/saml-routes.test.ts`                | `routes.ts`                      | AuthnRequest redirect parameters; metadata document fields.                                                                                                                                                                                            |
| `test/integration/saml-csrf-composition.test.ts`      | `routes.ts`                      | Real `SessionPlugin({ csrf })` + `HttpSecurityPlugin({ csrf })`: ACS 403 without the documented `exclude`/`trustedOrigins`, signed in with them; the pre-existing session's data is absent afterwards (§3.6).                                          |
| `test/integration/saml-real-import.test.ts` (guarded) | `loader.ts`                      | The real `npm:@node-saml/node-saml` import verifies a test-IdP response.                                                                                                                                                                               |
| `test/e2e/keycloak-saml-real.test.ts` (guarded)       | all                              | Cookie-jar flow against Keycloak: login → IdP form → credentials → POST to ACS → protected route returns the user. `ignore:` without `KEYCLOAK_URL`.                                                                                                   |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m100f-saml-sp
deno task check:plan
deno task fmt:check && deno task lint && deno task check && deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% every changed src file
deno task check:docs
deno task publish:check && deno task release:verify <version>   # includes the npm-specifier audit
```

## 8. Risks & mitigations

- A future node-saml release regresses signature handling → the wrapping and tampering cases in
  `saml-acs.test.ts` run against the real library on every CI run, and the version range is pinned
  to the major probed here.
- An operator enables `SameSite=None` on the session cookie to "make SAML work" → unnecessary by
  design; the README says so and explains the binding cookie.
- Memory request store with several replicas loses requests routed to another replica → the README
  and the store's JSDoc state it; the Keycloak e2e uses one replica.

## 9. Out of scope

- IdP-initiated login, encrypted assertions, single logout, the Artifact binding, acting as an IdP.

## 10. Design security review — completed before implementation

**Reviewed flow:** login → AuthnRequest with an id → server-side pending entry + `__Host-` binding
cookie → IdP → cross-site POST to ACS → library verification (signature, issuer, audience,
recipient, time, `InResponseTo`) → entry consumed and binding matched → assertion id claimed →
principal → `signIn` → redirect to a validated `returnTo`.

| Finding                                           | Resolution in this plan                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| XML signature wrapping.                           | Maintained library, probed against the attack; tests on every run (§3.1, §6). |
| Login CSRF via a posted foreign response.         | Browser-binding cookie matched against the pending entry (§3.4).              |
| Unsolicited (IdP-initiated) responses.            | Refused (§0, §3.5).                                                           |
| Assertion replay.                                 | Assertion ids claimed once (§3.5).                                            |
| Library error text reaching the client.           | Fixed detail; message logged at `debug` only (§3.5).                          |
| Weakening the session cookie to `SameSite=None`.  | Not required; stated in the README (§8).                                      |
| Session fixation.                                 | `signIn` regenerates (100c §3.1).                                             |
| Unsafe library defaults.                          | Every security option set explicitly and asserted (§3.2).                     |
| Replicas disagreeing about a pending request.     | node-saml's `cacheProvider` is the plugin's store (§3.4).                     |
| Concurrent posts of one response both signing in. | Atomic consume in `removeAsync`; ACS uses only the captured record (§3.4).    |
| CSRF exemption for the ACS.                       | Justified by the ACS's own defences; documented and tested (§3.7).            |

The implementation audit posts a captured valid response twice, from a browser without the binding
cookie, with the assertion wrapped after an unsigned copy, and with `InResponseTo` from another
browser's login.

## 11. Corrections made during implementation

Each is a claim this plan made that did not survive the source or a test, recorded rather than
quietly fixed.

| #  | Plan claim                                                                                  | Measured                                                                                                                                                                                                                                            | Resolution                                                                                                                  |
| -- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| K1 | §3.5: "The library verifies the signature, **issuer**, audience, **`Recipient`** …".        | node-saml 5.1.0 reads `idpIssuer` only in `verifyIssuer`, called for logout messages (`lib/saml.js:705,717`), and never reads `Recipient` or `Destination` at all. The `refuses a wrong issuer` test FAILED (302) against the first implementation. | The ACS checks the verified assertion's `Issuer` against `idp.entityId`, and every `SubjectConfirmationData` `Recipient`.   |
| K2 | §3.4: `removeAsync` is called on the library's success path.                                | Not on every path: a confirmation without `InResponseTo` falls through `getInResponseTo` with no `removeAsync`.                                                                                                                                     | The ACS completes consumption itself after the library resolves; the consume is idempotent per request (one store call).    |
| K3 | §3.4: the adapter "captures" the record per ACS request over one long-lived library object. | `cacheProvider` is read from the instance, so swapping it per request on a shared instance races.                                                                                                                                                   | A `SAML` instance is constructed per request with its own adapter; options are compiled once.                               |
| K4 | §3.1: `register()` "becomes async".                                                         | Making it unconditionally async turned two existing synchronous refusal tests into rejections.                                                                                                                                                      | `register()` returns a promise only when a `saml` provider is configured, awaited as its last step.                         |
| K5 | §4: three exported types.                                                                   | `toPrincipal(profile)` and `module` need nameable types (slow types otherwise).                                                                                                                                                                     | `SamlProfile`, `SamlModule` and `SamlPendingRequest` are also exported, each read by `SamlProvider` / `ISamlRequestStore`.  |
| K6 | §3.4 one fixed error code set.                                                              | A replayed response is refused by the library's `getAsync` BEFORE the binding check runs.                                                                                                                                                           | Replay answers `assertion-invalid`, not `state-invalid`; both codes are documented and the tests assert the actual code.    |
| K7 | §6 Keycloak image `quay.io/keycloak/keycloak:26.4`.                                         | quay.io is not reachable from the development container.                                                                                                                                                                                            | Verified locally against the same release from Docker Hub (`keycloak/keycloak:26.4`); CI keeps the quay.io image unchanged. |

Negative controls, each observed failing and reverted: removing the issuer check (wrong-issuer test
fails), the recipient check (both recipient tests fail), the binding check (two binding tests fail),
the assertion-id claim (the reused-id test fails), and the provider check (the wrong-provider test
fails — after it was tightened, because it first passed vacuously via the binding check).
