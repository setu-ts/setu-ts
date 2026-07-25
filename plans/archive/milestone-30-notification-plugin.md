# Milestone 30 — Notification Plugin (`@hono-enterprise/notification-plugin`)

> **Status:** Complete. Branch: `feat/30-notification-plugin`. `main` is protected — all work
> (implementation + fixes) stayed on this one branch and merges via a single PR. Deviations decided
> during verification are recorded in §10.

## 0. Objective & scope

Provide multi-channel notifications as a plugin. `NotificationPlugin(options)` registers the
committed `INotifier` contract under `CAPABILITIES.NOTIFICATION`, backed by a two-layer design:
named **channels** (own address extraction plus payload shaping per channel type) wrapping pluggable
**providers** (the transport). Four channel types ship — `EmailChannel` (delegates to the resolved
`IMailer` from M29), `SmsChannel` (`TwilioProvider`), `PushChannel` (`FcmProvider`), and
`SlackChannel` (`SlackProvider`). The three providers are zero-dependency, built on web-standard
`fetch` behind a shared injectable `INotificationHttp` seam, so they run on every runtime including
Cloudflare Workers (the ROADMAP migration note confirms all channels are HTTP-API based and
Workers-portable). `NotificationService` fans a single `send(NotificationMessage)` out across the
requested channels and throws `AggregateError` when any fail — the exact committed `INotifier`
surface (one method).

- **In scope:** the `INotifier` implementation (`NotificationService`), the four channels, the three
  HTTP providers, the shared `INotificationHttp` seam plus its `fetch`-backed default, the plugin
  factory with `createChannel`/`createProvider`, a `notification` health indicator, and full
  per-file test coverage (≥90% branch/function/line).
- **NOT this milestone:** per-channel delivery retries, rate limiting, templating, and queuing
  (compose `queue-plugin` M15 and `resilience-plugin` M27 at the app layer); inbound notification
  receipts / webhooks (app concern); FCM HTTP v1 with OAuth2 service-account JWT signing (deferred —
  M30 ships the legacy `serverKey` HTTP API that the committed PUBLIC_API option names);
  notification analytics / read receipts (no owning milestone). The email channel delegates
  transport to M29's `MailPlugin`; it does not re-implement SMTP, SES, or SendGrid.

## 1. Contracts verified from SOURCE (not names)

| Reference                                 | Source (file:line)                                   | Verified surface / fact                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `INotifier`                               | `packages/common/src/services/notification.ts:41`    | `send(notification: NotificationMessage): Promise<void>`; `@throws {AggregateError}` if one or more channels fail. ONLY `send` — no `sendEmail`, `sendSms`, `sendSlack` (those appear in ROADMAP/PUBLIC_API examples but not in the committed type).                                                   |
| `NotificationMessage`                     | `packages/common/src/services/notification.ts:13`    | `channels: readonly string[]` (req), `to: Readonly<Record<string, string>>` (req), `subject?: string`, `body: string` (req), `metadata?: Readonly<Record<string, unknown>>`; all `readonly`.                                                                                                           |
| `CAPABILITIES.NOTIFICATION`               | `packages/common/src/tokens.ts:83`                   | `NOTIFICATION: 'notification'` — token grammar is lowercase kebab, already committed (no new token, no `common` change).                                                                                                                                                                               |
| `IMailer` / `MailMessage`                 | `packages/common/src/services/mail.ts:40,13`         | `send(MailMessage): Promise<void>`; `MailMessage.to` (req), `from?`, `subject` (req), `html?`, `text?`, `cc?`, `bcc?`. The email channel builds this shape and calls `send`.                                                                                                                           |
| `IPlugin`                                 | `packages/common/src/plugin.ts:470`                  | `name`, `version`, `provides`, `optionalDependencies`, `consumes`, `priority`, `register(ctx): void \| Promise<void>` — mirrors `SecretsPlugin`/`MailPlugin`.                                                                                                                                          |
| `IPluginContext`                          | `packages/common/src/plugin.ts:409`                  | has `services`, `health`, `lifecycle`, `runtime` (non-optional), and `logger?: ILogger` directly (no need to resolve `CAPABILITIES.LOGGER`).                                                                                                                                                           |
| `IHealthApi.register`                     | `packages/common/src/plugin.ts:187`                  | `register(name: string, indicator: HealthIndicatorFn): void`.                                                                                                                                                                                                                                          |
| `HealthIndicatorFn` / `HealthCheckResult` | `packages/common/src/services/health.ts:26,13`       | `() => Promise<HealthCheckResult>`; result `{ status: HealthStatus; data?: Readonly<Record<string, unknown>> }`, status `'up' \| 'down'`.                                                                                                                                                              |
| `optionalDependencies` ordering           | `packages/kernel/src/registry/plugin-resolver.ts:49` | An edge is added only when the provider is present; absent ⇒ no edge, no throw. So declaring `optionalDependencies: ['mail']` guarantees MailPlugin registers before this plugin WHEN MailPlugin is present, and resolves `IMailer` safely at registration; when MailPlugin is absent it is tolerated. |
| `PLUGIN_PRIORITY.NORMAL`                  | `packages/common/src/types.ts:84`                    | `500` (default band for capability plugins).                                                                                                                                                                                                                                                           |
| M29 `MailPlugin` precedent                | `packages/mail-plugin/src/`                          | registers `IMailer` under `CAPABILITIES.MAIL`; this plugin resolves it by token only (no package import), satisfying "no plugin imports another plugin".                                                                                                                                               |
| ROADMAP M30 file list                     | `ROADMAP.md:3118`                                    | mandates `channels/{email,sms,push,slack}-channel.ts` + `providers/{twilio,fcm,slack}-provider.ts` + `services/notification-service.ts` + `plugin/notification-plugin.ts` (this plan follows it verbatim, adding only the shared `interfaces` and `http` modules the design needs).                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                      | Resolution (picked side)                                                                                                                                                                                                                | Doc deliverable (same PR)                                                                                                                                                                                                        |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md:2868` shows `notifier.sendSlack({ channel, message })`, but the committed `INotifier` (`notification.ts:41`) has ONLY `send`.                                                                                                                                                                                  | Honor the committed contract — implement `send` only; Slack dispatch goes through `send({ channels: ['slack'], to: { channel: '#orders' }, body: '...' })`. No `sendSlack` method is added.                                             | Correct the PUBLIC_API.md Notifications usage example to use `send` for Slack.                                                                                                                                                   |
| C2 | `ROADMAP.md:3112-3113` shows `notifier.sendEmail(...)` and `notifier.sendSms(...)`, neither present on the committed `INotifier`.                                                                                                                                                                                             | Honor the committed contract — single-channel dispatch uses `send({ channels: ['email'], to: { email }, subject, body })` and `send({ channels: ['sms'], to: { phone }, body })`. No convenience methods ship.                          | Correct the ROADMAP M30 programmatic-API example to the committed `send` surface.                                                                                                                                                |
| C3 | `ROADMAP.md:3091` registers `email: { provider: 'mail', options: {...} }` (with options) while `PUBLIC_API.md:2841` registers `email: { provider: 'mail' }` (no options). The email channel delegates to the resolved `IMailer`, which M29's MailPlugin already configures — there is no consumer for an email `options` bag. | Drop the email `options`: the email entry is `{ provider: 'mail' }` and ignores any `options`. Mail transport config lives on `MailPlugin`. This removes a planned option with no consumer (the dead-option rule applied at plan time). | Align both docs to `email: { provider: 'mail' }` (no options).                                                                                                                                                                   |
| C4 | `PUBLIC_API.md`'s Notifications registration example passes Twilio `options: { accountSid, authToken }` with NO `from`, but `from` is a required Twilio credential — running the documented example verbatim throws `TwilioProvider requires "from"` at startup. (Caught in verification, not at plan time.)                  | Honor the provider requirement: `from` stays required, and the omission becomes a COMPILE error rather than a startup throw by discriminating `ChannelConfig` on `provider` (§10.1).                                                    | Add `from` to the PUBLIC_API registration example, and add the missing Notifications **Options**/**Exports**/**Notes** subsections — every sibling package section has them and the new `src/index.ts` surface was undocumented. |

## 3. Design decisions

### 3.1 Two-layer `NotificationChannel` + transport ports

- **Decision:** an internal `NotificationChannel` port — `readonly name: string`;
  `send(notification: NotificationMessage): Promise<void>` — NOT exported as a concrete type (only
  its implementations are exported, like M29's providers). Each channel depends on a minimal
  transport interface: `SmsTransport`/`SmsMessage`, `PushTransport`/`PushMessage`,
  `SlackTransport`/`SlackMessage`, and `IMailer` for email. `TwilioProvider` implements
  `SmsTransport`, `FcmProvider` implements `PushTransport`, `SlackProvider` implements
  `SlackTransport`. The channel owns address extraction and payload shaping; the provider owns the
  HTTP transport.
- **Why:** mirrors the M29 service-to-provider split and keeps each layer independently
  unit-testable — channels with fake transports, providers with a fake `INotificationHttp`. The
  transport interfaces are exported so consumers can inject custom transports or test doubles (the
  M29 facade-export precedent).
- **Test home:** `*-channel.test.ts` (fake transport records the shaped call) and
  `*-provider.test.ts` (fake `INotificationHttp` records the HTTP call).

### 3.2 Multi-channel dispatch and `AggregateError`

- **Decision:** `NotificationService` holds a `Map<string, NotificationChannel>`.
  `send(notification)` resolves each name in `notification.channels` against the map; an unknown
  name is recorded as an error `Error('Unknown notification channel: <name>')`. It dispatches every
  resolved channel in parallel with `Promise.allSettled`, collects every rejection **coerced to
  `Error` via a shared `toError(reason)` helper**
  (`reason instanceof Error ? reason : new Error(String(reason))` — both arms exist because a
  channel may reject with a non-`Error` value, e.g. a thrown string), and when one or more errors
  exist throws `new AggregateError(errors, 'One or more notification channels failed')`. An empty
  `channels` array resolves with no dispatch (no throw).
- **Why:** the committed contract's `@throws {AggregateError}` is honored exactly;
  `Promise.allSettled` means one failing channel never aborts the others, and the built-in
  `AggregateError` carries every per-channel error for the caller. `toError` guarantees
  `AggregateError.errors` holds only `Error` instances regardless of what a channel throws.
- **Test home:** `notification-service.test.ts` — all-channels-success; one channel rejects **with
  an `Error`** ⇒ `AggregateError` whose `.errors` contains that exact error and the other channel
  still received the call; one channel rejects **with a non-`Error`** (thrown string) ⇒
  `AggregateError` whose matching `.errors` entry is an `Error` wrapping that value (`toError`
  else-arm); unknown channel name ⇒ `AggregateError`; empty `channels` ⇒ resolves; a single failing
  channel ⇒ `AggregateError` (not a bare throw).

### 3.3 Email channel ↔ `MailPlugin` coupling via capability token

- **Decision:** `NotificationPlugin` declares `optionalDependencies: [CAPABILITIES.MAIL]` (see §10.3
  — the planned `CAPABILITIES.LOGGER` entry was dropped: nothing in this package reads a logger, so
  the edge was dead surface). The `mail` provider path resolves
  `ctx.services.get<IMailer>(CAPABILITIES.MAIL)` during `register`; if the `email` channel is
  configured but no mail capability is registered, `register` throws
  `Error('Notification "email" channel requires the mail capability (CAPABILITIES.MAIL); register
  MailPlugin (M29) or remove the email channel')`
  (fail fast). `EmailChannel.send` then calls
  `mailer.send({ to: notification.to.email, subject: notification.subject ?? '(no subject)',
  text: notification.body })`
  and throws `Error('Email channel requires "to.email"')` when the address is absent.
- **Why:** `optionalDependencies` imposes ordering only when MailPlugin is present (verified at
  `plugin-resolver.ts:49`), so resolution at registration is safe and surfaces misconfiguration at
  startup rather than at first send. The coupling is token-only — no plugin imports another plugin
  (§3.3 ROADMAP). The default subject `'(no subject)'` satisfies the committed `MailMessage.subject`
  requirement while keeping `NotificationMessage.subject` optional (SMS and push do not use a
  subject).
- **Test home:** `notification-plugin.test.ts` (email channel + no MailPlugin ⇒ throws; email
  channel + injected fake `IMailer` ⇒ resolves and the channel holds it) and `email-channel.test.ts`
  (shaped `MailMessage`, default subject, missing-address throw).

### 3.4 Provider HTTP strategy — zero-dependency `fetch`, no `npm:` SDKs

- **Decision:** `TwilioProvider`, `FcmProvider`, and `SlackProvider` are zero-dependency and built
  on web-standard `fetch` behind one shared injectable `INotificationHttp` seam
  (`post(url, body, headers): Promise<{ ok; status; text }>`), defaulting to
  `createDefaultNotificationHttp()`. Because every channel is a plain HTTP API, there are NO `npm:`
  imports and therefore NO guarded real-import tests. Twilio uses HTTP Basic auth over a
  form-encoded POST to `https://api.twilio.com/2010-04-01/Accounts/<sid>/Messages.json`; FCM uses
  the legacy server-key API (see 3.5); Slack uses an incoming-webhook JSON POST. Each provider
  throws when the response is not OK. `SlackProvider` treats a response as failed on a compound
  condition — it throws when `!response.ok` and, separately, when `response.text !== 'ok'` — because
  a Slack incoming webhook signals success only with HTTP 200 and the literal body `ok`; the two
  failure arms are asserted by separate test cases (see §6).
- **Why:** the ROADMAP migration note states all channels are HTTP-API based and Workers-portable;
  `fetch` is a web standard available on Node, Deno, Bun, and Workers, so no §12.2 lazy SDK import
  is needed. The injectable `INotificationHttp` makes every provider deterministically unit-testable
  with a recording fake and no network.
- **Test home:** `twilio-provider.test.ts`, `fcm-provider.test.ts`, `slack-provider.test.ts`
  (recording fake `INotificationHttp`: assert URL, headers, body; non-2xx ⇒ throws; missing required
  option ⇒ throws at construction); `default-http.test.ts` (`createDefaultNotificationHttp` with a
  fake `fetchImpl` constructs the POST and maps the response to `{ ok, status, text }`).

### 3.5 FCM legacy server-key API

- **Decision:** `FcmProvider` targets the legacy FCM HTTP API —
  `POST https://fcm.googleapis.com/fcm/send` with header `Authorization: key=<serverKey>` and JSON
  body `{ to, notification: { title, body } }` — matching the committed PUBLIC_API option
  `serverKey`. OAuth2 HTTP v1 with service-account JWT signing is deferred.
- **Why:** the committed PUBLIC_API option is `serverKey` (not an OAuth2 service account), and the
  legacy API is a single zero-dependency POST; the v1 API requires JWT signing machinery that is out
  of scope for M30 and is tracked as a deferred concern in §9.
- **Test home:** `fcm-provider.test.ts` (fake `INotificationHttp` asserts the `key=` header and
  `notification` body; missing `serverKey` ⇒ construction throws; non-2xx ⇒ throws).

### 3.6 Plugin wiring, health, lifecycle

- **Decision:** `NotificationPlugin` returns an `IPlugin` with `name: 'notification-plugin'`,
  `provides:
  [CAPABILITIES.NOTIFICATION]`, `priority: PLUGIN_PRIORITY.NORMAL`,
  `optionalDependencies: [CAPABILITIES.MAIL]` (§10.3). `register` builds each channel via
  `createChannel(name,
  entry, ctx)` (which calls `createProvider`), constructs
  `NotificationService(channels)`, registers it under `CAPABILITIES.NOTIFICATION`, and registers a
  `notification` health indicator returning
  `{ status: 'up', data: { channels: [...channelNames] } }`. There is no `onClose`: the providers
  are stateless HTTP wrappers holding no socket, timer, or connection, so there is nothing to
  release (unlike M29's SMTP/SES providers). `register` is synchronous (no async import). Providers
  validate their required options at construction (throw on missing credentials), so a successfully
  registered plugin is always healthy and the indicator reports `'up'`.
- **Why:** the exact `SecretsPlugin`/M29 wiring precedent, minus `onClose` because this plugin owns
  no resource; synchronous `register` because nothing is lazily imported.
- **Test home:** `notification-plugin.test.ts` (`createChannel`/`createProvider` per provider type,
  unknown provider type ⇒ throws, `provides`/`priority`/`name`) and the integration test (kernel
  app: capability resolves, multi-channel `send` read back through injected fakes, health indicator
  reports `'up'` with the channel list).

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                      | Kind                         | Consumer / real code path that READS it                                                   |
| ------------------------------------------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------- |
| `NotificationPlugin`                                                                 | fn (factory)                 | app code `app.register(NotificationPlugin({...}))`; integration test                      |
| `NotificationService`                                                                | class                        | `NotificationPlugin.register` constructs it; registered under `CAPABILITIES.NOTIFICATION` |
| `createChannel`                                                                      | fn                           | `NotificationPlugin.register` calls it per channel entry; `notification-plugin.test.ts`   |
| `createProvider`                                                                     | fn                           | `createChannel` calls it; `notification-plugin.test.ts`                                   |
| `EmailChannel`                                                                       | class                        | `createChannel('mail'…)`; `email-channel.test.ts`                                         |
| `SmsChannel`                                                                         | class                        | `createChannel('twilio'…)`; `sms-channel.test.ts`                                         |
| `PushChannel`                                                                        | class                        | `createChannel('fcm'…)`; `push-channel.test.ts`                                           |
| `SlackChannel`                                                                       | class                        | `createChannel('slack'…)`; `slack-channel.test.ts`                                        |
| `TwilioProvider`                                                                     | class                        | `createProvider('twilio')`; `twilio-provider.test.ts`                                     |
| `FcmProvider`                                                                        | class                        | `createProvider('fcm')`; `fcm-provider.test.ts`                                           |
| `SlackProvider`                                                                      | class                        | `createProvider('slack')`; `slack-provider.test.ts`                                       |
| `createDefaultNotificationHttp`                                                      | fn                           | `createProvider` default `http`; `default-http.test.ts`                                   |
| `INotificationHttp`, `NotificationHttpResponse`                                      | type                         | provider options field type; `createDefaultNotificationHttp` return                       |
| `SmsTransport`, `SmsMessage`                                                         | type                         | `SmsChannel` constructor param; `TwilioProvider` implements                               |
| `PushTransport`, `PushMessage`                                                       | type                         | `PushChannel` constructor param; `FcmProvider` implements                                 |
| `SlackTransport`, `SlackMessage`                                                     | type                         | `SlackChannel` constructor param; `SlackProvider` implements                              |
| `TwilioProviderOptions`                                                              | type                         | `TwilioProvider` constructor                                                              |
| `FcmProviderOptions`                                                                 | type                         | `FcmProvider` constructor                                                                 |
| `SlackProviderOptions`                                                               | type                         | `SlackProvider` constructor                                                               |
| `NotificationPluginOptions`, `ChannelsMap`, `ChannelConfig`, `ProviderType`          | type                         | `NotificationPlugin` parameter; `createChannel`/`createProvider` switch                   |
| `MailChannelConfig`, `TwilioChannelConfig`, `FcmChannelConfig`, `SlackChannelConfig` | type                         | the four `ChannelConfig` arms; each selects a `createProvider` overload (§10.1)           |
| `NotificationTransport`                                                              | type                         | `createProvider`'s widest return type (union of `IMailer` and the three transport ports)  |
| `INotifier`, `NotificationMessage`                                                   | type (re-export from common) | consumers resolving the capability                                                        |

### 4.1 Options — every option names its consumer

| Option                                  | Consumer                             | Behavior (per implementation)                                                                                                                                             |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels`                              | `NotificationPlugin`                 | `Readonly<Record<string, ChannelConfig>>`; required; each key is the dispatch name a caller passes in `channels: [...]`.                                                  |
| `channels.*.provider`                   | `createChannel`/`createProvider`     | `'mail' \| 'twilio' \| 'fcm' \| 'slack'`; selects transport and channel class.                                                                                            |
| `channels.*.options`                    | `createProvider` → provider ctor     | per-provider config, typed by the `provider` discriminant (§10.1); absent from the `mail` arm entirely (email delegates to `IMailer`, configured by MailPlugin) — see C3. |
| `options.accountSid`/`authToken`/`from` | `TwilioProvider`                     | Twilio credentials and sender number; construction throws if any is missing.                                                                                              |
| `options.serverKey`                     | `FcmProvider`                        | FCM legacy server key; construction throws if missing.                                                                                                                    |
| `options.webhookUrl`                    | `SlackProvider`                      | Slack incoming webhook URL; construction throws if missing.                                                                                                               |
| `options.http`                          | each provider (via `createProvider`) | injectable `INotificationHttp`; defaults to `createDefaultNotificationHttp()` (global `fetch`).                                                                           |

## 5. Implementation files

| File                                   | Purpose                                                                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                         | barrel exports (every symbol in §4), documented in PUBLIC_API.md                                                                                                                                                                                                                 |
| `src/interfaces/index.ts`              | internal `NotificationChannel` port; transport ports `SmsTransport`/`PushTransport`/`SlackTransport` + their message types; `INotificationHttp`/`NotificationHttpResponse`; `NotificationPluginOptions`, `ChannelConfig`, `ProviderType`, and the three `*ProviderOptions`       |
| `src/http/default-http.ts`             | `createDefaultNotificationHttp(fetchImpl = fetch)` — the `fetch`-backed default `INotificationHttp`                                                                                                                                                                              |
| `src/services/notification-service.ts` | `NotificationService implements INotifier` — parallel fan-out + `AggregateError`                                                                                                                                                                                                 |
| `src/channels/email-channel.ts`        | `EmailChannel(name, mailer)` → builds `MailMessage`, calls `IMailer.send`                                                                                                                                                                                                        |
| `src/channels/sms-channel.ts`          | `SmsChannel(name, transport)` → reads `to.phone`, calls `SmsTransport.send`                                                                                                                                                                                                      |
| `src/channels/push-channel.ts`         | `PushChannel(name, transport)` → reads `to.token`, calls `PushTransport.send`                                                                                                                                                                                                    |
| `src/channels/slack-channel.ts`        | `SlackChannel(name, transport)` → reads `to.channel` (optional), calls `SlackTransport.send`                                                                                                                                                                                     |
| `src/providers/twilio-provider.ts`     | `TwilioProvider implements SmsTransport` — Twilio REST POST                                                                                                                                                                                                                      |
| `src/providers/fcm-provider.ts`        | `FcmProvider implements PushTransport` — FCM legacy server-key POST                                                                                                                                                                                                              |
| `src/providers/slack-provider.ts`      | `SlackProvider implements SlackTransport` — Slack webhook POST                                                                                                                                                                                                                   |
| `src/plugin/notification-plugin.ts`    | `NotificationPlugin` factory + `createChannel` + `createProvider`                                                                                                                                                                                                                |
| `deno.json`                            | package scaffold (name `@hono-enterprise/notification-plugin`, `version`, `exports: ./src/index.ts`); workspace member `./packages/notification-plugin` is already listed in the root `deno.json:30`. No `net` test permission needed (tests inject a fake `INotificationHttp`). |

> The existing `packages/notification-plugin/` stub (`deno.json` + `src/index.ts`) is overwritten by
> the Code-mode implementation; this plan does not edit it.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                           | src covered                            | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/notification-service.test.ts`            | `services/notification-service.ts`     | `send({channels:['email','sms'], to, subject, body})` dispatches both; all-success ⇒ resolves; one channel rejects with an `Error` ⇒ `AggregateError` whose `.errors` contains that exact error AND the other channel's `send` was still called; one channel rejects with a non-`Error` (thrown string) ⇒ `AggregateError` whose matching entry is an `Error` wrapping the value (`toError` else-arm); unknown name in `channels` ⇒ `AggregateError`; empty `channels` ⇒ resolves. Calls type-check against `INotifier.send`.                                              |
| `test/unit/email-channel.test.ts`                   | `channels/email-channel.ts`            | fake `IMailer` receives `send({ to, subject, text })` with `to = notification.to.email`; `subject ?? '(no subject)'`; `body` → `text`; missing `to.email` ⇒ throws.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/sms-channel.test.ts`                     | `channels/sms-channel.ts`              | fake `SmsTransport` receives `send({ to: notification.to.phone, body })`; missing `to.phone` ⇒ throws.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/unit/push-channel.test.ts`                    | `channels/push-channel.ts`             | fake `PushTransport` receives `send({ to: notification.to.token, title: notification.subject, body })`; missing `to.token` ⇒ throws; `subject` undefined ⇒ `title` omitted (respects `exactOptionalPropertyTypes`).                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/slack-channel.test.ts`                   | `channels/slack-channel.ts`            | fake `SlackTransport` receives `send({ text: notification.body, channel?: notification.to.channel })`; `channel` omitted when `to.channel` absent.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `test/unit/twilio-provider.test.ts`                 | `providers/twilio-provider.ts`         | recording `INotificationHttp` receives `post(twilioUrl, formBody, headers)` with Basic `Authorization` + `application/x-www-form-urlencoded` and `To`/`From`/`Body`; non-OK response ⇒ throws; missing `accountSid`/`authToken`/`from` ⇒ construction throws.                                                                                                                                                                                                                                                                                                              |
| `test/unit/fcm-provider.test.ts`                    | `providers/fcm-provider.ts`            | recording `INotificationHttp` receives `post('https://fcm.googleapis.com/fcm/send', json, headers)` with `Authorization: key=<serverKey>` and `{ to, notification: { title, body } }`; `title` omitted when no subject; non-OK ⇒ throws; missing `serverKey` ⇒ construction throws.                                                                                                                                                                                                                                                                                        |
| `test/unit/slack-provider.test.ts`                  | `providers/slack-provider.ts`          | recording `INotificationHttp` receives `post(webhookUrl, json, headers)` with `{ text, channel? }`; `channel` included only when provided; three distinct response cases for the compound OK check — success (`ok: true` + body `'ok'`) ⇒ resolves; non-2xx (`ok: false`) ⇒ throws; 2xx-but-body-not-`'ok'` (`ok: true`, body `'invalid_payload'`) ⇒ throws; missing `webhookUrl` ⇒ construction throws.                                                                                                                                                                   |
| `test/unit/default-http.test.ts`                    | `http/default-http.ts`                 | `createDefaultNotificationHttp(fakeFetch)` issues a POST with the given `body`/`headers` and maps the `Response` to `{ ok, status, text }`; both OK and non-OK responses map correctly.                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/unit/notification-plugin.test.ts`             | `plugin/notification-plugin.ts`        | `createProvider` returns the right class per type and `IMailer` for `'mail'`; unknown type ⇒ throws; `mail` with no MailPlugin resolved ⇒ throws; `createChannel` returns the matching channel per provider; `createProvider('twilio', {…})` without `http` uses the default (asserts `instanceof TwilioProvider`); plugin `provides`/`priority`/`name`.                                                                                                                                                                                                                   |
| `test/unit/barrel-exports.test.ts`                  | `index.ts` (+ `interfaces/index.ts`)   | every §4 symbol is defined/exported. `interfaces/index.ts` is type-only (no runtime branches) and is exercised transitively by the channel/provider tests that implement its ports.                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/integration/notification-integration.test.ts` | plugin + service + channels end-to-end | kernel app registers RuntimePlugin, a stub plugin providing `CAPABILITIES.MAIL` (recording fake `IMailer`), and `NotificationPlugin({ channels: { email:{provider:'mail'}, sms:{provider:'twilio',options:{…,http:fakeHttp}}, slack:{provider:'slack',options:{…,http:fakeHttp}} } })`; resolve `INotifier` via `CAPABILITIES.NOTIFICATION`; `send({channels:['email','sms','slack'],…})` is read back through the fake `IMailer` and fake `INotificationHttp` (one capability, one implementation); `notification` health indicator reports `'up'` with the channel list. |
| `test/fixtures/fake-notification-http.ts`           | fixture (excluded from coverage)       | recording `INotificationHttp` capturing the last `(url, body, headers)` and a controllable response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `test/fixtures/fake-context.ts`                     | fixture (excluded from coverage)       | fake `IPluginContext` for the `register`/`createProvider` unit tests; its `services.get` throws for an absent token and `register` rejects a duplicate, mirroring the kernel's real `ServiceRegistry` so a missing fail-fast guard cannot hide.                                                                                                                                                                                                                                                                                                                            |
| `test/fixtures/fake-mailer.ts`                      | fixture (excluded from coverage)       | recording `IMailer` capturing the last `MailMessage` (read-back for the email channel + integration test).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/30-notification-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

## 8. Risks & mitigations

- `exactOptionalPropertyTypes` is on: optional channel/provider fields (`PushMessage.title`,
  `SlackMessage.channel`) are built by omitting the property when absent, never by assigning
  `undefined` (the `push-channel.test.ts` and `slack-channel.test.ts` cases assert the omitted
  shape).
- A misconfigured channel (e.g. `email` configured without MailPlugin) could surface only at first
  send ⇒ mitigated by resolving `IMailer` during `register` and throwing at startup (3.3); every
  provider likewise validates required options at construction.
- The FCM legacy `serverKey` API is deprecated upstream by Google ⇒ mitigated by matching the
  committed PUBLIC_API option and keeping the provider behind the pure `INotificationHttp` seam so a
  future HTTP v1 provider swaps in without touching channels or the service.
- Built-in channels ignore `NotificationMessage.metadata` (a committed common-contract field) ⇒ not
  dead surface in this package: it is an extension point custom `NotificationChannel`
  implementations read; documented so callers know built-ins pass the full message through.

## 9. Out of scope

- Per-channel retries, rate limiting, deduplication, batching, and templated bodies (compose
  `queue-plugin` M15 and `resilience-plugin` M27 at the app layer; templates are M29's concern).
- FCM HTTP v1 with OAuth2 service-account JWT signing (deferred; M30 ships the legacy `serverKey`
  API the committed option names).
- Inbound notification receipts, delivery webhooks, and read receipts (app concern, no owning
  milestone).
- Additional transports (e.g. Telegram, Microsoft Teams, PagerDuty, SNS) beyond Twilio/FCM/Slack
  plus the `IMailer`-backed email channel (not in the ROADMAP file list; deferred).
- A `NotificationChannel` registry/plugin hook for third-party channels (the exported transport
  interfaces already allow injection; a formal registration extension point is a future concern).

## 10. Deviations from this plan, decided during verification

Each of these ships in the same PR; the sections above have been corrected to match.

### 10.1 `ChannelConfig` is discriminated on `provider`; `createProvider` is overloaded

The plan's §4.1 shape — `provider: ProviderType` plus an untyped
`options?: Readonly<Record<string, unknown>>` bag — type-checked a config that no provider can
honor, which is exactly how C4 (the documented example missing Twilio's required `from`) escaped
review. `ChannelConfig` is now the union
`MailChannelConfig | TwilioChannelConfig |
FcmChannelConfig | SlackChannelConfig`, each arm naming
its provider's option type, and `createProvider(config, ctx?)` carries one overload per arm
returning that arm's transport port.

Consequences: `createProvider`'s signature is `(config, ctx?)` rather than the planned
`(type, options, ctx)` — the type and its options travel together, so they cannot disagree; and the
plan's four `as unknown as` casts (`provider as unknown as IMailer` in `createChannel`, plus one per
provider-options bag) are gone. The `default:` arm of each switch is retained as a runtime guard for
JS callers, driven by a test that casts a bogus provider.

### 10.2 The integration test drives a real kernel app

As §6 specified —
`createApplication({ plugins: [RuntimePlugin(), <mail stub>,
NotificationPlugin(…)] })`,
`app.start()`, dispatch from a route via `app.inject()`, read back through the fakes, resolve the
health indicator from `CAPABILITIES.HEALTH_INDICATOR`. It also proves the §3.3 ordering claim
(NotificationPlugin listed BEFORE the mail provider still resolves `IMailer`) and that `email` with
no mail capability fails `app.start()`, not just `register()`.

### 10.3 No `CAPABILITIES.LOGGER` optional dependency

§3.3/§3.6 planned `optionalDependencies: [CAPABILITIES.MAIL, CAPABILITIES.LOGGER]`, but nothing in
the package reads `ctx.logger` — verified with a real app: a successful send and a failing send
emitted zero log lines. Per the dead-symbol rule the declaration is dropped rather than given
speculative log statements (logging on dispatch is behavior no design decision here specifies).

### 10.4 Providers are exported from their own modules

`src/plugin/notification-plugin.ts` re-exported `TwilioProvider`/`FcmProvider`/`SlackProvider` so
its unit test could import them from one place, with a comment describing something else. The barrel
now re-exports each provider from `src/providers/*.ts` and the tests import from the barrel, so each
symbol has exactly one export path.
