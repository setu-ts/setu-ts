# Milestone 96 — Redaction (`@setu-ts/common`, `@setu-ts/redaction-plugin`, three consumers)

> **Status:** Planning. Branch: `feat/m96-redaction-seam`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR. This plan and
> its ROADMAP section were authored on `docs/m96-data-classification`, which carries no `src`
> change.

## 0. Objective & scope

Give the framework one answer to "where does application data leave this process, and what happens
to it on the way out". Three first-party components export data an operator never wrote — log
records, span attributes, audit entries — and each answers that differently today: the logger has an
opt-in dot-path list whose two implementations disagree and whose nested walk corrupts the caller's
object, telemetry has nothing and ships the full request URL to three vendors, and the audit trail
has nothing at all. This milestone adds one port (`IRedactionService`), one policy vocabulary
(`DataClassification`), one pure implementation in `common`, and wires all three exporters to it. It
is a mechanism, not a compliance feature: no regulation is named in any shipped identifier, doc line
or option, and the `grep` that proves it stays empty is a deliverable.

- **In scope:** `CAPABILITIES.REDACTION` and the `IRedactionService` port in `common`; the pure
  policy/matcher/redactor implementation in `common`; a new `@setu-ts/redaction-plugin` registering
  the service; `logger-plugin` (shared implementation behind both loggers, secret-field default, an
  outermost `RedactingLogger` decorator); `telemetry-plugin` (the `http.url` leak repair and
  classified span attributes); `audit-plugin` (`before`/`after`/`metadata` through the service).
- **NOT this milestone:** field-level encryption at rest, erasure fan-out, and the plaintext copies
  `cache-plugin`/`queue-plugin`/`messaging-plugin` persist — the storage half, unowned and named in
  ROADMAP §96 "Out of scope". Promoting `session-plugin`'s key ring into a general key-management
  capability — its own milestone, and the prerequisite for a cryptographic redactor. A build-time
  classification report — not reproducible against a runtime policy (§3.9). `http.route` carrying a
  concrete path rather than the matched route template — a kernel change (M70l records that the
  middleware never receives the matched pattern). OpenTelemetry semantic-convention renames.

## 1. Contracts verified from SOURCE (not names)

| Reference                        | Source (file:line)                                                          | Verified surface / fact                                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ILogger`                        | `packages/common/src/services/logger.ts:38-80`                              | Six level methods all return **`void`** — synchronous — plus `child(bindings: LogMetadata): ILogger`. Rules out any async redactor on the logging path (§3.3) and forces the decorator to wrap `child` (§3.5). |
| `LogMetadata`                    | `packages/common/src/services/logger.ts:14`                                 | `Readonly<Record<string, unknown>>` — so a redactor returns a copy and never mutates in place.                                                                                                                 |
| `CapabilityToken` grammar        | `packages/common/src/tokens.ts:14-22,165-177`                               | Lowercase kebab-case segments, dot-namespaced; `TOKEN_PATTERN` rejects colons. `redaction` is legal. 48 tokens exist; none is `REDACTION`, `CLASSIFICATION` or similar.                                        |
| `PLUGIN_PRIORITY`                | `packages/common/src/types.ts:80-93`                                        | `HIGHEST: 0`, `HIGH: 100`, `NORMAL: 500`. `LoggerPlugin` is `HIGH` (`logger-plugin.ts:107`), `AuditPlugin` `NORMAL` (`audit-plugin.ts:132`).                                                                   |
| `optionalDependencies` ordering  | `packages/kernel/src/registry/plugin-resolver.ts:49-53`                     | A registered provider of an optional token becomes a **real topological edge**. Confirms §3.4's ordering and the absence of a cycle.                                                                           |
| `Symbol.for` brand precedent     | `packages/common/src/http.ts:519,543,741`; `errors/status-hint.ts:35`       | Five existing cross-package brands. Consulted and **not used here** — the policy is not per-value metadata (§3.2).                                                                                             |
| `RouteValidationMetadata`        | `packages/common/src/http.ts:758-763`                                       | Carries `schema: unknown`, branded onto middleware. Real, but request-side only — see §3.2.                                                                                                                    |
| Validator independence           | `packages/common/src/services/validation.ts:5`                              | "Schemas are `unknown` at this layer so `common` carries no validator" — `common` therefore cannot walk a Zod schema.                                                                                          |
| `ConsoleLogger` redaction        | `packages/logger-plugin/src/loggers/console-logger.ts:73,165-196`           | `redact` defaults to `[]`. `#redactFields` shallow-clones then `#redactPath` walks into the **caller's** nested object and assigns to its leaf. Early-returns on `Array.isArray`.                              |
| `PinoLogger` redaction           | `packages/logger-plugin/src/loggers/pino-logger.ts:209-210`                 | Forwards `redact` to pino only when supplied; pino's own syntax (wildcards, brackets) applies. Divergence from the above is real.                                                                              |
| `normalize-metadata`             | `packages/logger-plugin/src/loggers/normalize-metadata.ts:6-12`             | Normalisation must run **before** redaction so a path such as `error.token` sees the normalised object. Constrains where the decorator sits (§3.5).                                                            |
| `TraceEnrichedLogger`            | `packages/logger-plugin/src/loggers/trace-enriched-logger.ts`               | M90i's decorator, already wrapping the resolved logger and already decorating `child()`. The composition order matters (§3.5).                                                                                 |
| `telemetryMiddleware` attributes | `packages/telemetry-plugin/src/middleware/telemetry-middleware.ts:42,58-60` | Span name is `${method} ${path}`; `http.url` is `request.url`; `http.route` is `request.path`.                                                                                                                 |
| `IRequest.url` / `.path`         | `packages/common/src/http.ts:40,42`                                         | `url` is "The full request URL"; `path` is "The URL path component (**no query string**)". The safe field already exists one line from the unsafe one.                                                         |
| `AuditEntry`                     | `packages/common/src/services/audit.ts:13-30`                               | `before`/`after`/`metadata` are `Readonly<Record<string, unknown>>`, optional.                                                                                                                                 |
| `AuditService.log`               | `packages/audit-plugin/src/services/audit-service.ts:31-45`                 | Copies all three verbatim, stamps `id`/`timestamp`, then `freezeAuditRecord`. Redaction must precede the freeze.                                                                                               |
| `AuditPlugin` optional deps      | `packages/audit-plugin/src/plugin/audit-plugin.ts:130`                      | `optionalDependencies: ['logger']` — a **literal**, not `CAPABILITIES.LOGGER` (§11.2). Fixed here because this line is edited anyway (C3).                                                                     |
| M47 package shape                | `packages/realtime-backplane-plugin/deno.json`, `src/`                      | A small package providing one token that other plugins resolve optionally. The model for `redaction-plugin` (§3.1).                                                                                            |
| Pure utilities in `common`       | `packages/common/src/path-matcher.ts:29,58`                                 | `createPathMatcher` is a pure exported function in `common` (M90a). Establishes that `createRedactionService` may live there under §2.1.                                                                       |
| Synchronous hash precedent       | `packages/feature-flags-plugin/src/evaluation/flag-evaluator.ts:12-24`      | FNV-1a **32-bit**, plugin-internal. Considered and rejected as a built-in redactor (§3.3).                                                                                                                     |
| Workspace / release registration | `deno.json:2` (48 members); `scripts/release-packages.ts:24` (Tier 2)       | Both are explicit lists, not globs. A new package must be added to each.                                                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                              | Resolution (picked side)                                                                                                                                                                                  | Doc deliverable (same PR)                                                                                                                            |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ARCHITECTURE.md:2461` lists "Secret redaction in logs: enabled by default"; AI_GUIDELINES §13.3 and `common/src/services/secrets.ts:12` repeat it. `console-logger.ts:73` defaults `redact` to `[]`. | **Make the documents true**, per §13.4 Secure Defaults: `LoggerPluginOptions.redact` defaults to `DEFAULT_SECRET_FIELD_PATTERNS` instead of `[]`. Breaking; `redact: []` restores the previous behaviour. | CHANGELOG migration entry. The three claims need no edit once true — a test pins each wording against the shipped default so they cannot re-diverge. |
| C2 | `ARCHITECTURE.md:2445-2450` Plugin Responsibilities credits `logger-plugin` with "Redaction of sensitive fields in logs", which will no longer be where redaction is decided.                         | `logger-plugin` keeps its own `redact` option and gains a row-mate: `redaction-plugin` owns the cross-cutting policy. Both rows are accurate after the change.                                            | `ARCHITECTURE.md` §14 Plugin Responsibilities gains a `redaction-plugin` row; the `logger-plugin` row is re-worded to "log-local field redaction".   |
| C3 | `audit-plugin.ts:130` uses the string literal `'logger'` where §11.2 requires `CAPABILITIES.LOGGER`.                                                                                                  | Corrected to the constant. In scope because the same array gains `CAPABILITIES.REDACTION`.                                                                                                                | None (source fix; no doc claims it).                                                                                                                 |
| C4 | `docs/telemetry-collector-fanout.md` describes one trace stream reaching Datadog, New Relic and Azure Monitor, and says nothing about what the stream contains.                                       | The guide states what `http.url` now carries and how `queryParameters: 'redact'` changes it, because that document is where an operator decides to enable the fan-out.                                    | `docs/telemetry-collector-fanout.md` gains a "What reaches the collector" subsection.                                                                |
| C5 | ROADMAP §96 is the only place the new package is catalogued; `ARCHITECTURE.md` §8 Package Architecture lists every package and would omit it.                                                         | §8 gains the node, with the two optional-consumer edges drawn (the M50 precedent for naming a new package in the diagram rather than absorbing it).                                                       | `ARCHITECTURE.md` §8 package node + edges.                                                                                                           |

## 3. Design decisions

### 3.1 Where the capability is registered — a new package, not an option on an existing plugin

- **Decision:** a new `@setu-ts/redaction-plugin` registers `IRedactionService` under
  `CAPABILITIES.REDACTION`. The pure implementation (`createRedactionService`) lives in `common`;
  the plugin is the registration and nothing else.
- **Why:** three plugins must share one policy. Passing a policy object into each one's options is
  three configuration sites that drift, and it makes the policy unreplaceable (§3.4 requires a
  capability token for that). `common` cannot register anything and holds no plugins (§2.1), so a
  package is the only place a token gets provided. This is the M47 `realtime-backplane-plugin` shape
  exactly — a small package providing one token that existing plugins resolve **optionally**.
- **Test home:** `redaction-plugin/test/integration/registration.test.ts` (token resolves from a
  real kernel app); `logger-plugin/test/integration/redaction-absent.test.ts` (no plugin registered
  ⇒ behaviour identical to today).

### 3.2 How a field is classified — a field-path policy, not a schema brand and not a decorator

- **Decision:** `RedactionPolicy.fields` maps field-path patterns to a `DataClassification`.
  Patterns are dot-separated segments where `*` matches exactly one segment (including an array
  index) and `**` matches zero or more. Matching is **case-insensitive** per segment.
- **Why:** the two obvious alternatives do not survive the source. A **property decorator** has
  nothing to attach to — `IDataSource` returns plain rows and `decorator-plugin.ts:345` answers with
  `ctx.response.json(result)`, so there is no class instance in the path (this is also why .NET's
  `[PersonalData]` and Nest's `@Exclude()` work and a copy here would not). A **schema brand** looks
  free, because M70m already carries `schema: unknown` through `RouteValidationMetadata`
  (`http.ts:758-763`), but `validation.ts:5` records that `common` deliberately carries no validator
  and so cannot walk a Zod schema, and the brand covers **request** targets while every leak in §0
  is on the **response** side, where nothing is validated. The path policy is validator-agnostic,
  works on plain objects, and is a superset of the `redact` dot-paths already released — so every
  existing value keeps working. Case-insensitivity is chosen because the failure it prevents (a
  field spelled `apiKey` when the policy says `apikey`) is silent under-redaction, while its cost
  (over-redacting a field whose casing differs but whose meaning does not) is loud and recoverable.
- **Test home:** `common/test/unit/field-matcher.test.ts`.

### 3.3 What a redactor may do — synchronous only, `erase` and `mask` built in

- **Decision:** `Redactor` is `(value: unknown, context: RedactionContext) => unknown` —
  synchronous. `eraseRedactor` (→ `'[Redacted]'`) and `createMaskRedactor({ keep })` (→ last `keep`
  characters preserved) ship. No hashing redactor ships.
- **Why:** `ILogger.info` returns `void` (`logger.ts:38-73`), so anything on the logging path must
  complete synchronously, and `IRuntimeServices` exposes only `subtle`, whose `sign`/`digest` are
  async — so the correlation-preserving `HmacRedactor` .NET ships **cannot be built here**. The one
  synchronous hash in the tree is FNV-1a 32-bit
  (`feature-flags-plugin/src/evaluation/flag-evaluator.ts:12-24`), which over an identifier-sized
  domain is reversible by enumeration; shipping it as a redactor would put a weak primitive behind a
  strong-sounding name, which is worse than shipping none. Correlation-preserving redaction is
  therefore the application's, through the `Redactor` extension point (§3.4 replaceability), and a
  cryptographic one waits on the key-management milestone.
- **Test home:** `common/test/unit/redactors.test.ts`.

### 3.4 How the three consumers obtain the service — optional token plus a real edge

- **Decision:** each of `logger-plugin`, `telemetry-plugin` and `audit-plugin` adds
  `CAPABILITIES.REDACTION` to `optionalDependencies` and resolves it **once at `register()`** via
  `ctx.services.has` / `get`. `RedactionPlugin` declares `priority: PLUGIN_PRIORITY.HIGHEST` and no
  optional dependency of its own.
- **Why:** `plugin-resolver.ts:49-53` makes an optional token a real topological edge, so the
  provider is ordered first and a register-time read is correct — no per-call registry lookup on the
  logging hot path. The edge is load-bearing here (unlike M45b, where priority already produced the
  order), and `HIGHEST` backs it up so the two mechanisms agree. No cycle is possible because
  `RedactionPlugin` consumes nothing — which is the M90i trap avoided by construction:
  `TelemetryPlugin` already declares `CAPABILITIES.LOGGER` optionally (`telemetry-plugin.ts:142`),
  so a redaction plugin that wanted a logger would close a loop and make every application
  registering both fail at `start()`.
- **Test home:** `redaction-plugin/test/integration/ordering.test.ts` asserts the resolved order and
  that a cycle is not introduced.

### 3.5 Where redaction sits in the logger — an outermost decorator, with `child()` decorated

- **Decision:** `LoggerPlugin` wraps the resolved logger as
  `RedactingLogger(TraceEnrichedLogger(<logger>))` — redaction **outermost**.
  `RedactingLogger.child` redacts its bindings and returns a `RedactingLogger` around the inner
  child. The existing `redact` option stays inside `ConsoleLogger`/pino and is unchanged in
  placement.
- **Why:** outermost means the framework's own additions are never candidates for redaction — M90i's
  `trace_id`/`span_id` are framework-controlled and redacting them would silently disable that
  milestone's feature — while everything the application passed is redacted before any framework
  code sees it. `child()` must be decorated or the property is lost exactly where it matters: M90i
  records that the framework's own request logger calls `child()` (`request-logger.ts:71`), so an
  undecorated child would strip redaction from every request-scoped record. Normalisation stays
  inside the concrete loggers, preserving `normalize-metadata.ts:6-12`'s stated ordering for the
  `redact` option.
- **Test home:** `logger-plugin/test/unit/redacting-logger.test.ts` (including a `child()` case and
  a case asserting `trace_id` survives).

### 3.6 The two logger defects — fixed by routing both through `common`'s one implementation

- **Decision:** `ConsoleLogger`'s `#redactFields`/`#redactPath` are deleted and replaced by a
  `createRedactionService` built from the `redact` paths (classification `secret`, redactor
  `eraseRedactor`). `PinoLogger` continues to forward `redact` to pino **unchanged** and
  additionally applies the same service.
- **Why:** one walk implementation satisfies §11.1 and fixes both defects at once — the shared walk
  clones every level it descends, so the caller's nested object is no longer mutated, and it
  understands `*`/`**`, so a wildcard pattern stops silently doing nothing on the default logger.
  Continuing to forward to pino keeps pino's exotic bracket syntax working, so nothing released
  breaks (§9.4); the double application is idempotent because the second pass sees `'[Redacted]'`.
  The residual — pino-only bracket syntax still has no console equivalent — is documented rather
  than claimed fixed.
- **Test home:** `logger-plugin/test/unit/console-logger-redaction.test.ts`, with a regression case
  asserting the caller's object is unmodified and a case asserting an array path redacts.

### 3.7 The `http.url` repair — independent of the port, fail-closed

- **Decision:** `http.url` is built by a pure `sanitizeUrl(url, mode, service?)`.
  `TelemetryPluginOptions.queryParameters` defaults to `'omit'`: the attribute carries origin and
  path only, with query and fragment dropped. `'redact'` keeps the query, passing each parameter
  through `service.redactValue('query.' + name, value)`. `'redact'` **with no service registered
  falls back to `'omit'` and warns once at `register()`**.
- **Why:** a defect fix may not require opting into a new plugin, so the safe behaviour is the
  default and the repair works with nothing else installed. `'omit'` matches what `http.route`
  beside it already does, so the two attributes stop disagreeing about whether a query string is
  exportable. The fallback is fail-closed with a diagnostic rather than fail-open: an operator who
  asked for per-parameter redaction and has no policy must not silently get every parameter
  exported.
- **Test home:** `telemetry-plugin/test/unit/sanitize-url.test.ts`;
  `telemetry-plugin/test/integration/span-attributes.test.ts` drives a real kernel app and reads the
  finished span.

### 3.8 The audit seam — redact before the freeze, all three fields

- **Decision:** `AuditService.log` passes `before`, `after` and `metadata` through `redactRecord`
  before building the stored record, so redaction precedes `freezeAuditRecord`. An absent field
  stays absent (never `{}`).
- **Why:** the freeze is what makes the entry immutable, so redaction has to happen upstream of it
  or not at all. All three fields are included because `metadata` is documented as carrying "IP,
  request ID, …" (`audit.ts:28`) and an IP is exactly the kind of field a policy classifies.
  Preserving absence matters under `exactOptionalPropertyTypes` and keeps the stored shape unchanged
  for an entry with nothing to redact.
- **Test home:** `audit-plugin/test/unit/audit-service-redaction.test.ts`.

### 3.9 What replaces a build-time report — nothing, and the reason is recorded

- **Decision:** no build-time classification report ships, and no `scripts/` gate is added for one.
- **Why:** `Microsoft.Extensions.AuditReports` works because .NET classifies **types** a compiler
  can see; this policy is runtime data held by an application, so a framework-side script would
  report nothing about a consumer's application and a gate over `packages/` would report only the
  framework's own defaults. Recording the non-equivalence is the deliverable; building a script that
  looks like the .NET artifact and proves nothing would be worse than having none.
- **Test home:** none (a decision not to ship). The recurrence risk it would have covered — a fourth
  exporter added without wiring — is covered by §6's `egress-consumers.test.ts` instead.

### 3.10 Naming — `redaction`, not `data-classification` or `data-protection`

- **Decision:** token `redaction`, port `IRedactionService`, package `@setu-ts/redaction-plugin`.
  `DataClassification` remains the vocabulary **inside** the policy.
- **Why:** the capability shipped is redaction; classification is how it decides. `data-protection`
  would imply key management, which is explicitly a later milestone, and naming a token for an
  aspiration is how a surface acquires readers that expect more than it does.
- **Test home:** `common/test/unit/tokens.test.ts` (grammar) — the name itself is pinned by
  `PUBLIC_API.md` and the barrel test.

## 4. Exported surface — every symbol names its consumer

### `@setu-ts/common`

| Exported symbol                 | Kind      | Consumer / real code path that READS it                                                                               |
| ------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES.REDACTION`        | constant  | `RedactionPlugin.provides`; the three consumers' `optionalDependencies` and `ctx.services.get`.                       |
| `IRedactionService`             | interface | `RedactingLogger`, `AuditService`, `sanitizeUrl`; the type `RedactionPlugin` registers.                               |
| `createRedactionService`        | function  | `RedactionPlugin.register`; `ConsoleLogger` (for its own `redact` paths, §3.6); every test that needs a real service. |
| `Redactor`                      | type      | `RedactionPolicy.redactors` values; the application-supplied extension point (§3.3).                                  |
| `RedactionContext`              | interface | The second parameter of every `Redactor`; read by `createMaskRedactor` to report the path in its own output.          |
| `RedactionPolicy`               | interface | `createRedactionService` parameter; `RedactionPluginOptions.policy`.                                                  |
| `DataClassification`            | type      | `RedactionPolicy.fields` values; `RedactionContext.classification`.                                                   |
| `DATA_CLASSIFICATIONS`          | constant  | Policy authors; `DEFAULT_SECRET_FIELD_PATTERNS` maps to `.SECRET`.                                                    |
| `DEFAULT_SECRET_FIELD_PATTERNS` | constant  | `LoggerPluginOptions.redact`'s default (C1).                                                                          |
| `eraseRedactor`                 | constant  | The default redactor inside `createRedactionService`; `ConsoleLogger`'s `redact` compilation.                         |
| `createMaskRedactor`            | function  | Policy authors; used by `redaction-plugin`'s README example and the integration test's PAN case.                      |

`FieldMatcher` and the compiled-policy internals are **not** exported — they have no consumer
outside `createRedactionService`, and exporting them would also leak a private type into
`deno doc --lint` (the M82 precedent for cutting an export at plan time rather than shipping it).

### `@setu-ts/redaction-plugin`

| Exported symbol          | Kind      | Consumer / real code path that READS it                                      |
| ------------------------ | --------- | ---------------------------------------------------------------------------- |
| `RedactionPlugin`        | function  | An application's `plugins` array; the integration tests; the README example. |
| `RedactionPluginOptions` | interface | The `RedactionPlugin` parameter; `PUBLIC_API.md` options table.              |

No `src/index.ts` change in `logger-plugin`, `telemetry-plugin` or `audit-plugin` —
`RedactingLogger` and `sanitizeUrl` are internal. Each of the three gains a `barrel-exports.test.ts`
assertion pinning that (the M56 defect class: a barrel change that no test sees).

### 4.1 Options — every option names its consumer

| Option                                   | Consumer                      | Behavior (per implementation)                                                                                                                                                                           |
| ---------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RedactionPluginOptions.policy`          | `createRedactionService`      | Required. `fields` compiles to the matcher; `redactors` maps a classification to a `Redactor`; `defaultRedactor` covers a classification with no entry, itself defaulting to `eraseRedactor`.           |
| `RedactionPolicy.fields`                 | the matcher                   | Pattern → classification. An empty record is legal and yields a service that redacts nothing (useful as an explicit "policy decided: none").                                                            |
| `RedactionPolicy.redactors`              | `createRedactionService`      | Optional. A classification present here uses its redactor; absent falls to `defaultRedactor`.                                                                                                           |
| `RedactionPolicy.defaultRedactor`        | `createRedactionService`      | Optional, defaults to `eraseRedactor`.                                                                                                                                                                  |
| `MaskOptions.keep`                       | `createMaskRedactor`          | Number of trailing characters preserved; defaults to `4`. A value ≥ the string's length redacts everything (never reveals the whole value). Non-string input is erased.                                 |
| `LoggerPluginOptions.redact` (default)   | `ConsoleLogger`, `PinoLogger` | **Changed**: defaults to `DEFAULT_SECRET_FIELD_PATTERNS` instead of `[]` (C1). `[]` restores previous behaviour.                                                                                        |
| `TelemetryPluginOptions.queryParameters` | `sanitizeUrl`                 | `'omit'` (default) drops query and fragment from `http.url`; `'redact'` keeps the query with each parameter through the service, falling back to `'omit'` with a warning when no service is registered. |

## 5. Implementation files

| File                                                               | Purpose                                                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `packages/common/src/redaction/classification.ts`                  | `DataClassification`, `DATA_CLASSIFICATIONS`, `DEFAULT_SECRET_FIELD_PATTERNS`.                        |
| `packages/common/src/redaction/redactors.ts`                       | `Redactor`, `RedactionContext`, `eraseRedactor`, `createMaskRedactor`, `MaskOptions`.                 |
| `packages/common/src/redaction/policy.ts`                          | `RedactionPolicy`.                                                                                    |
| `packages/common/src/redaction/field-matcher.ts`                   | Internal compiled pattern matcher (`*` / `**`, case-insensitive segments).                            |
| `packages/common/src/redaction/redaction-service.ts`               | `IRedactionService`, `createRedactionService`, the record walk.                                       |
| `packages/common/src/tokens.ts`                                    | **Modified** — `REDACTION: 'redaction'`.                                                              |
| `packages/common/src/index.ts`                                     | **Modified** — barrel re-exports for the above.                                                       |
| `packages/redaction-plugin/deno.json`                              | New manifest (`0.6.0`, `exports: ./src/index.ts`).                                                    |
| `packages/redaction-plugin/README.md`                              | New; fence-compiled by the package-README gate.                                                       |
| `packages/redaction-plugin/src/plugin/redaction-plugin.ts`         | `RedactionPlugin`, `RedactionPluginOptions`.                                                          |
| `packages/redaction-plugin/src/index.ts`                           | Barrel.                                                                                               |
| `packages/logger-plugin/src/loggers/redacting-logger.ts`           | New `RedactingLogger` decorator (§3.5).                                                               |
| `packages/logger-plugin/src/loggers/console-logger.ts`             | **Modified** — `#redactFields`/`#redactPath` deleted, routed through `createRedactionService` (§3.6). |
| `packages/logger-plugin/src/loggers/pino-logger.ts`                | **Modified** — applies the same service; still forwards `redact` to pino.                             |
| `packages/logger-plugin/src/plugin/logger-plugin.ts`               | **Modified** — secret default (C1), optional token, decorator composition.                            |
| `packages/telemetry-plugin/src/attributes/sanitize-url.ts`         | New pure URL builder (§3.7).                                                                          |
| `packages/telemetry-plugin/src/middleware/telemetry-middleware.ts` | **Modified** — `http.url` via `sanitizeUrl`.                                                          |
| `packages/telemetry-plugin/src/plugin/telemetry-plugin.ts`         | **Modified** — `queryParameters` option, optional token, the fallback warning.                        |
| `packages/telemetry-plugin/src/interfaces/index.ts`                | **Modified** — `TelemetryPluginOptions.queryParameters`.                                              |
| `packages/audit-plugin/src/services/audit-service.ts`              | **Modified** — redact before freeze (§3.8).                                                           |
| `packages/audit-plugin/src/plugin/audit-plugin.ts`                 | **Modified** — optional token; `'logger'` literal → `CAPABILITIES.LOGGER` (C3).                       |
| `deno.json`, `scripts/release-packages.ts`                         | **Modified** — 49th workspace member; Tier 2 release entry.                                           |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                   | src covered                                                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/field-matcher.test.ts`                    | `redaction/field-matcher.ts`                                       | Literal dot-path; `*` matches exactly one segment including an array index; `**` matches zero or more; case-insensitive segments; a non-matching path returns `undefined`; a pattern longer than the path does not match.                                              |
| `common/test/unit/redactors.test.ts`                        | `redaction/redactors.ts`                                           | `eraseRedactor` → `'[Redacted]'` for every input type; `createMaskRedactor({ keep: 4 })` preserves exactly four trailing characters; `keep` ≥ length redacts wholly; non-string input erased. Calls type-check against `Redactor`.                                     |
| `common/test/unit/redaction-service.test.ts`                | `redaction/redaction-service.ts`, `policy.ts`, `classification.ts` | `redactRecord` returns a copy and **does not mutate the input at any depth** (the §3.6 defect, asserted at the source); nested objects and arrays; absent fields stay absent; `redactValue` returns the input unchanged when unclassified; `defaultRedactor` fallback. |
| `common/test/unit/barrel-exports.test.ts`                   | `index.ts`, `tokens.ts`                                            | **Extended** — the eleven new symbols are exported and `FieldMatcher` is not; `CAPABILITIES.REDACTION === 'redaction'` and satisfies the token grammar.                                                                                                                |
| `redaction-plugin/test/unit/redaction-plugin.test.ts`       | `plugin/redaction-plugin.ts`                                       | `provides` is `[CAPABILITIES.REDACTION]`; `priority` is `HIGHEST`; `optionalDependencies` is absent; the registered value satisfies `IRedactionService`.                                                                                                               |
| `redaction-plugin/test/integration/registration.test.ts`    | `plugin/redaction-plugin.ts`, `index.ts`                           | Real `createApplication` — the token resolves after `start()` and redacts through the resolved service.                                                                                                                                                                |
| `redaction-plugin/test/integration/ordering.test.ts`        | (ordering behaviour)                                               | With all four plugins registered, `RedactionPlugin` registers before logger, telemetry and audit; registering it does **not** introduce a cycle (the app starts).                                                                                                      |
| `logger-plugin/test/unit/redacting-logger.test.ts`          | `loggers/redacting-logger.ts`                                      | Every level redacts metadata; `child(bindings)` redacts bindings **and** returns a decorated child; `undefined` metadata passes through; a framework-added `trace_id` is untouched (§3.5).                                                                             |
| `logger-plugin/test/unit/console-logger-redaction.test.ts`  | `loggers/console-logger.ts`                                        | Regression: the caller's nested object is **byte-identical after logging** (fails without §3.6); a path through an array redacts; a `*` wildcard redacts.                                                                                                              |
| `logger-plugin/test/integration/redaction-absent.test.ts`   | `plugin/logger-plugin.ts`                                          | With no `RedactionPlugin`, output is identical to the pre-milestone baseline except the C1 default; `redact: []` reproduces the pre-milestone baseline exactly.                                                                                                        |
| `logger-plugin/test/integration/secret-default.test.ts`     | `plugin/logger-plugin.ts`                                          | A field named `password`/`apiKey`/`Authorization` is redacted with no configuration (C1), driving the **real** `ConsoleLogger` and the real plugin; the three doc wordings are pinned against the shipped default list.                                                |
| `logger-plugin/test/unit/pino-logger-redaction.test.ts`     | `loggers/pino-logger.ts`                                           | The service is applied **and** `redact` still reaches pino's options (guarded real-import test for the pino path, per §12.2).                                                                                                                                          |
| `telemetry-plugin/test/unit/sanitize-url.test.ts`           | `attributes/sanitize-url.ts`                                       | `'omit'` drops query and fragment and keeps origin+path; `'redact'` with a service masks a classified parameter and keeps an unclassified one; `'redact'` with no service behaves as `'omit'`; a malformed URL degrades without throwing.                              |
| `telemetry-plugin/test/integration/span-attributes.test.ts` | `middleware/telemetry-middleware.ts`, `plugin/telemetry-plugin.ts` | Real kernel app + real in-memory span exporter: a request carrying `?email=…` produces a finished span whose `http.url` contains neither the parameter name nor its value; the `'redact'` warning fires exactly once.                                                  |
| `audit-plugin/test/unit/audit-service-redaction.test.ts`    | `services/audit-service.ts`                                        | `before`/`after`/`metadata` are each redacted; redaction precedes the freeze (the stored record is frozen **and** redacted); an absent field stays absent; with no service the stored record is byte-identical to today.                                               |
| `audit-plugin/test/integration/audit-redaction.test.ts`     | `plugin/audit-plugin.ts`                                           | Real app with `RedactionPlugin` + `AuditPlugin`: an entry written through the resolved `IAuditLogger` reads back redacted from `MemoryAuditStorage`.                                                                                                                   |
| `test/unit/egress-consumers.test.ts` (root)                 | (recurrence gate)                                                  | Enumerates the three packages that export application data and asserts each declares `CAPABILITIES.REDACTION` in `optionalDependencies` — so a fourth exporter added without wiring is visible (the `apps-gate.test.ts` precedent, §3.9).                              |
| `test/unit/compliance-vocabulary.test.ts` (root)            | (recurrence gate)                                                  | `grep`-equivalent over `packages/*/src`: no shipped identifier, option or doc line names PII, PHI, PCI, HIPAA, GDPR or DSS — the §0 scope boundary made mechanical.                                                                                                    |

Coverage note: `field-matcher.ts` and `redaction-service.ts` carry the branch-heavy logic and are
planned to 100%; every other new file is small enough that the named tests clear 90% on all three
axes. `redaction-plugin` has no external dependency, so §12.2's guarded real-import requirement
applies only to the pino path, which `pino-logger-redaction.test.ts` covers.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m96-redaction-seam, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # new package — run on a COMMITTED tree
deno task release:verify 0.6.0   # must report 49 publishable packages
deno task check:docs        # PUBLIC_API section, README fences, package catalogue
```

A new package publishes for the first time, so `docs/releasing.md`'s `release:create-packages` +
`release:link-repos` step applies at the next release (the M92 `view-plugin` precedent); the plan's
deliverable is the runbook note, not the run.

## 8. Risks & mitigations

- **The C1 default silently changes existing log output.** A team parsing logs for a field named
  `token` sees `[Redacted]`. → CHANGELOG migration text naming `redact: []` as the exact
  restoration, and `redaction-absent.test.ts` pins that `[]` reproduces the pre-milestone baseline
  byte-for-byte.
- **Case-insensitive matching over-redacts.** A field legitimately named `Token` (a lexer token, a
  public OAuth client token) is redacted. → Documented in the option's JSDoc and the README; the
  policy author can scope a pattern to a full path (`parser.Token`) rather than `**.token`.
- **`redactRecord` allocates a path string per leaf.** The matcher takes `match(path: string)`
  rather than a stepping cursor, so a large record costs one string per leaf. → Accepted: log
  metadata and audit `before`/`after` are small, the cost is the same order as the JSON
  serialisation that follows, and the patterns are compiled once at construction (§14 hoisting). A
  stepping cursor is the optimisation if a benchmark ever shows it, and it needs no API change
  because the matcher is internal.
- **A second redaction layer on the logger is confusing.** `redact` (inside the logger) and the
  service (outside it) both run. → One README subsection states which is which and why, and §3.6
  records that the residual pino-only bracket syntax is not claimed fixed.
- **Double redaction changes a value twice.** A field matched by both `redact` and the service is
  redacted, then the already-redacted value is matched again. → `eraseRedactor` is idempotent and
  `createMaskRedactor` over `'[Redacted]'` yields a masked constant, not a leak; a test pins the
  composed result.
- **The 49th package is a release-list omission risk.** M51 shipped a package in neither release
  list. → `release:verify` is in §7's gate list and must report 49.

## 9. Out of scope

- **Field-level encryption and erasure fan-out** — the storage half. `cache-middleware.ts:136-137`,
  `redis-queue.ts:192`, messaging envelopes and `FileAuditStorage` each persist a plaintext copy;
  redaction does not touch them and must not be documented as if it did. Unowned; named in ROADMAP
  §96.
- **Key management** — promoting `session-plugin/src/codec/crypto.ts`'s `KeyRing`/`deriveKeyRing`/
  `seal`/`open` into a general capability. Its own milestone, and the prerequisite for a
  cryptographic redactor (§3.3).
- **A build-time classification report** — not reproducible against a runtime policy (§3.9).
- **`http.route` and the span name carrying a concrete path.** Both leak an identifier the same way
  `http.url` did, and neither is fixable here: the matched route template is not available to the
  middleware (M70l). A kernel change owns it.
- **OpenTelemetry semantic-convention renames** (`http.url` → `url.full`, `http.method` →
  `http.request.method`) — a second breaking change that would invalidate existing dashboards, and
  unrelated to the leak.
- **Redacting spans an application creates itself.** Only framework-set attributes are covered;
  wrapping every `span.setAttribute` means wrapping the span object, which changes a surface M24
  committed.
- **A `PUBLIC_API.md` section for `logger-plugin`'s internal decorator** — `RedactingLogger` is not
  exported, deliberately (§4).
