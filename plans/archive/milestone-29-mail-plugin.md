# Milestone 29 — Mail Plugin (`@hono-enterprise/mail-plugin`)

> **Status:** Planning. Branch: `feat/29-mail-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Provide outbound email as a plugin. `MailPlugin(options)` registers the committed `IMailer` contract
under `CAPABILITIES.MAIL`, backed by a pluggable internal `MailProvider` port with four backends —
`LogProvider` (zero-dependency default, every runtime incl. Workers), `SmtpProvider` (Node/Deno/Bun,
inject-or-lazy `npm:nodemailer`), `SesProvider` (inject-or-lazy `npm:@aws-sdk/client-sesv2`), and
`SendGridProvider` (zero-dependency over web-standard `fetch`, Workers-portable). A zero-dependency
`TemplateEngine` renders named `{{ variable }}` templates for `sendTemplate`. The plugin resolves
the default sender, registers a `mail` health indicator, and disconnects the provider on close.

- **In scope:** the `IMailer` implementation (`MailService`), the four providers behind the internal
  `MailProvider` seam, the template engine, the plugin factory + `createProvider`, a health
  indicator, and full per-file test coverage (≥90% branch/function/line).
- **NOT this milestone:** multi-channel routing / SMS / push / Slack (M30 `notification-plugin`,
  which may delegate its email channel to this plugin); a Mailgun provider (not in the ROADMAP file
  list or deliverables — deferred, no owning milestone assigned); queued/retried delivery (an app
  composes `queue-plugin` M15 with this plugin); attachments (not in the committed `MailMessage`
  contract).

## 1. Contracts verified from SOURCE (not names)

| Reference                                 | Source (file:line)                                        | Verified surface / fact                                                                                                                                                                         |
| ----------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMailer`                                 | `packages/common/src/services/mail.ts:40`                 | `send(message: MailMessage): Promise<void>`; `sendTemplate(template: string, message: Omit<MailMessage, 'html' \| 'text'>, data: Readonly<Record<string, unknown>>): Promise<void>`             |
| `MailMessage`                             | `packages/common/src/services/mail.ts:13`                 | `to: string \| readonly string[]` (req), `from?: string`, `subject: string` (req), `html?`, `text?`, `cc?: readonly string[]`, `bcc?: readonly string[]` — all `readonly`; NO attachments field |
| `CAPABILITIES.MAIL`                       | `packages/common/src/tokens.ts:81`                        | `MAIL: 'mail'`                                                                                                                                                                                  |
| `IPlugin`                                 | `packages/common/src/plugin.ts`                           | `name`, `version`, `provides`, `priority`, `optionalDependencies`, `register(ctx)` (may return `Promise<void>`) — mirrors `SecretsPlugin`                                                       |
| `IPluginContext`                          | `packages/common/src/plugin.ts:409`                       | has `services`, `health`, `lifecycle`, `runtime` (non-optional), and `logger?: ILogger` directly (no need to resolve `CAPABILITIES.LOGGER`)                                                     |
| `IHealthApi.register`                     | `packages/common/src/plugin.ts:187`                       | `register(name: string, indicator: HealthIndicatorFn): void`                                                                                                                                    |
| `HealthIndicatorFn` / `HealthCheckResult` | `packages/common/src/services/health.ts:26,13`            | `() => Promise<HealthCheckResult>`; result `{ status: HealthStatus; data?: ... }`, status `'up' \| 'down'`                                                                                      |
| `ILifecycleApi.onClose`                   | `packages/common/src/plugin.ts:328`                       | `onClose(fn: () => void \| Promise<void>): void`                                                                                                                                                |
| `ILogger`                                 | `packages/common/src/services/logger.ts:59`               | `info(message: string, metadata?: LogMetadata): void` (also `debug`/`warn`/`error`)                                                                                                             |
| `PLUGIN_PRIORITY.NORMAL`                  | `packages/common/src/types.ts:84`                         | `500`                                                                                                                                                                                           |
| SecretsPlugin provider pattern            | `packages/secrets-plugin/src/{plugin,providers,services}` | exact precedent for internal port + `createProvider` + inject-or-lazy SDK facade (`adaptXxxModule`/`loadXxxModule`) + `fetch` provider + `hasMethods` shape probe + guarded real-import test    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                   | Resolution (picked side)                                                                                                                                                                      | Doc deliverable (same PR)                                                                               |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP.md:3039 and PUBLIC_API.md:2691 show `sendTemplate('welcome', { to: ... }, ...)` with NO `subject`, but committed `IMailer.sendTemplate`'s `message: Omit<MailMessage, 'html' \| 'text'>` keeps `subject` REQUIRED. | Honor the committed contract — `subject` is required on the `sendTemplate` envelope; the template supplies `html`/`text` bodies only, never the subject.                                      | Correct the PUBLIC_API.md Mail `sendTemplate` example to include `subject`.                             |
| C2 | ROADMAP migration note (3007) lists SES/SendGrid/Mailgun as the HTTP-API path, but the "Implementation Files" list (3055) and Deliverables (3070) name only SMTP/SES/SendGrid/Log — no Mailgun.                            | Implement exactly SMTP/SES/SendGrid/Log (the file list + deliverables). Mailgun is out of scope.                                                                                              | None (checked — ROADMAP already scopes to four providers; the note is prose, not the deliverable list). |
| C3 | ROADMAP note (3007) frames SES as an "HTTP-API provider", yet the same note (3009) sanctions "clients ... lazily imported per §12.2". Hand-rolling SES SigV4 over `fetch` is risky and large.                              | Implement `SesProvider` via the §12.2 inject-or-lazy `npm:@aws-sdk/client-sesv2` facade (the `aws-kms` precedent), NOT hand-rolled SigV4. SendGrid remains the zero-dep `fetch`/Workers path. | None (checked — §12.2 lazy-import is explicitly permitted by the note itself).                          |

## 3. Design decisions

### 3.1 Internal `MailProvider` port (not exported)

- **Decision:** an internal `MailProvider` interface — `connect()`, `disconnect()`, `isReady()`,
  `send(message: OutgoingMail): Promise<void>` where `OutgoingMail = MailMessage & { from: string }`
  (sender already resolved). NOT exported from `src/index.ts`; the public contract is `IMailer`.
- **Why:** mirrors `SecretProvider` — keeps the four backends swappable behind one seam and lets
  `MailService` own the single default-`from` resolution and throw contract.
- **Test home:** each provider `*.test.ts` drives the port directly; `mail-service.test.ts` asserts
  the service→port hand-off through a recording fake provider.

### 3.2 `MailService` default-`from` resolution (single point)

- **Decision:** `MailService.send` computes `from = message.from ?? defaultFrom`; if BOTH are absent
  it throws `Error('MailMessage requires a "from" address or a configured default')` BEFORE calling
  the provider. `sendTemplate` renders the body then delegates to `send` (one entry point for
  `from` + provider dispatch — no split).
- **Why:** the committed `MailMessage.from` is optional and providers need a concrete sender;
  resolving once satisfies the "one capability, one implementation, every entry point honors the
  same config" rule (both `send` and `sendTemplate` funnel through `send`).
- **Test home:** `mail-service.test.ts` — send with per-message `from`, send with only the default,
  send with neither (throws), and `sendTemplate` under a NON-default `defaultFrom` asserting the
  same resolved `from` reaches the provider.

### 3.3 `TemplateEngine` rendering

- **Decision:** templates are supplied via
  `MailPluginOptions.templates?: Record<string, MailTemplate>`
  (`MailTemplate = { html?: string; text?: string }`, at least one present). Rendering replaces
  `{{ key }}` (any inner whitespace) with `String(data[key])`; a placeholder whose key is absent
  from `data` THROWS `Error('Unknown template variable "<key>" in template "<name>"')`. In the
  `html` body, interpolated values are HTML-escaped (`& < > " '` → entities); the static template
  text is left as-is. The `text` body substitutes raw (no escaping). `subject` is taken verbatim
  from the `sendTemplate` envelope — it is NOT a template and is NOT interpolated. Unknown template
  name throws `Error('Unknown mail template: <name>')`.
- **Why:** zero-dependency, deterministic, and injection-safe by default for HTML; throwing on a
  missing variable surfaces template/data drift instead of silently emitting empty strings.
- **Test home:** `template-engine.test.ts` — HTML escaping (assert literal `&amp;`/`&lt;`), raw
  text, missing-variable throw, unknown-template throw, whitespace-tolerant placeholder.

### 3.4 Provider dependency strategy (§12.2)

- **Decision:** `SmtpProvider` and `SesProvider` accept an injected structural facade; absent one
  they lazily `await import('npm:…')` and adapt it via a pure exported
  `adaptXxxModule(mod, options)` + `loadXxxModule()`; the injected shape is validated with the local
  `hasMethods` probe. `SendGridProvider` sends over an injectable `IMailHttp` (`fetch`-shaped,
  defaults to global `fetch`). `LogProvider` has no external dependency.
- **Why:** the committed §12.2 rule and the `aws-kms`/`vault` precedents — no mail SDK is ever a
  hard dependency; every backend is unit-testable with a fake module/fetch, plus one guarded
  real-import test that enters the `import()` without doing network I/O.
- **Test home:** `smtp-provider.test.ts`, `ses-provider.test.ts` (fake module + `adapt*` + guarded
  `load*`), `sendgrid-provider.test.ts` (fake `IMailHttp`).

### 3.5 Plugin wiring, health, lifecycle

- **Decision:** `MailPlugin` (name `mail-plugin`, `provides: [CAPABILITIES.MAIL]`, priority
  `NORMAL`, `optionalDependencies: ['logger']`) — `register` is `async`, builds the provider via
  exported `createProvider(type, options, ctx)`, `await provider.connect()`, constructs
  `MailService`, registers it under `CAPABILITIES.MAIL`, registers a `mail` health indicator
  returning `status: provider.isReady()
  ? 'up' : 'down'` with `data: { provider: type }`, and
  `ctx.lifecycle.onClose(() => provider.disconnect())`. `LogProvider` receives `ctx.logger` and an
  optional `sink` from options for read-back.
- **Why:** exact `SecretsPlugin` precedent; `async register` is required because the lazy `import()`
  makes provider construction async.
- **Test home:** `mail-plugin.test.ts` (createProvider per type + unsupported-type throw) and the
  integration test (kernel app + inject: capability resolves, health up, send read back via `sink`).

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                           | Kind                         | Consumer / real code path that READS it                                   |
| ----------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| `MailPlugin`                                                                              | fn (factory)                 | app code `app.register(MailPlugin({...}))`; integration test              |
| `createProvider`                                                                          | fn                           | `MailPlugin.register` calls it; `mail-plugin.test.ts`                     |
| `MailService`                                                                             | class                        | `MailPlugin.register` constructs it; registered under `CAPABILITIES.MAIL` |
| `LogProvider`                                                                             | class                        | `createProvider('log')`; default backend; integration read-back           |
| `SmtpProvider`                                                                            | class                        | `createProvider('smtp')`                                                  |
| `SesProvider`                                                                             | class                        | `createProvider('ses')`                                                   |
| `SendGridProvider`                                                                        | class                        | `createProvider('sendgrid')`                                              |
| `TemplateEngine`                                                                          | class                        | `MailService.sendTemplate` renders through it                             |
| `adaptNodemailerModule` / `loadNodemailerModule`                                          | fn                           | `SmtpProvider.connect` lazy path; unit tests                              |
| `adaptSesModule` / `loadSesModule`                                                        | fn                           | `SesProvider.connect` lazy path; unit tests                               |
| `MailProviderType`                                                                        | type                         | `MailPluginOptions.provider`; `createProvider` switch                     |
| `MailPluginOptions`                                                                       | type                         | `MailPlugin` parameter                                                    |
| `MailProviderOptions`                                                                     | type                         | `MailPlugin`/`createProvider`                                             |
| `MailTemplate`                                                                            | type                         | `MailPluginOptions.templates` values; `TemplateEngine`                    |
| `ISmtpTransport`                                                                          | type                         | injected `SmtpProvider` client facade                                     |
| `ISesClient`                                                                              | type                         | injected `SesProvider` client facade                                      |
| `IMailHttp`                                                                               | type                         | injected `SendGridProvider` fetch shape                                   |
| `SmtpProviderOptions`/`SesProviderOptions`/`SendGridProviderOptions`/`LogProviderOptions` | type                         | each provider constructor                                                 |
| `IMailer`, `MailMessage`                                                                  | type (re-export from common) | consumers resolving the capability                                        |

### 4.1 Options — every option names its consumer

| Option                                                    | Consumer                             | Behavior (per implementation)                                  |
| --------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| `provider`                                                | `MailPlugin`/`createProvider`        | selects backend; default `'log'`                               |
| `options.*` (per-provider)                                | matching provider ctor               | unrelated fields ignored (union like `SecretsProviderOptions`) |
| `defaults.from`                                           | `MailService`                        | resolved sender when a message omits `from`                    |
| `templates`                                               | `TemplateEngine` (via `MailService`) | named body templates for `sendTemplate`                        |
| `options.host`/`port`/`secure`/`auth`/`transport`         | `SmtpProvider`                       | nodemailer transport config / injected `ISmtpTransport`        |
| `options.region`/`accessKeyId`/`secretAccessKey`/`client` | `SesProvider`                        | SDK config / injected `ISesClient`                             |
| `options.apiKey`/`endpoint`/`http`                        | `SendGridProvider`                   | Bearer key, API URL, injected `IMailHttp`                      |
| `options.sink`                                            | `LogProvider`                        | called with each sent `OutgoingMail` (read-back seam)          |

## 5. Implementation files

| File                                 | Purpose                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                       | barrel exports (every symbol in §4), documented in PUBLIC_API.md                                                                                                                    |
| `src/interfaces/index.ts`            | `MailProvider` port (internal), `OutgoingMail`, `MailProviderType`, facades (`ISmtpTransport`/`ISesClient`/`IMailHttp`), `MailProviderOptions`, `MailPluginOptions`, `MailTemplate` |
| `src/services/mail-service.ts`       | `MailService implements IMailer` — default-`from`, template dispatch                                                                                                                |
| `src/templates/template-engine.ts`   | `TemplateEngine` — `{{ var }}` render + HTML escape                                                                                                                                 |
| `src/providers/shape.ts`             | `hasMethods` structural probe (local copy of the secrets pattern)                                                                                                                   |
| `src/providers/log-provider.ts`      | `LogProvider` (default, zero-dep)                                                                                                                                                   |
| `src/providers/smtp-provider.ts`     | `SmtpProvider` + `adaptNodemailerModule`/`loadNodemailerModule`                                                                                                                     |
| `src/providers/ses-provider.ts`      | `SesProvider` + `adaptSesModule`/`loadSesModule`                                                                                                                                    |
| `src/providers/sendgrid-provider.ts` | `SendGridProvider` (fetch)                                                                                                                                                          |
| `src/plugin/mail-plugin.ts`          | `MailPlugin` factory + `createProvider`                                                                                                                                             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                   | src covered                                | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/mail-service.test.ts`            | `services/mail-service.ts`                 | `send({to,subject,text})` resolves `from` from default; per-message `from` wins; neither → throws; `sendTemplate(name, {to,subject}, data)` renders body then hits provider with resolved `from`; short-circuit: render error → provider NOT called. Calls type-check against `IMailer`. |
| `test/unit/template-engine.test.ts`         | `templates/template-engine.ts`             | HTML body escapes `&`→`&amp;`, `<`→`&lt;`; text body raw; `{{  key  }}` whitespace tolerated; missing var throws; unknown template throws; render returns only present bodies.                                                                                                           |
| `test/unit/log-provider.test.ts`            | `providers/log-provider.ts`                | records to `messages`; calls `sink`; calls injected `logger.info`; `connect`/`isReady`/`disconnect` transitions.                                                                                                                                                                         |
| `test/unit/smtp-provider.test.ts`           | `providers/smtp-provider.ts`               | injected `ISmtpTransport` send maps `MailMessage`→nodemailer fields; `adaptNodemailerModule(fake)` builds transport & sends; malformed injected client throws; guarded `loadNodemailerModule()` enters real import.                                                                      |
| `test/unit/ses-provider.test.ts`            | `providers/ses-provider.ts`                | injected `ISesClient` send; `adaptSesModule(fake)` maps to `SendEmailCommand` input & `send()`; malformed client throws; not-connected throws; guarded `loadSesModule()` enters real import.                                                                                             |
| `test/unit/sendgrid-provider.test.ts`       | `providers/sendgrid-provider.ts`           | fake `IMailHttp` receives POST to endpoint with Bearer header + v3 personalizations body; non-2xx → throws; missing apiKey `connect` throws.                                                                                                                                             |
| `test/unit/shape.test.ts`                   | `providers/shape.ts`                       | valid shape true; missing method / non-object / null false.                                                                                                                                                                                                                              |
| `test/unit/mail-plugin.test.ts`             | `plugin/mail-plugin.ts`                    | `createProvider` returns the right class per type; unsupported type throws; plugin `provides`/`priority`/`name`.                                                                                                                                                                         |
| `test/unit/barrel-exports.test.ts`          | `index.ts`                                 | every §4 symbol is defined/exported.                                                                                                                                                                                                                                                     |
| `test/integration/mail-integration.test.ts` | plugin + service + log provider end-to-end | kernel app registers `MailPlugin({provider:'log', defaults, templates, options:{sink}})`; resolve `IMailer` via `CAPABILITIES.MAIL`; `send` + `sendTemplate` captured by `sink` and asserted (read-back); `mail` health indicator reports `up`; `onClose` disconnects.                   |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/29-mail-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

## 8. Risks & mitigations

- Lazy `npm:` imports (`nodemailer`, `@aws-sdk/client-sesv2`) may be absent in CI → guarded
  real-import tests tolerate a thrown `Error`; all behavior is unit-tested through the pure `adapt*`
  seam with a fake module, so coverage never depends on the package being installed.
- HTML-escape could double-escape a value already containing entities → escape only interpolated
  `data` values, never the static template, and assert literal entity output in tests.
- `exactOptionalPropertyTypes`: provider option objects (SES/SMTP config) built without assigning
  `undefined` — use the `buildXxxConfig` guarded-assignment helper pattern from `aws-kms`.

## 9. Out of scope

- Mailgun provider (ROADMAP names only SMTP/SES/SendGrid/Log; no owning milestone — deferred).
- Attachments / inline images (not in the committed `MailMessage`; a future `common` widening).
- Delivery retries, rate limiting, bounce/webhook handling (compose `queue-plugin` M15 / an app
  concern).
- Multi-channel dispatch (M30 `notification-plugin`).
