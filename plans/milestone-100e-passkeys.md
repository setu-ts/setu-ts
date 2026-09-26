# Milestone 100e — Passkeys / WebAuthn (`@setu-ts/auth-plugin`)

> **Status:** Planning on `docs/m100-auth-federation-mfa`. Implementation and fixes belong on
> `feat/m100e-passkeys`; `main` remains protected. Depends on 100a, 100c and 100d.

## 0. Objective & scope

Let a user register a passkey and sign in with it — with no password, or as the second factor after
one. Passkeys are phishing-resistant: the browser binds each assertion to the site's origin.

- **In scope:** registration and authentication ceremonies (options generation and response
  verification) for WebAuthn Level 2, with attestation conveyance `none`; ES256, RS256 and EdDSA
  credentials; discoverable credentials (username-less sign-in); a passkey as the second factor for
  100d; challenges held in the session; an `IPasskeyStore` port with a memory default; plugin routes
  for the four ceremony steps; a software-authenticator test fixture; a differential test against a
  reference implementation.
- **NOT this milestone:** attestation statements and trust roots (`packed`, `tpm`, `android-key`,
  FIDO MDS) — attestation is requested as `none`; the browser-side JavaScript (the README shows the
  `navigator.credentials` calls); ML-DSA (post-quantum) credentials; conditional mediation UI
  helpers; account recovery when every passkey is lost.

## 1. Contracts verified from SOURCE (not names)

| Reference                                 | Source (file:line)                                                                                                          | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IAuthSessionService`                     | `plans/milestone-100c-oidc-sign-in.md` §3.1, `plans/milestone-100d-totp-mfa.md` §3.1                                        | `signIn`, `pending`, `completeSecondFactor`; `SecondFactorMethod` includes `'hwk'` and `'swk'`.                                                                                                                                                                                                                                                                                                                       |
| Store-port precedent                      | `packages/auth-plugin/src/stores/refresh-token-store.ts:54-71`                                                              | Async port, memory default exported beside it.                                                                                                                                                                                                                                                                                                                                                                        |
| Reserved session keys                     | `session-plugin/src/services/session-tenant-binding.ts:23`                                                                  | Framework-owned session data uses `__`-prefixed keys.                                                                                                                                                                                                                                                                                                                                                                 |
| Web Crypto (probe)                        | Deno 2.9.6, Node 24.18, Bun 1.4.2, workerd                                                                                  | ES256 (P-256), RS256 and Ed25519 verify from JWK on all four runtimes.                                                                                                                                                                                                                                                                                                                                                |
| `@simplewebauthn/server@14.0.3` (probe)   | installed from npm; imported on Deno, Node, Bun, workerd (no `nodejs_compat`)                                               | Imports and generates options on all four. Its docs state the default algorithms are `[EdDSA, ES256, RS256]`, but on Deno, Node and Bun it emitted `-48, -8, -7, -257` — **ML-DSA-44 is added where the runtime supports it**, and omitted on workerd. **Importing it installs a global `Reflect.getMetadata`** (`typeof` went `undefined` → `function` on Deno and Node), through its `reflect-metadata` dependency. |
| No framework reader of `Reflect` metadata | `grep -rn "Reflect.getMetadata" packages/*/src` → none; `decorator-plugin/src/index.ts:10` states no reflection is required | The global patch would not break the framework, but it is a process-wide side effect of loading an auth option.                                                                                                                                                                                                                                                                                                       |

Those two library facts decide §3.1.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                      | Resolution (picked side)                                                       | Doc deliverable (same PR)                   |
| -- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| C1 | `decorator-plugin` and AI_GUIDELINES state the framework needs no reflection library.                         | Keep that true: no runtime dependency that installs `reflect-metadata` (§3.1). | None needed; README records the reason.     |
| C2 | None other found (checked `PUBLIC_API.md` Auth section, `ARCHITECTURE.md` auth row, `auth-plugin/README.md`). | —                                                                              | README "Passkeys" section; `PUBLIC_API.md`. |

## 3. Design decisions

### 3.1 Zero-dependency verifier; the library is a test oracle only

- **Decision:** Implement verification in the plugin over `runtime.subtle`: a minimal CBOR decoder
  (unsigned and negative integers, byte and text strings, arrays, maps — definite lengths only,
  depth- and size-bounded), COSE-key to JWK conversion for EC2/P-256, RSA and OKP/Ed25519,
  `authenticatorData` parsing, and ECDSA DER-to-raw signature conversion (WebAuthn ES256 signatures
  are ASN.1 DER; Web Crypto expects raw `r‖s`). `@simplewebauthn/server` appears ONLY in tests, as a
  differential oracle.
- **Why:** With attestation `none` the verifier needs none of the X.509 parsing the library's
  dependencies exist for; and the library would install a global `Reflect` polyfill in every
  application that enables passkeys, and advertise an extra algorithm on some runtimes only (§1).
- **Test home:** `cbor.test.ts`, `cose-key.test.ts`, `webauthn-differential.test.ts`.

### 3.2 Registration

- **Decision:** For a signed-in principal: options carry a 32-byte challenge, `rp { id, name }`,
  `user { id: opaque per-principal handle, name, displayName }`, `pubKeyCredParams` exactly
  `[-8, -7, -257]`, `attestation: 'none'`,
  `authenticatorSelection: { residentKey: 'required', userVerification }` (default `required`) and
  `excludeCredentials` from the store. Verification requires:
  `clientDataJSON.type ===
  'webauthn.create'`; the challenge equal to the stored one; `origin` in
  the configured allowlist; `rpIdHash` equal to SHA-256 of the RP ID; user-present set, and
  user-verified set when required; attestation format `none` with an empty statement; an algorithm
  in the allowlist; a credential id not already stored.
- **Test home:** `registration.test.ts`.

### 3.3 Authentication

- **Decision:** Options carry a challenge, `rpId`, `userVerification` and an empty
  `allowCredentials` (discoverable). Verification requires `type === 'webauthn.get'`, challenge,
  origin, `rpIdHash`, flags as in §3.2, a stored credential for the returned id, a valid signature
  over `authenticatorData ‖ SHA-256(clientDataJSON)`, and a signature counter that is greater than
  the stored one unless both are zero (synced passkeys report zero). A counter that goes backwards
  is refused and reported through the logger thunk as a possible cloned authenticator. The stored
  credential's principal is resolved through `resolvePrincipal(principalId)`; the sign-in then calls
  `signIn(ctx, principal, { methods: [credential.backedUp ? 'swk' : 'hwk'] })` — a second-factor
  method, so no further factor is requested.
- **Test home:** `authentication.test.ts`.

### 3.4 Passkey as a second factor

- **Decision:** When a sign-in is pending (100d), the authentication ceremony is restricted to the
  pending principal's credentials (`allowCredentials` from the store) and, on success, calls
  `completeSecondFactor(ctx, 'hwk' | 'swk')` instead of `signIn`.
- **Test home:** `second-factor-passkey.test.ts`.

### 3.5 Challenges

- **Decision:** One challenge per session under `__setu_auth_webauthn`, holding the ceremony kind
  and a 5-minute expiry on `runtime.now()`; consumed before verification so a response can be
  submitted once. A new options request replaces it.
- **Test home:** `challenge.test.ts`.

### 3.6 Configuration and routes

- **Decision:**
  `signIn.passkeys: { rpId, rpName, origins, store, resolvePrincipal,
  userVerification? }`.
  Construction refuses an origin that is not `https` (loopback excepted) and an `rpId` that is not
  the origin's host or a registrable suffix of it. Routes under `<basePath>/passkeys`:
  `POST register/options`, `POST register/verify` (both require a signed-in principal),
  `POST login/options`, `POST login/verify`. The bodies are JSON; the ceremony binds each response
  to the origin, so a cross-site POST cannot produce a valid assertion.
- **Test home:** `passkey-options.test.ts`, `passkey-routes.test.ts`.

### 3.7 `IPasskeyStore`

- **Decision:** `listByPrincipal`, `findById`, `save`, `updateCounter`, `delete`, all async;
  `MemoryPasskeyStore` exported. Stored: credential id, principal id, public key (JWK), algorithm,
  counter, `backedUp`, transports, created time.
- **Test home:** `memory-passkey-store.test.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                       | Kind        | Consumer / real code path that READS it |
| ------------------------------------- | ----------- | --------------------------------------- |
| `PasskeyOptions`                      | type        | `SignInConfig.passkeys`.                |
| `IPasskeyStore`, `MemoryPasskeyStore` | type, class | `PasskeyOptions.store`.                 |
| `StoredPasskey`                       | type        | Store implementations.                  |

### 4.1 Options — every option names its consumer

| Option                      | Consumer              | Behavior                                          |
| --------------------------- | --------------------- | ------------------------------------------------- |
| `passkeys.rpId` / `rpName`  | options, verification | `rp` in options; `rpIdHash` check.                |
| `passkeys.origins`          | verification          | Exact-match allowlist.                            |
| `passkeys.userVerification` | options, verification | Default `required`; `preferred` accepts UV unset. |
| `passkeys.store`            | every ceremony        | §3.7.                                             |
| `passkeys.resolvePrincipal` | authentication        | Principal id → principal, `null` → 403.           |

## 5. Implementation files

| File                                                          | Purpose                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/auth-plugin/src/passkeys/cbor.ts`                   | Bounded CBOR decoder.                                                       |
| `packages/auth-plugin/src/passkeys/cose-key.ts`               | COSE → JWK, algorithm mapping.                                              |
| `packages/auth-plugin/src/passkeys/authenticator-data.ts`     | Flags, counter, attested credential data.                                   |
| `packages/auth-plugin/src/passkeys/signature.ts`              | DER→raw, verify.                                                            |
| `packages/auth-plugin/src/passkeys/ceremonies.ts`             | §3.2–3.4.                                                                   |
| `packages/auth-plugin/src/passkeys/routes.ts`                 | §3.6.                                                                       |
| `packages/auth-plugin/src/stores/passkey-store.ts`            | Port and memory store.                                                      |
| `packages/auth-plugin/src/index.ts`, `interfaces/index.ts`    | Exports, options.                                                           |
| `packages/auth-plugin/test/fixtures/virtual-authenticator.ts` | Software authenticator: ES256, RS256, EdDSA; CBOR encoder; counter control. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                        | src covered                  | Key assertions                                                                                                                            |
| ------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/cbor.test.ts`                         | `cbor.ts`                    | RFC 8949 Appendix A vectors for supported types; indefinite length, depth and size bounds refused.                                        |
| `test/unit/cose-key.test.ts`                     | `cose-key.ts`                | Each key type to JWK; unsupported algorithm refused.                                                                                      |
| `test/unit/authenticator-data.test.ts`           | `authenticator-data.ts`      | Flags, counter, truncated input refused.                                                                                                  |
| `test/unit/signature.test.ts`                    | `signature.ts`               | DER→raw for ES256 including leading-zero integers; real signatures verify.                                                                |
| `test/unit/registration.test.ts`                 | `ceremonies.ts`              | Every §3.2 refusal (wrong type, challenge, origin, RP hash, flags, format, algorithm, duplicate id).                                      |
| `test/unit/authentication.test.ts`               | `ceremonies.ts`              | Every §3.3 refusal; counter rules including both-zero; `backedUp` → `swk`.                                                                |
| `test/unit/challenge.test.ts`                    | `ceremonies.ts`              | Single use; expiry; replacement.                                                                                                          |
| `test/unit/memory-passkey-store.test.ts`         | `passkey-store.ts`           | CRUD and counter update.                                                                                                                  |
| `test/integration/passkey-routes.test.ts`        | `routes.ts`                  | Real kernel app + `SessionPlugin` + virtual authenticator: register, sign out, sign in username-less, `requireAuth` route 200.            |
| `test/integration/second-factor-passkey.test.ts` | `ceremonies.ts`, `routes.ts` | Password + passkey → `amr` has both; another user's passkey refused.                                                                      |
| `test/integration/webauthn-differential.test.ts` | all verification             | Every virtual-authenticator response is accepted or refused identically by this verifier and `npm:@simplewebauthn/server@14` (test-only). |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m100e-passkeys
deno task check:plan
deno task fmt:check && deno task lint && deno task check && deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% every changed src file
deno task check:docs
deno task publish:check && deno task release:verify <version>
```

A manual check in a real browser (Chrome's virtual authenticator and a platform authenticator) is
recorded in the PR; it is not committed, because CI installs no browser (the M37c precedent).

## 8. Risks & mitigations

- A hand-written CBOR decoder is attack surface → definite lengths only, a depth limit of 4, a size
  limit of 4 KiB, and refusal of every major type not listed; the differential test runs the same
  inputs through the reference implementation.
- Browsers differ in `backedUp` reporting → it only selects between `swk` and `hwk`, never
  admission.

## 9. Out of scope

- Attestation verification and trust roots; ML-DSA credentials; browser helpers; recovery when every
  passkey is lost.

## 10. Design security review — completed before implementation

**Reviewed flow:** options (challenge in session) → browser → response → challenge consumed → type,
challenge, origin, RP hash, flags → signature over `authenticatorData ‖ hash(clientData)` → counter
→ principal → `signIn` or `completeSecondFactor`.

| Finding                                              | Resolution in this plan                                   |
| ---------------------------------------------------- | --------------------------------------------------------- |
| Phishing via another origin.                         | Exact origin allowlist and `rpIdHash` check (§3.2, §3.3). |
| Replayed assertion.                                  | Single-use session challenge (§3.5).                      |
| Cloned authenticator.                                | Backwards counter refused and reported (§3.3).            |
| Malformed CBOR as a denial of service.               | Bounded decoder (§8).                                     |
| Registering a second copy of a credential.           | Duplicate id refused; `excludeCredentials` (§3.2).        |
| Another user's passkey completing a pending sign-in. | Ceremony restricted to the pending principal (§3.4).      |
| Global side effects from a dependency.               | No runtime dependency (§3.1).                             |

The implementation audit submits a valid assertion for the wrong origin, the same assertion twice,
an assertion with a lowered counter, and a registration response carrying `fmt: 'packed'`.
