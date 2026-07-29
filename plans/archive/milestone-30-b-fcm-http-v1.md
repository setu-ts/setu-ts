# Milestone 30b — Notification Plugin (`@hono-enterprise/notification-plugin`)

> **Status:** Planning. Branch: `feat/m30b-fcm-http-v1`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

M30's `FcmProvider` posts to `https://fcm.googleapis.com/fcm/send` with
`Authorization: key=<serverKey>` — the **legacy FCM API Google decommissioned in 2024**. Every send
against a real project fails, so the `push` channel is non-functional as shipped and the plugin's
own README, PUBLIC_API, CHANGELOG and CLAUDE.md all record it as a known limitation. This milestone
replaces it with **FCM HTTP v1**: OAuth2 bearer tokens minted from a service account by signing an
RS256 JWT with `runtime.subtle`, and the v1 `messages:send` endpoint and payload shape. Zero npm
dependencies, Workers-portable — the same posture as the other three providers, and the same crypto
approach M16's `JwtService` already proves.

- **In scope:** `FcmProviderOptions` replaced with a service-account shape (**breaking**, maintainer
  decision §2/C1); an internal `FcmTokenSource` port with a default `ServiceAccountTokenSource` (JWT
  assertion → `oauth2.googleapis.com/token` → cached access token) plus an injectable seam for
  tests; a local `pemToDer` helper; the v1 endpoint + `{ message: { token, notification } }`
  payload; `createProvider`'s `fcm` arm taking `IPluginContext` so the provider reaches
  `runtime.subtle` / `runtime.now()`; the doc corrections in PUBLIC_API, plugin README, ROADMAP,
  CHANGELOG and CLAUDE.md in the same PR.
- **NOT this milestone:** FCM topic/condition targeting, `data`-only messages, per-platform
  (`android`/`apns`/`webpush`) override blocks, and multicast/batch send — all v1 features the
  committed `PushMessage` (`to`/`title`/`body`) cannot express; widening it is a **future M30c**
  with its own `common`-adjacent design. APNs/WNS as separate push providers. Any change to
  `INotifier`, `NotificationMessage`, or the `NOTIFICATION` token.

## 1. Contracts verified from SOURCE (not names)

| Reference                       | Source (file:line)                                                                                                   | Verified surface / fact                                                                                                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FcmProvider` (as shipped)      | `packages/notification-plugin/src/providers/fcm-provider.ts:47-56`                                                   | Posts to `https://fcm.googleapis.com/fcm/send` with `Authorization: key=${serverKey}`; body `{ to, notification: { title?, body } }`. This is the decommissioned legacy API — the defect.                                                                                                                  |
| `FcmProviderOptions`            | `packages/notification-plugin/src/interfaces/index.ts:263-266`                                                       | `{ serverKey: string; http?: INotificationHttp }`. `serverKey` is the dead credential; replaced wholesale (§3.1).                                                                                                                                                                                          |
| `PushTransport` / `PushMessage` | `packages/notification-plugin/src/interfaces/index.ts:67-86`                                                         | `send(message): Promise<void>`; `PushMessage = { to: string; title?: string; body: string }`. **Unchanged** — v1's richer targeting has no home here, hence the M30c deferral.                                                                                                                             |
| `createProvider` overloads      | `packages/notification-plugin/src/plugin/notification-plugin.ts:146-150`                                             | `fcm` arm is `createProvider(config: FcmChannelConfig): PushTransport` — **no `ctx`**. Only the `mail` arm takes `IPluginContext` (:146). Must gain `ctx` for the provider to reach the runtime.                                                                                                           |
| `createProvider` mail arm       | `packages/notification-plugin/src/plugin/notification-plugin.ts:160-167`                                             | Precedent for a ctx-dependent arm that **throws during `register`** when the dependency is absent. The fcm arm follows it exactly (§3.2).                                                                                                                                                                  |
| Channel construction            | `packages/notification-plugin/src/plugin/notification-plugin.ts:115-121`                                             | `new PushChannel(name, createProvider(config))` at :119 — call site must thread `ctx`. `PushChannel` itself is untouched.                                                                                                                                                                                  |
| `INotificationHttp`             | `packages/notification-plugin/src/interfaces/index.ts:135-150`                                                       | `post(url, body, headers): Promise<NotificationHttpResponse>`. Headers are caller-supplied, so the form-encoded OAuth2 token exchange rides this same seam — no new port, no `fetch` in the provider.                                                                                                      |
| `IRuntimeServices.subtle`       | `packages/common/src/runtime.ts:212`                                                                                 | `readonly subtle: SubtleCrypto`. The signing primitive; no npm dependency needed.                                                                                                                                                                                                                          |
| `IRuntimeServices.now`          | `packages/common/src/runtime.ts:219`                                                                                 | `now(): number` — epoch ms. Correct clock for a token `exp` (a wall-clock deadline the remote also evaluates), NOT `hrtime()`. Cache expiry uses this deliberately.                                                                                                                                        |
| RS256 precedent                 | `packages/auth-plugin/src/services/jwt-service.ts:71-74,140`                                                         | `importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])` then `subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, data)`. Exactly FCM's RS256 assertion requirement.                                                                                                        |
| `pemToDer`                      | `packages/auth-plugin/src/utils/pem.ts:21`                                                                           | Exists, handles `'PRIVATE KEY'` (PKCS#8) and tolerates trailing newlines — but is **internal to auth-plugin** and absent from its barrel (`grep -n pem packages/auth-plugin/src/index.ts` → nothing). AI_GUIDELINES §2.2/§3.3 forbid the cross-package import, so notification-plugin gets its own (§3.4). |
| `NotificationHttpResponse`      | `packages/notification-plugin/src/interfaces/index.ts` (`ok/status/text`)                                            | The `{ ok, status, text }` shape the token exchange parses and the send-path error message quotes.                                                                                                                                                                                                         |
| Existing FCM tests              | `packages/notification-plugin/test/unit/fcm-provider.test.ts`                                                        | Drives the provider through a fake `INotificationHttp`; asserts the legacy URL/header. Rewritten (§6) — its current assertions encode the decommissioned API.                                                                                                                                              |
| Doc claims to correct           | `PUBLIC_API.md:3183,3225,3269`; `packages/notification-plugin/README.md:65`; `CHANGELOG.md:143`; `CLAUDE.md:378-380` | Four committed docs state FCM is legacy/non-functional. All become false; each is a named deliverable (§2).                                                                                                                                                                                                |

**External facts (FCM HTTP v1 — not greppable, stated so review can check them):** endpoint
`POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send`; body
`{ "message": { "token": "<device>", "notification": { "title": "…", "body": "…" } } }`; auth
`Authorization: Bearer <access_token>`. Token exchange: `POST https://oauth2.googleapis.com/token`,
`application/x-www-form-urlencoded`, fields `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
and `assertion=<signed JWT>`; JWT header `{ alg: 'RS256', typ: 'JWT' }`, claims
`{ iss: clientEmail, scope:
'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token',
iat, exp }`
with `exp` ≤ 1h out. Response `{ access_token, expires_in, token_type }`.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                              | Resolution (picked side)                                                                                                                                                                                                                                     | Doc deliverable (same PR)                                                                            |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| C1 | `FcmProviderOptions.serverKey` is a published export (`0.1.0-alpha.1`); AI_GUIDELINES §9.4 forbids removing one silently.                             | **Replace outright** (maintainer decision). §9.2's deprecate-then-remove assumes a working replacement path; `serverKey` addresses an endpoint that no longer exists, so keeping it preserves a guaranteed-401. A compile error is the correct, loud signal. | CHANGELOG **BREAKING** entry with the before→after config; PUBLIC_API options table row replaced.    |
| C2 | `PUBLIC_API.md:3183` shows `options: { serverKey: config.get('FCM_SERVER_KEY') }`; :3225 documents `options.serverKey`; :3269 says v1 is unsupported. | All three describe the removed shape. Rewrite to the service-account options and drop the "targets the legacy API" note.                                                                                                                                     | Edit `PUBLIC_API.md` §Notifications example, options table, and the notes block.                     |
| C3 | `packages/notification-plugin/README.md:65` states the provider implements the decommissioned legacy API.                                             | Becomes false. Replace with a v1 description + the service-account setup snippet.                                                                                                                                                                            | Edit the README push section.                                                                        |
| C4 | `CHANGELOG.md:143` lists FCM non-functionality under `[0.1.0-alpha.1]`'s **Known limitations** — a historical record.                                 | **Do not rewrite history** (JSR versions are immutable; it was true of that release). Annotate as superseded and point forward, exactly as M14d did for the Kafka entry.                                                                                     | Append a `_(Superseded — see [Unreleased]…)_` note to that bullet; add the fix under `[Unreleased]`. |
| C5 | `CLAUDE.md:378-380` records the limitation and calls v1 "a follow-up".                                                                                | This milestone _is_ that follow-up. Update the M30 entry's tail and add the M30b status entry.                                                                                                                                                               | Edit `CLAUDE.md` Current status.                                                                     |

## 3. Design decisions

### 3.1 `FcmProviderOptions` becomes a service-account shape

- **Decision:**
  `FcmProviderOptions = { projectId: string; clientEmail: string; privateKey: string; http?: INotificationHttp; tokenSource?: FcmTokenSource }`.
  `serverKey` is removed. The constructor throws a message naming each missing required field,
  matching the existing fail-at-construction behavior (`fcm-provider.ts:27`).
- **Why:** v1 addresses a project (`projectId` in the URL) and authenticates as a service account
  (`clientEmail` + `privateKey` sign the assertion); no subset of the old options can express that.
  Three discrete fields rather than the raw service-account JSON blob keeps each one wireable from
  `SecretsPlugin`/config independently and avoids coupling the option shape to Google's file format.
- **Test home:** `fcm-provider.test.ts` — construction throws once per missing field; a fully
  specified construction succeeds.

### 3.2 The `fcm` arm of `createProvider` takes `IPluginContext`, and fails fast without it

- **Decision:** overload becomes
  `createProvider(config: FcmChannelConfig, ctx?: IPluginContext): PushTransport`; the call site at
  `notification-plugin.ts:119` passes `ctx`. When `ctx` is absent or `CAPABILITIES.RUNTIME` is
  unregistered, the arm **throws during `register`** with a message naming RuntimePlugin — never at
  first send.
- **Why:** the provider needs `runtime.subtle` and `runtime.now()`, and nothing else in this package
  can supply them. The `mail` arm (`:160-167`) already establishes throw-at-register for a missing
  capability; a push channel that only fails on the first notification is strictly worse, since the
  failure surfaces in production traffic rather than at boot.
- **Test home:** `notification-plugin.test.ts` — a `push` channel registered without a runtime
  provider throws at `register()`; one registered with it resolves and sends.

### 3.3 Internal `FcmTokenSource` port; default `ServiceAccountTokenSource` caches the access token

- **Decision:** an internal port `FcmTokenSource { getAccessToken(): Promise<string> }`, defaulted
  to `ServiceAccountTokenSource` (built from `runtime` + `http` + the three options) and overridable
  via `FcmProviderOptions.tokenSource`. The default builds the RS256 assertion, POSTs the
  form-encoded exchange through `INotificationHttp`, and caches `access_token` until
  `now() + expires_in*1000 - 60_000` (a 60 s safety margin), refreshing on the next call past that.
  A non-OK exchange throws with status and body. The signing key is imported once and cached, per
  the M16 `cachedSignKey` precedent (`jwt-service.ts:59`).
- **Why:** minting a JWT and round-tripping OAuth2 per notification would add ~2 network calls and
  an RSA signature to every send; tokens are valid ~1 h. The port keeps the real path honest (the
  default genuinely signs and exchanges — not a `globalThis` shim) while letting tests assert cache
  hits, expiry refresh, and error propagation deterministically without RSA keys, mirroring how
  `INotificationHttp` makes the other providers testable.
- **Test home:** new `service-account-token-source.test.ts` — signs and exchanges once for two sends
  (cache hit); refreshes after simulated expiry via a controllable `now()`; propagates a non-OK
  exchange; sends the exact `grant_type`/`assertion` form fields and
  `application/x-www-form-urlencoded` content type. Plus one **real-crypto** test that signs with an
  actual `subtle`-generated RSA keypair and verifies the signature, so the signing path is exercised
  for real rather than only through a fake token source.

### 3.4 A local `pemToDer`, deliberately not shared with auth-plugin

- **Decision:** `src/providers/pem.ts` in notification-plugin, a `pemToDer(pem, label)` equivalent
  to auth-plugin's, handling PKCS#8 `-----BEGIN PRIVATE KEY-----` and tolerating `\r\n` and trailing
  blank lines (service-account JSON commonly carries `\n`-escaped keys).
- **Why:** auth-plugin's copy (`utils/pem.ts:21`) is internal and not barrel-exported, and
  AI_GUIDELINES §2.2/§3.3 forbid a plugin importing another plugin — so reuse is not available.
  §11.1's DRY rule scopes to "the owning package". Promoting it to `common` would be a public-API
  change to the one package every other depends on, for a single extra consumer; that is a larger
  commitment than this milestone should make unilaterally, and is noted in §9 as the alternative if
  a third consumer appears.
- **Test home:** new `pem.test.ts` — valid PKCS#8 round-trips to DER; wrong label, missing footer,
  and empty body each throw; `\r\n` and trailing newlines are tolerated.

### 3.5 v1 endpoint and payload mapping

- **Decision:** `POST https://fcm.googleapis.com/v1/projects/${projectId}/messages:send` with
  `Authorization: Bearer <token>` and `Content-Type: application/json`; body
  `{ message: { token: message.to, notification: { ...(title !== undefined && { title }), body } } }`.
  A non-OK response throws `FCM API error (${status}): ${text}` — the existing message format, kept
  so consumers matching on it are unaffected.
- **Why:** `PushMessage.to` is a device registration token, which v1 carries as `message.token`. The
  conditional `title` preserves the shipped behavior of omitting it rather than sending `undefined`
  (`fcm-provider.ts:40-44`), and `exactOptionalPropertyTypes` requires the spread form.
- **Test home:** `fcm-provider.test.ts` — asserts the exact URL including `projectId`, the `Bearer`
  header, and the nested body **field-by-field** with `title` present in one case and **absent**
  (not `undefined`) in the other; non-OK throws with status and text.

## 4. Exported surface — every symbol names its consumer

`FcmTokenSource` is exported as a **type** so a consumer can supply `tokenSource` (e.g. to source
tokens from a metadata server on GCP); `ServiceAccountTokenSource` and `pemToDer` stay internal.

| Exported symbol      | Kind                        | Consumer / real code path that READS it                                                                                                            |
| -------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FcmProvider`        | class (already exported)    | `createProvider`'s `fcm` arm (`notification-plugin.ts:174`); app code constructing it directly.                                                    |
| `FcmProviderOptions` | type (already exported)     | `FcmChannelConfig.options` (`interfaces/index.ts:183`); read field-by-field by the `FcmProvider` constructor.                                      |
| `FcmTokenSource`     | type (**new**)              | The `tokenSource` option's type; implemented by the internal default and by any consumer overriding token acquisition. Read by `FcmProvider.send`. |
| `createProvider`     | function (already exported) | `NotificationPlugin` register path; its `fcm` overload gains the `ctx` parameter.                                                                  |

Internal (not exported from `index.ts`): `ServiceAccountTokenSource` (the default `FcmTokenSource`,
constructed by `FcmProvider` when `tokenSource` is omitted) and `pemToDer` (read by
`ServiceAccountTokenSource` to import the signing key).

### 4.1 Options — every option names its consumer

| Option        | Consumer                     | Behavior (per implementation)                                                                                                                                                           |
| ------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`   | `FcmProvider.send`           | Interpolated into the v1 `messages:send` URL. Required; construction throws when absent.                                                                                                |
| `clientEmail` | `ServiceAccountTokenSource`  | The JWT assertion's `iss` claim. Required; construction throws when absent.                                                                                                             |
| `privateKey`  | `ServiceAccountTokenSource`  | PEM PKCS#8, decoded by `pemToDer` and imported once as an `RSASSA-PKCS1-v1_5`/`SHA-256` signing key. Required; construction throws when absent.                                         |
| `http`        | `FcmProvider` + token source | Injectable `INotificationHttp`; both the token exchange and the send ride it. Defaults to `createDefaultNotificationHttp()`. (Pre-existing.)                                            |
| `tokenSource` | `FcmProvider.send`           | Overrides access-token acquisition wholesale; when omitted a `ServiceAccountTokenSource` is built from the three fields above. Used by every unit test that is not the real-crypto one. |

## 5. Implementation files

| File                                                             | Purpose                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/notification-plugin/src/providers/fcm-provider.ts`     | Rewritten to v1: new options, `projectId` URL, `Bearer` auth, `{ message: { token, notification } }` payload, token delegation. |
| `packages/notification-plugin/src/providers/token-source.ts`     | **NEW.** `FcmTokenSource` port + `ServiceAccountTokenSource` (JWT assertion, OAuth2 exchange, key + token caching).             |
| `packages/notification-plugin/src/providers/pem.ts`              | **NEW.** Local `pemToDer` (§3.4). Internal.                                                                                     |
| `packages/notification-plugin/src/interfaces/index.ts`           | `FcmProviderOptions` replaced; `FcmTokenSource` re-exported as a type.                                                          |
| `packages/notification-plugin/src/plugin/notification-plugin.ts` | `fcm` overload gains `ctx`; call site at :119 threads it; fail-fast throw when runtime is unavailable.                          |
| `packages/notification-plugin/src/index.ts`                      | Export the `FcmTokenSource` type.                                                                                               |

Doc deliverables (same PR, no code): `PUBLIC_API.md` (C2), plugin `README.md` (C3), `CHANGELOG.md`
(C1 BREAKING + C4 superseded annotation), `ROADMAP.md` (M30b section + `30b` progress row),
`CLAUDE.md` (C5).

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                         | src covered                         | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/fcm-provider.test.ts` **(rewritten)**                  | `src/providers/fcm-provider.ts`     | Exact v1 URL including `projectId`; `Authorization: Bearer <token>`; body asserted field-by-field with `title` **present** in one case and **absent** in the other; non-OK throws `FCM API error (<status>): <text>`; construction throws once per missing required field. Driven with an injected `tokenSource` + fake `http`.                                                                                                                                                                                |
| `test/unit/service-account-token-source.test.ts` **(NEW)**        | `src/providers/token-source.ts`     | Cache hit (two sends → one exchange); refresh after expiry via controllable `now()`; the 60 s safety margin refreshes _before_ the nominal deadline; non-OK exchange throws with status/body; the exchange posts `application/x-www-form-urlencoded` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and an `assertion`. **Plus a real-crypto test**: sign with a `subtle.generateKey` RSA keypair, then `subtle.verify` the assertion — the signing path runs for real, not only behind a fake. |
| `test/unit/pem.test.ts` **(NEW)**                                 | `src/providers/pem.ts`              | Valid PKCS#8 → DER bytes; wrong label, missing footer, empty body throw; `\r\n` and trailing blank lines tolerated.                                                                                                                                                                                                                                                                                                                                                                                            |
| `test/unit/notification-plugin.test.ts` **(updated)**             | `src/plugin/notification-plugin.ts` | A `push` channel without a runtime provider throws at `register()` naming RuntimePlugin; with one, it registers and `createProvider(fcmConfig, ctx)` returns a working transport. Existing mail/twilio/slack arms unchanged.                                                                                                                                                                                                                                                                                   |
| `test/unit/push-channel.test.ts` **(unchanged)**                  | `src/channels/push-channel.ts`      | `PushChannel` is untouched; re-run to prove the address/title mapping still holds and coverage did not drop.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/unit/barrel-exports.test.ts` **(updated)**                  | `src/index.ts`                      | `FcmTokenSource` is exported; nothing else added or removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/integration/notification-integration.test.ts` **(updated)** | plugin + channels                   | Through a real kernel app with a runtime provider: a `push` channel notifies end-to-end against a fake `http`, hitting the v1 URL with a Bearer token.                                                                                                                                                                                                                                                                                                                                                         |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m30b-fcm-http-v1, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Plus the CLAUDE.md end-of-task audit:

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/notification-plugin/src
grep -rn "serverKey\|fcm/send" packages/notification-plugin/src   # the dead API must be GONE
```

## 8. Risks & mitigations

- **The v1 protocol facts are external and cannot be grepped.** → Stated explicitly at the end of §1
  so a reviewer can check them against Google's docs; the real-crypto signing test proves the
  assertion is a valid RS256 JWT, and the field-by-field payload assertions pin the wire shape.
- **No end-to-end proof against real FCM.** Sending requires a live Firebase project and
  credentials, which CI cannot hold (AI_GUIDELINES §6.7). → The real-crypto test covers the half
  that is self-verifiable (signing); the HTTP half is asserted field-by-field. This limit is stated
  in the PR rather than implied.
- **Breaking a published option shape.** → Deliberate (C1), maintainer-approved,
  CHANGELOG-documented with before→after config, and a compile error rather than a runtime surprise.
- **Coverage regression in `notification-plugin.ts`** from the new ctx branch. → §6 names the two
  tests that drive both sides; per-file table re-read after the change and compared to a `main`
  baseline, not just checked against the 90 threshold.
- **A cached token outliving its validity** if the clock source is wrong. → Expiry uses
  `runtime.now()` (wall clock, §1) because the remote evaluates `exp` on wall clock; the 60 s margin
  absorbs skew, and a test drives the boundary.

## 9. Out of scope

- **FCM topic/condition targeting, `data`-only messages, per-platform override blocks, multicast** —
  all need a wider `PushMessage` than the committed `{ to, title?, body }`. A future **M30c** owns
  the contract widening; this milestone deliberately does not widen a committed type.
- **Promoting `pemToDer` into `common`** — the right move only if a third consumer appears (§3.4);
  today it would be a public-API change to `common` for one extra caller.
- **APNs / WNS push providers** — separate transports behind the same `PushTransport` port; no
  milestone assigned.
- **Rotating or refreshing service-account keys at runtime** — the key is read once from options;
  rotation is a redeploy, consistent with every other credential in the plugin.
