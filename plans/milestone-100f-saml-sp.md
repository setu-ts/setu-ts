# Milestone 100f — SAML 2.0 Service Provider (`@setu-ts/auth-plugin`)

> **Status:** Planning on `docs/m100-auth-federation-mfa`. Implementation and fixes belong on
> `feat/m100f-saml-sp`; `main` remains protected. Depends on 100a, 100c and 100d.

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
| workerd bundling (probe)             | `wrangler dev`, compatibility date 2025-09-01                                                        | node-saml and samlify both FAIL to bundle without `nodejs_compat` (`Could not resolve "crypto"`, `"fs"`, `"path"`); with the flag node-saml verified as above.                                                                                                                               |
| `samlify@2.13.1` (probe)             | same                                                                                                 | Imports on all four runtimes (workerd with `nodejs_compat`); verification not probed.                                                                                                                                                                                                        |
| Keycloak 26.4 (probe)                | `quay.io/keycloak/keycloak:26.4 start-dev`                                                           | Serves an IdP descriptor at `/realms/<realm>/protocol/saml/descriptor`.                                                                                                                                                                                                                      |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                        | Resolution (picked side)                                                                              | Doc deliverable (same PR)                             |
| -- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| C1 | `docs/plugins.md:56` lists `ioredis` as `auth-plugin`'s only npm driver.                                        | The `saml` arm adds `@node-saml/node-saml`, loaded lazily, and needs `nodejs_compat` on Workers.      | Update that row and the README's runtime note.        |
| C2 | `ROADMAP.md` M100 section says the library choice would be decided by a signature-wrapping corpus and runtimes. | Decided here by the §1 probes; the full corpus runs as a committed test (§6), not as a pre-condition. | Update the 100f paragraph to name the chosen library. |

## 3. Design decisions

### 3.1 Library: `@node-saml/node-saml`, inject-or-lazy

- **Decision:** `import('npm:@node-saml/node-saml@^5')` on first use of a `saml` provider, cached;
  or an application-supplied module through `saml.module` (the §12.2 inject-or-lazy pattern). A load
  failure throws `SamlRuntimeLoadError` at `register()`, naming the specifier and, on Workers,
  `nodejs_compat`.
- **Why:** A hand-written XML signature verifier is the most common source of SAML bypasses; the
  probe showed node-saml refusing a signature-wrapping arrangement on all four runtimes, with no
  open advisories. samlify was not verified end to end, so it is not chosen.
- **Test home:** `saml-loader.test.ts` (seam), `saml-real-import.test.ts` (guarded real import).

### 3.2 The `saml` arm

- **Decision:**
  `SamlProvider = { kind: 'saml', name, entityId, idp: { entityId, ssoUrl, certs },
  acsUrl, toPrincipal(profile), failureRedirect? }`
  joins the `SignInProvider` union. `certs` accepts several PEM certificates so a rotation can
  overlap. `acsUrl` must end with the provider's ACS path. The library is configured with
  `wantAssertionsSigned: true`, `audience = entityId`, `idpIssuer = idp.entityId`,
  `validateInResponseTo: 'always'`, and a clock skew of 60 s.
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
- **Why:** Without the binding, an attacker could start a login, obtain a valid response for their
  own account, and make the victim's browser post it — the SAML form of login CSRF.
- **Test home:** `saml-pending.test.ts`.

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
| `test/unit/memory-saml-request-store.test.ts`         | `saml-request-store.ts`          | Single-use consume; assertion-id replay refused; expiry.                                                                                                                                                                                               |
| `test/integration/saml-acs.test.ts`                   | `routes.ts`, `binding-cookie.ts` | Real kernel app + test IdP: valid → signed in; tampered, unsigned, wrapped (evil-first and evil-last), wrong audience, expired, unsolicited, replayed assertion, missing or mismatched binding cookie → refused; library message absent from the body. |
| `test/integration/saml-routes.test.ts`                | `routes.ts`                      | AuthnRequest redirect parameters; metadata document fields.                                                                                                                                                                                            |
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

| Finding                                          | Resolution in this plan                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| XML signature wrapping.                          | Maintained library, probed against the attack; tests on every run (§3.1, §6). |
| Login CSRF via a posted foreign response.        | Browser-binding cookie matched against the pending entry (§3.4).              |
| Unsolicited (IdP-initiated) responses.           | Refused (§0, §3.5).                                                           |
| Assertion replay.                                | Assertion ids claimed once (§3.5).                                            |
| Library error text reaching the client.          | Fixed detail; message logged at `debug` only (§3.5).                          |
| Weakening the session cookie to `SameSite=None`. | Not required; stated in the README (§8).                                      |
| Session fixation.                                | `signIn` regenerates (100c §3.1).                                             |

The implementation audit posts a captured valid response twice, from a browser without the binding
cookie, with the assertion wrapped after an unsigned copy, and with `InResponseTo` from another
browser's login.
