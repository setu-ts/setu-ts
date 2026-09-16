# Milestone 96 — Redaction (`@setu-ts/common` + three consumers)

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

- **In scope:** the `IRedactionService` port and the pure policy/matcher/redactor implementation in
  `common`; one `redaction` option on each of the three consumers' existing plugin options;
  `logger-plugin` (shared implementation behind both loggers, secret-field default, an service
  applied after normalisation); `telemetry-plugin` (the `http.url` leak repair and classified span
  attributes); `audit-plugin` (`before`/`after`/`metadata` through the service).
- **NOT this milestone:** field-level encryption at rest, erasure fan-out, and the plaintext copies
  `cache-plugin`/`queue-plugin`/`messaging-plugin` persist — the storage half, unowned and named in
  ROADMAP §96 "Out of scope". Promoting `session-plugin`'s key ring into a general key-management
  capability — its own milestone, and the prerequisite for a cryptographic redactor. A build-time
  classification report — not reproducible against a runtime policy (§3.9). `http.route` carrying a
  concrete path rather than the matched route template — a kernel change (M70l records that the
  middleware never receives the matched pattern). OpenTelemetry semantic-convention renames.

## 1. Contracts verified from SOURCE (not names)

| Reference                        | Source (file:line)                                                                                                              | Verified surface / fact                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ILogger`                        | `packages/common/src/services/logger.ts:38-80`                                                                                  | Six level methods all return **`void`** — synchronous — plus `child(bindings: LogMetadata): ILogger`. Rules out any async redactor on the logging path (§3.3) and forces the decorator to wrap `child` (§3.5).              |
| `LogMetadata`                    | `packages/common/src/services/logger.ts:14`                                                                                     | `Readonly<Record<string, unknown>>` — so a redactor returns a copy and never mutates in place.                                                                                                                              |
| Option-passed collaborators      | M52d `SchedulerPlugin({ distributedLock })`; M52 `SessionPlugin({ store })`; M52c `DatabasePlugin({ type: 'custom', adapter })` | Three shipped precedents for an application-constructed value reaching a plugin through its options rather than through a token. The model for §3.1.                                                                        |
| `PLUGIN_PRIORITY`                | `packages/common/src/types.ts:80-93`                                                                                            | `HIGHEST: 0`, `HIGH: 100`, `NORMAL: 500`. `LoggerPlugin` is `HIGH` (`logger-plugin.ts:107`), `AuditPlugin` `NORMAL` (`audit-plugin.ts:132`).                                                                                |
| `realtime-backplane-plugin`      | `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts:60-107`                                             | `async register`, `await backplane.connect()`, a health indicator and an `onClose` — real resources. Cited in an earlier draft as "the M47 shape exactly" for a pure transform; it is not, and §3.1 records the correction. |
| `Symbol.for` brand precedent     | `packages/common/src/http.ts:519,543,741`; `errors/status-hint.ts:35`                                                           | Five existing cross-package brands. Consulted and **not used here** — the policy is not per-value metadata (§3.2).                                                                                                          |
| `RouteValidationMetadata`        | `packages/common/src/http.ts:758-763`                                                                                           | Carries `schema: unknown`, branded onto middleware. Real, but request-side only — see §3.2.                                                                                                                                 |
| Validator independence           | `packages/common/src/services/validation.ts:5`                                                                                  | "Schemas are `unknown` at this layer so `common` carries no validator" — `common` therefore cannot walk a Zod schema.                                                                                                       |
| `ConsoleLogger` redaction        | `packages/logger-plugin/src/loggers/console-logger.ts:73,165-196`                                                               | `redact` defaults to `[]`. `#redactFields` shallow-clones then `#redactPath` walks into the **caller's** nested object and assigns to its leaf. Early-returns on `Array.isArray`.                                           |
| `PinoLogger` redaction           | `packages/logger-plugin/src/loggers/pino-logger.ts:209-210`                                                                     | Forwards `redact` to pino only when supplied; pino's own syntax (wildcards, brackets) applies. Divergence from the above is real.                                                                                           |
| `normalize-metadata`             | `packages/logger-plugin/src/loggers/normalize-metadata.ts:6-12`                                                                 | Normalisation must run **before** redaction so a path such as `error.token` sees the normalised object. Constrains where the decorator sits (§3.5).                                                                         |
| `TraceEnrichedLogger`            | `packages/logger-plugin/src/loggers/trace-enriched-logger.ts`                                                                   | M90i's decorator (`child()` decorated at `:124-125`), applied by `LoggerPlugin` at `logger-plugin.ts:126-135`. It enriches from OUTSIDE the concrete logger, so its fields reach the redaction walk — accepted in §3.5.     |
| `telemetryMiddleware` attributes | `packages/telemetry-plugin/src/middleware/telemetry-middleware.ts:42,58-60`                                                     | Span name is `${method} ${path}`; `http.url` is `request.url`; `http.route` is `request.path`.                                                                                                                              |
| `IRequest.url` / `.path`         | `packages/common/src/http.ts:40,42`                                                                                             | `url` is "The full request URL"; `path` is "The URL path component (**no query string**)". The safe field already exists one line from the unsafe one.                                                                      |
| `AuditEntry`                     | `packages/common/src/services/audit.ts:13-30`                                                                                   | `before`/`after`/`metadata` are `Readonly<Record<string, unknown>>`, optional.                                                                                                                                              |
| `AuditService.log`               | `packages/audit-plugin/src/services/audit-service.ts:31-45`                                                                     | Copies all three verbatim, stamps `id`/`timestamp`, then `freezeAuditRecord`. Redaction must precede the freeze.                                                                                                            |
| `AuditPlugin` optional deps      | `packages/audit-plugin/src/plugin/audit-plugin.ts:130`                                                                          | `optionalDependencies: ['logger']` — a **literal**, not `CAPABILITIES.LOGGER` (§11.2). Fixed here because this line is edited anyway (C3).                                                                                  |
| Pure utilities in `common`       | `packages/common/src/path-matcher.ts:29,58`                                                                                     | `createPathMatcher` is a pure exported function in `common` (M90a). Establishes that `createRedactionService` may live there under §2.1.                                                                                    |
| Synchronous hash precedent       | `packages/feature-flags-plugin/src/evaluation/flag-evaluator.ts:12-24`                                                          | FNV-1a **32-bit**, plugin-internal. Considered and rejected as a built-in redactor (§3.3).                                                                                                                                  |
| Workspace / release registration | `deno.json:2` (48 members); `scripts/release-packages.ts:24` (Tier 2)                                                           | Both are explicit lists, not globs. A new package must be added to each.                                                                                                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                              | Resolution (picked side)                                                                                                                                                                                         | Doc deliverable (same PR)                                                                                                                                                                                                                                                                                                                                                                    |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ARCHITECTURE.md:2461` lists "Secret redaction in logs: enabled by default"; AI_GUIDELINES §13.3 and `common/src/services/secrets.ts:12` repeat it. `console-logger.ts:73` defaults `redact` to `[]`. | **Make the documents true**, per §13.4 Secure Defaults: `LoggerPluginOptions.redact` defaults to `DEFAULT_SECRET_FIELD_PATTERNS` instead of `[]`. Breaking; `redact: []` restores the previous behaviour.        | CHANGELOG migration entry. The three sentences need no edit once true, and the claim is pinned behaviourally rather than textually: `secret-default.test.ts` drives the REAL `LoggerPlugin` with NO `redact` option and asserts a record carrying each named field family comes out redacted. A prose-matching test was rejected — it would pass against a default that had silently shrunk. |
| C2 | `ARCHITECTURE.md:2445-2450` Plugin Responsibilities credits ONLY `logger-plugin` with "Redaction of sensitive fields in logs", while after this milestone three packages apply the same policy.       | The `logger-plugin` row stays and stops being the whole story: telemetry and audit gain rows naming what each redacts. No package owns "the policy" — the application does, and it hands the same value to each. | `ARCHITECTURE.md` §14 Plugin Responsibilities gains `telemetry-plugin` (span attributes) and `audit-plugin` (entry bodies) rows.                                                                                                                                                                                                                                                             |
| C3 | `audit-plugin.ts:130` uses the string literal `'logger'` where §11.2 requires `CAPABILITIES.LOGGER`.                                                                                                  | **Out of scope now.** It was in scope only because that array was to gain `CAPABILITIES.REDACTION`; with no token the line is untouched, so fixing it here would be an unrelated edit. Recorded in §9.           | None.                                                                                                                                                                                                                                                                                                                                                                                        |
| C4 | `docs/telemetry-collector-fanout.md` describes one trace stream reaching Datadog, New Relic and Azure Monitor, and says nothing about what the stream contains.                                       | The guide states what `http.url` now carries and how `queryParameters: 'redact'` changes it, because that document is where an operator decides to enable the fan-out.                                           | `docs/telemetry-collector-fanout.md` gains a "What reaches the collector" subsection.                                                                                                                                                                                                                                                                                                        |
| C5 | ROADMAP §96 is the only place the new package is catalogued; `ARCHITECTURE.md` §8 Package Architecture lists every package and would omit it.                                                         | §8 gains the node, with the two optional-consumer edges drawn (the M50 precedent for naming a new package in the diagram rather than absorbing it).                                                              | `ARCHITECTURE.md` §8 package node + edges.                                                                                                                                                                                                                                                                                                                                                   |

## 3. Design decisions

### 3.1 How the service reaches its consumers — a plugin option, no package and no token

- **Decision:** `createRedactionService` is a pure factory exported from `common`, and each of
  `LoggerPluginOptions`, `TelemetryPluginOptions` and `AuditPluginOptions` gains one optional
  `redaction?: RedactionPolicy | IRedactionService` member. **No new package, no
  `CAPABILITIES.REDACTION` token, and no capability registration anywhere.** An application builds
  the policy once and passes the same value to the plugins it wants covered.
- **Why:** the package this plan carried until review contained no implementation — the matcher,
  redactors and walk must live in `common` regardless, because three plugins consume them and §2.2
  forbids plugin-to-plugin imports — so its whole purpose was to make the service resolvable by
  name, and nothing needs to resolve it. Tested one by one, the reasons for a token do not hold: the
  "three config sites drift" argument describes one `const` referenced three times, which is what
  `SchedulerPlugin({ distributedLock })`, `SessionPlugin({ store })` and
  `DatabasePlugin({ type: 'custom', adapter })` already do; §3.4's replaceability is satisfied by
  the option's union arm, since an application may pass its own `IRedactionService`; and application
  code that wants the same redactor holds the POLICY, which is the source of truth, so
  `createRedactionService(policy)` hands it an equivalent service with nothing to drift. The cited
  M47 precedent was also wrong — `realtime-backplane-plugin` has `async register`,
  `await
  backplane.connect()`, a health indicator and an `onClose`
  (`realtime-backplane-plugin.ts:60-107`); redaction is a pure synchronous transform over a frozen
  policy, and the true precedent is M90a's `createPathMatcher`: a pure function in `common` adopted
  directly by four call sites with no plugin and no token. The decisive asymmetry is reversibility:
  adding a token later is purely additive, while deleting a published package is not — JSR versions
  are immutable, so `@setu-ts/redaction-plugin@0.6.x` would exist forever.
- **Test home:** `logger-plugin/test/integration/redaction-absent.test.ts` (no `redaction` option ⇒
  behaviour identical to today) and each consumer's own suite, which passes the option directly.

### 3.2 How a field is classified — a field-path policy, not a schema brand and not a decorator

- **Decision:** `RedactionPolicy.fields` maps field-path patterns to a `DataClassification`.
  Patterns are dot-separated segments where `*` matches exactly one segment (including an array
  index) and `**` matches zero or more. Case sensitivity is a **compilation flag**, not a global
  rule: a `RedactionPolicy` compiles case-INSENSITIVE, while the released `redact` option compiles
  case-SENSITIVE.
- **Why:** the two obvious alternatives do not survive the source. A **property decorator** has
  nothing to attach to — `IDataSource` returns plain rows and `decorator-plugin.ts:345` answers with
  `ctx.response.json(result)`, so there is no class instance in the path (this is also why .NET's
  `[PersonalData]` and Nest's `@Exclude()` work and a copy here would not). A **schema brand** looks
  free, because M70m already carries `schema: unknown` through `RouteValidationMetadata`
  (`http.ts:758-763`), but `validation.ts:5` records that `common` deliberately carries no validator
  and so cannot walk a Zod schema, and the brand covers **request** targets while every leak in §0
  is on the **response** side, where nothing is validated. The path policy is validator-agnostic,
  works on plain objects, and is a superset of the `redact` dot-paths already released — so every
  existing value keeps working. Case-insensitivity is chosen for the policy because the failure it
  prevents (a field spelled `apiKey` when the policy says `apikey`) is silent under-redaction, while
  its cost (over-redacting a field whose casing differs but whose meaning does not) is loud and
  recoverable. It is **not** applied to `redact`, whose current walk reaches each segment by direct
  property lookup (`console-logger.ts:182-196`) and is therefore case-sensitive today: flipping it
  would silently widen a released option's match set, which §9.4 forbids and which this plan would
  otherwise have shipped without listing as a breaking change.
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

### 3.4 What the option accepts, and when it is compiled

- **Decision:** `redaction?: RedactionPolicy | IRedactionService`. A policy is compiled to a service
  ONCE at plugin construction, before `register()` runs; a supplied service is used as given.
  Omitting the option leaves every call site optional-chained, so behaviour is byte-identical to
  today. No `optionalDependencies` entry, no plugin ordering constraint, and no registry lookup on
  the logging path.
- **Why:** the union is what makes §3.4-style replaceability work without a token — an application
  that wants different behaviour per classification, or a redactor that reaches a service of its
  own, passes its own implementation. Compiling at construction rather than at `register()` matters
  because it is the one moment guaranteed to precede every consumer: the matcher is built once (§14
  hoisting) and no consumer has to ask whether a provider registered first, which is the entire
  ordering hazard the token version had to reason about and which M45b shows is easy to get wrong.
- **Test home:** each consumer's suite passes both arms — a raw `RedactionPolicy` and a hand-written
  `IRedactionService` — and asserts identical output for the policy arm.

### 3.5 Where redaction sits in the logger — inside the concrete loggers, after normalisation

- **Decision:** the resolved `IRedactionService` is a **constructor dependency** of `ConsoleLogger`
  and `PinoLogger`, applied to the merged record immediately after `normalizeMetadata` and
  immediately before the `redact` option's own pass. No decorator is added and `LoggerPlugin`'s
  existing `TraceEnrichedLogger(logger)` composition (`logger-plugin.ts:126-135`) is untouched.
- **Why:** an outermost decorator — the shape this plan carried until review — runs redaction
  **before** normalisation, which `normalize-metadata.ts:11-13` states is load-bearing in the other
  direction: "a redact path such as `error.token` must see the normalized object". Under a decorator
  a policy pattern such as `**.stack` would silently fail to match a raw `Error` (whose `message`
  and `stack` are non-enumerable) while the released `redact: ['error.stack']` matched it — two
  mechanisms disagreeing about the same record, which is §3.6's defect reintroduced one layer up.
  Placing the service at the single existing insertion point makes the two provably agree. The cost
  is that M90i's `trace_id`/`span_id` become visible to the walk, since `TraceEnrichedLogger`
  enriches from outside; that is accepted rather than designed around — the default patterns are
  secret-field names, an application that classifies `trace_id` means it, and the alternative trades
  a documented correctness constraint for a convenience. `child()` needs nothing: `ConsoleLogger`
  and `PinoLogger` build their children through the same constructor, so the service is carried
  automatically, where a decorator would have had to re-wrap it.
- **Test home:** `logger-plugin/test/unit/console-logger-redaction.test.ts` — including a nested
  `Error` case asserting that a policy path and an equivalent `redact` path redact identically,
  which fails under the decorator ordering.

### 3.6 The logger syntax divergence — fixed by routing both through `common`'s one implementation

- **Decision:** `ConsoleLogger`'s `#redactFields`/`#redactPath` are deleted and replaced by a
  `createRedactionService` built from the `redact` paths (classification `secret`, redactor
  `eraseRedactor`). `PinoLogger` continues to forward `redact` to pino **unchanged** and
  additionally applies the same service.
- **Why:** one walk implementation satisfies §11.1 and understands `*`/`**`, so a wildcard pattern
  stops silently doing nothing on the default logger. It must also **carry forward**, not
  re-establish, the caller-mutation property: finding 2 was repaired separately before this
  milestone (it is data corruption, not a redaction-design gap), so the walk replacing
  `#redactFields`/`#redactPath` inherits a pinned regression case and this is a rewrite that must
  not regress rather than a fix to make. Continuing to forward to pino keeps pino's exotic bracket
  syntax working, so nothing released breaks (§9.4). **Precedence is service first, `redact`
  second**, and that ordering is a decision rather than an accident: the two passes are NOT
  idempotent in general — a policy that `mask`s a path and a `redact` entry naming the same path
  disagree, and pino always applies its own `redact` last, so running ours last on the console side
  is what keeps the two loggers agreeing. An explicit `redact` path therefore always ends as
  `'[Redacted]'` and wins over a policy that would merely mask it. The residual — pino-only bracket
  syntax still has no console equivalent — is documented rather than claimed fixed.
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

- **Decision:** port `IRedactionService`, option `redaction`, factory `createRedactionService`.
  `DataClassification` remains the vocabulary **inside** the policy.
- **Why:** what ships is redaction; classification is how it decides. `data-protection` would imply
  key management, which is explicitly a later milestone, and naming a surface for an aspiration is
  how it acquires readers that expect more than it does. The same reasoning retires the token: a
  name in `CAPABILITIES` advertises a resolvable capability, and there would be nothing to resolve.
- **Test home:** `common/test/unit/barrel-exports.test.ts` — the exported names are pinned there and
  in `PUBLIC_API.md`.

### 3.11 What the walk descends into, and what it copies

- **Decision:** `redactRecord` descends into **plain objects and arrays only** — anything else
  (`Date`, `Map`, `Set`, a class instance, a function, a primitive) is a LEAF, matched but never
  entered. It is **clone-on-write**: a subtree containing no match is carried over by reference and
  is identical (`===`) to the input's, while every level on the path to a match is copied. Depth is
  bounded by a constant (`MAX_REDACTION_DEPTH`), below which a deeper subtree is passed through
  untouched.
- **Why:** each clause closes a way the walk could corrupt or hang the logging path, and none was
  specified before review. `normalizeMetadata` replaces only a **TOP-LEVEL** `Error`
  (`normalize-metadata.ts:39-48`, `value instanceof Error` over `Object.keys` — no recursion), so a
  nested `Error`, a `Date` and a cyclic object all reach this walk intact: descending into a `Date`
  and shallow-copying it yields `{}`, silently destroying a value the policy never named, and a
  cyclic object — an ordinary shape for a domain entity with a back-reference — would recurse
  forever and hang every log call rather than failing loudly. Clone-on-write is also what actually
  preserves the caller-mutation property finding 2's fix established, without which this rewrite
  would silently reintroduce it: "clone every level" would be correct and wasteful, while copying
  only matched paths keeps an unmatched record allocation-free, which matters because this runs on
  every log line. The depth bound is preferred to a visited `Set` because it costs nothing per node
  on the overwhelmingly common shallow record, and truncating a pathological object is a better
  failure than allocating a set per log call.
- **Test home:** `common/test/unit/redaction-service.test.ts` — a cyclic record returns rather than
  hanging, a `Date` survives `instanceof Date`, an unmatched subtree is `===` to the input's, and a
  matched sibling does not disturb it.

## 4. Exported surface — every symbol names its consumer

### `@setu-ts/common`

| Exported symbol                 | Kind      | Consumer / real code path that READS it                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRedactionService`             | interface | `ConsoleLogger`/`PinoLogger` (constructor), `AuditService`, `sanitizeUrl`; the union arm of all three `redaction` options.                                                                                                                                                                                                                                                              |
| `createRedactionService`        | function  | All three plugin factories (compiling a supplied `RedactionPolicy`, §3.4); `ConsoleLogger` (for its own `redact` paths, §3.6); an application wanting the same redactor its plugins use; every test that needs a real service.                                                                                                                                                          |
| `Redactor`                      | type      | `RedactionPolicy.redactors` values; the application-supplied extension point (§3.3).                                                                                                                                                                                                                                                                                                    |
| `RedactionContext`              | interface | The second parameter of every `Redactor`. **No built-in redactor reads it** — `erase` ignores its input and `mask` needs only the value — so its consumer is an application-supplied redactor, which is real surface: `defaultRedactor` is ONE function serving every classification and cannot discriminate without it. Pinned by a custom-redactor test asserting both fields arrive. |
| `RedactionPolicy`               | interface | `createRedactionService` parameter; the policy arm of all three `redaction` options.                                                                                                                                                                                                                                                                                                    |
| `DataClassification`            | type      | `RedactionPolicy.fields` values; `RedactionContext.classification`.                                                                                                                                                                                                                                                                                                                     |
| `DATA_CLASSIFICATIONS`          | constant  | Policy authors; `DEFAULT_SECRET_FIELD_PATTERNS` maps to `.SECRET`.                                                                                                                                                                                                                                                                                                                      |
| `DEFAULT_SECRET_FIELD_PATTERNS` | constant  | `LoggerPluginOptions.redact`'s default (C1).                                                                                                                                                                                                                                                                                                                                            |
| `eraseRedactor`                 | constant  | The default redactor inside `createRedactionService`; `ConsoleLogger`'s `redact` compilation.                                                                                                                                                                                                                                                                                           |
| `createMaskRedactor`            | function  | Policy authors; used by the `logger-plugin` README example and the integration test's PAN case.                                                                                                                                                                                                                                                                                         |

`FieldMatcher` and the compiled-policy internals are **not** exported — they have no consumer
outside `createRedactionService`, and exporting them would also leak a private type into
`deno doc --lint` (the M82 precedent for cutting an export at plan time rather than shipping it).

### The three consumers

**No package other than `common` gains an export.** `sanitizeUrl` is internal, no logger type
changes, and the three new options are members on already-exported interfaces rather than new
symbols — so `common` is the only barrel this milestone touches. Each of the three gains a
`barrel-exports.test.ts` assertion pinning that (the M56 defect class: a barrel change that no test
sees).

### 4.1 Options — every option names its consumer

| Option                                   | Consumer                      | Behavior (per implementation)                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LoggerPluginOptions.redaction`          | `ConsoleLogger`, `PinoLogger` | Optional `RedactionPolicy \| IRedactionService`. A policy is compiled once at plugin construction (§3.4); omitted, every call site is optional-chained and output is byte-identical to today.                     |
| `TelemetryPluginOptions.redaction`       | `sanitizeUrl`                 | Same union. Consumed only when `queryParameters: 'redact'`; omitted under that setting, the attribute falls back to `'omit'` with one `register()` warning (§3.7).                                                |
| `AuditPluginOptions.redaction`           | `AuditService`                | Same union. Omitted, `before`/`after`/`metadata` are stored exactly as today (§3.8).                                                                                                                              |
| `RedactionPolicy.fields`                 | the matcher                   | Pattern → classification. An empty record is legal and yields a service that redacts nothing (useful as an explicit "policy decided: none").                                                                      |
| `RedactionPolicy.redactors`              | `createRedactionService`      | Optional. A classification present here uses its redactor; absent falls to `defaultRedactor`.                                                                                                                     |
| `RedactionPolicy.defaultRedactor`        | `createRedactionService`      | Optional, defaults to `eraseRedactor`.                                                                                                                                                                            |
| `MaskOptions.keep`                       | `createMaskRedactor`          | Number of trailing characters preserved; defaults to `4`. A value ≥ the string's length redacts everything (never reveals the whole value). Non-string input is erased.                                           |
| `LoggerPluginOptions.redact` (default)   | `ConsoleLogger`, `PinoLogger` | **Changed**: defaults to `DEFAULT_SECRET_FIELD_PATTERNS` instead of `[]` (C1). `[]` restores previous behaviour.                                                                                                  |
| `TelemetryPluginOptions.queryParameters` | `sanitizeUrl`                 | `'omit'` (default) drops query and fragment from `http.url`; `'redact'` keeps the query with each parameter through the service, falling back to `'omit'` with a warning when no `redaction` option was supplied. |

## 5. Implementation files

| File                                                               | Purpose                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/redaction/classification.ts`                  | `DataClassification`, `DATA_CLASSIFICATIONS`, `DEFAULT_SECRET_FIELD_PATTERNS`.                                                                                            |
| `packages/common/src/redaction/redactors.ts`                       | `Redactor`, `RedactionContext`, `eraseRedactor`, `createMaskRedactor`, `MaskOptions`.                                                                                     |
| `packages/common/src/redaction/policy.ts`                          | `RedactionPolicy`.                                                                                                                                                        |
| `packages/common/src/redaction/field-matcher.ts`                   | Internal compiled pattern matcher (`*` / `**`, case-insensitive segments).                                                                                                |
| `packages/common/src/redaction/redaction-service.ts`               | `IRedactionService`, `createRedactionService`, the record walk.                                                                                                           |
| `packages/common/src/index.ts`                                     | **Modified** — barrel re-exports for the above. `tokens.ts` is NOT touched (§3.10).                                                                                       |
| `packages/logger-plugin/src/loggers/console-logger.ts`             | **Modified** — `#redactFields`/`#redactPath` deleted, routed through `createRedactionService` (§3.6).                                                                     |
| `packages/logger-plugin/src/loggers/pino-logger.ts`                | **Modified** — applies the same service; still forwards `redact` to pino.                                                                                                 |
| `packages/logger-plugin/src/plugin/logger-plugin.ts`               | **Modified** — `LoggerPluginOptions.redaction`, the secret default (C1), compile-at-construction.                                                                         |
| `packages/telemetry-plugin/src/attributes/sanitize-url.ts`         | New pure URL builder (§3.7).                                                                                                                                              |
| `packages/telemetry-plugin/src/middleware/telemetry-middleware.ts` | **Modified** — `http.url` via `sanitizeUrl`.                                                                                                                              |
| `packages/telemetry-plugin/src/plugin/telemetry-plugin.ts`         | **Modified** — compile-at-construction, the fallback warning.                                                                                                             |
| `packages/telemetry-plugin/src/interfaces/index.ts`                | **Modified** — `TelemetryPluginOptions.queryParameters` + `.redaction`. Type-only, so no named test file (checked): covered at compile time by `span-attributes.test.ts`. |
| `packages/audit-plugin/src/interfaces/index.ts`                    | **Modified** — `AuditPluginOptions.redaction`. Type-only, as above.                                                                                                       |
| `packages/audit-plugin/src/services/audit-service.ts`              | **Modified** — redact before freeze (§3.8).                                                                                                                               |
| `packages/audit-plugin/src/plugin/audit-plugin.ts`                 | **Modified** — compile-at-construction, service threaded into `AuditService`.                                                                                             |

No manifest, workspace or release-list change: the publishable set stays at **48** (§3.1).

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                   | src covered                                                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/field-matcher.test.ts`                    | `redaction/field-matcher.ts`                                       | Literal dot-path; `*` matches exactly one segment including an array index; `**` matches zero or more; case-insensitive segments; a non-matching path returns `undefined`; a pattern longer than the path does not match.                                                                                                                                                                                                                                               |
| `common/test/unit/redactors.test.ts`                        | `redaction/redactors.ts`                                           | `eraseRedactor` → `'[Redacted]'` for every input type; `createMaskRedactor({ keep: 4 })` preserves exactly four trailing characters; `keep` ≥ length redacts wholly; non-string input erased; a custom redactor receives both `context.path` and `context.classification` (§4's only reader). Calls type-check against `Redactor`.                                                                                                                                      |
| `common/test/unit/redaction-service.test.ts`                | `redaction/redaction-service.ts`, `policy.ts`, `classification.ts` | `redactRecord` returns a copy and **does not mutate the input at any depth** (the §3.6 defect, asserted at the source); nested objects and arrays; absent fields stay absent; `redactValue` returns the input unchanged when unclassified; `defaultRedactor` fallback. §3.11 walk semantics: a cyclic record returns rather than hanging, a `Date` survives `instanceof Date`, an unmatched subtree is `===` to the input's, and a matched sibling does not disturb it. |
| `common/test/unit/barrel-exports.test.ts`                   | `index.ts`                                                         | **Extended** — the ten new symbols are exported and `FieldMatcher` is not; `CAPABILITIES` gains NO member (§3.10), asserted so a later "while we're here" addition fails.                                                                                                                                                                                                                                                                                               |
| `logger-plugin/test/unit/console-logger-redaction.test.ts`  | `loggers/console-logger.ts`                                        | Regression: the caller's nested object is **byte-identical after logging** (fails without §3.6); a path through an array redacts; a `*` wildcard redacts; a NESTED `Error` is matched identically by a policy path and by `redact` (fails under the §3.5 decorator ordering); a path named by both is erased, not masked (§3.6 precedence); `child()` carries the service; `undefined` metadata passes through.                                                         |
| `logger-plugin/test/integration/redaction-absent.test.ts`   | `plugin/logger-plugin.ts`                                          | With no `redaction` option, output is identical to the pre-milestone baseline except the C1 default; `redact: []` reproduces the pre-milestone baseline exactly.                                                                                                                                                                                                                                                                                                        |
| `logger-plugin/test/integration/secret-default.test.ts`     | `plugin/logger-plugin.ts`                                          | A field named `password`/`apiKey`/`Authorization` is redacted with no configuration (C1), driving the **real** `ConsoleLogger` and the real plugin; the three doc wordings are pinned against the shipped default list.                                                                                                                                                                                                                                                 |
| `logger-plugin/test/unit/pino-logger-redaction.test.ts`     | `loggers/pino-logger.ts`                                           | The service is applied **and** `redact` still reaches pino's options (guarded real-import test for the pino path, per §12.2).                                                                                                                                                                                                                                                                                                                                           |
| `telemetry-plugin/test/unit/sanitize-url.test.ts`           | `attributes/sanitize-url.ts`                                       | `'omit'` drops query and fragment and keeps origin+path; `'redact'` with a service masks a classified parameter and keeps an unclassified one; `'redact'` with no service behaves as `'omit'`; a malformed URL degrades without throwing.                                                                                                                                                                                                                               |
| `telemetry-plugin/test/integration/span-attributes.test.ts` | `middleware/telemetry-middleware.ts`, `plugin/telemetry-plugin.ts` | Real kernel app + real in-memory span exporter: a request carrying `?email=…` produces a finished span whose `http.url` contains neither the parameter name nor its value; the `'redact'` warning fires exactly once.                                                                                                                                                                                                                                                   |
| `audit-plugin/test/unit/audit-service-redaction.test.ts`    | `services/audit-service.ts`                                        | `before`/`after`/`metadata` are each redacted; redaction precedes the freeze (the stored record is frozen **and** redacted); an absent field stays absent; with no service the stored record is byte-identical to today.                                                                                                                                                                                                                                                |
| `audit-plugin/test/integration/audit-redaction.test.ts`     | `plugin/audit-plugin.ts`                                           | Real app with `AuditPlugin({ redaction })`: an entry written through the resolved `IAuditLogger` reads back redacted from `MemoryAuditStorage`; BOTH option arms (a policy and a hand-written service) drive the same result (§3.4).                                                                                                                                                                                                                                    |
| `test/unit/egress-consumers.test.ts` (root)                 | (recurrence gate)                                                  | A hand-maintained list of the packages that export application data, each asserted at COMPILE time to accept `redaction` on its options type — so wiring a fourth exporter is a deliberate edit to this list. Weaker than reading `optionalDependencies` off a token, and §9 records that as the stated cost of §3.1.                                                                                                                                                   |
| `test/unit/compliance-vocabulary.test.ts` (root)            | (recurrence gate)                                                  | `grep`-equivalent over `packages/*/src`: no shipped identifier, option or doc line names PII, PHI, PCI, HIPAA, GDPR or DSS — the §0 scope boundary made mechanical.                                                                                                                                                                                                                                                                                                     |

Coverage note: `field-matcher.ts` and `redaction-service.ts` carry the branch-heavy logic and are
planned to 100%; every other new file is small enough that the named tests clear 90% on all three
axes. No new package means no new external dependency, so §12.2's guarded real-import requirement
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
deno task publish:check     # `common`'s barrel changes — run on a COMMITTED tree
deno task release:verify 0.6.0   # must still report 48 publishable packages, UNCHANGED
deno task check:docs        # PUBLIC_API section, README fences, package catalogue,
                            # and the JSDoc ratchet — must stay at DOC_LINT_BASELINE (496)
```

No package publishes for the first time, so `docs/releasing.md`'s `release:create-packages` +
`release:link-repos` step does NOT apply — that is the M92 `view-plugin` overhead §3.1 declines to
take on. `release:verify` reporting anything other than 48 means a package crept in.

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
- **Two redaction passes run at one insertion point.** `redact` and the service both apply inside
  the concrete logger. → §3.6 fixes the precedence (service, then `redact`) so console and pino
  agree, one README subsection states which is which, and a test pins the composed result for a path
  both name.
- **The 10 new `common` exports can move the JSDoc ratchet.** M90a had to CUT two exports because
  they leaked a private type and pushed the baseline 497 → 502. → `check:docs` is in §7 and the
  baseline stays at 496; an export that cannot clear it is cut, not accommodated (the M82/M90a
  precedent), and `createRedactionService` carries an explicit `IRedactionService` return type
  because an inferred one is a JSR slow type that `publish:check` refuses (the M51 defect).
- **The recurrence gate is weaker than the token version.** With no `optionalDependencies` to read,
  nothing mechanically detects a FOURTH exporter added without redaction — the gate asserts a
  hand-maintained list rather than deriving one. → Accepted as the stated cost of §3.1 and named
  here rather than left implicit; the list lives beside the `apps-gate.test.ts` precedent, and if a
  fourth and fifth consumer ever arrive, that is the signal to add the token (which is additive and
  breaks nothing, §9).

## 9. Out of scope

- **Field-level encryption and erasure fan-out** — the storage half. `cache-middleware.ts:136-137`,
  `redis-queue.ts:192`, messaging envelopes and `FileAuditStorage` each persist a plaintext copy;
  redaction does not touch them and must not be documented as if it did. Unowned; named in ROADMAP
  §96.
- **Key management** — promoting `session-plugin/src/codec/crypto.ts`'s `KeyRing`/`deriveKeyRing`/
  `seal`/`open` into a general capability. Its own milestone, and the prerequisite for a
  cryptographic redactor (§3.3).
- **A build-time classification report** — not reproducible against a runtime policy (§3.9).
- **A `CAPABILITIES.REDACTION` token and the plugin that would provide it** — declined in §3.1, not
  deferred out of doubt. Adding them later is purely ADDITIVE: a package can register the service
  under a new token without changing one option signature, so nothing here forecloses it. The
  trigger to revisit is a consumer that must RESOLVE rather than be handed the service — application
  code reaching the framework's redactor, or a fourth or fifth first-party exporter.
- **`audit-plugin.ts:130`'s `'logger'` string literal** (§11.2 wants `CAPABILITIES.LOGGER`) — C3 was
  in scope only while that array was to gain a redaction token. It no longer is, so fixing it here
  would be an unrelated edit to a file this milestone otherwise touches elsewhere. Real, small, and
  belongs to a `fix/…` branch.
- **`http.route` and the span name carrying a concrete path.** Both leak an identifier the same way
  `http.url` did, and neither is fixable here: the matched route template is not available to the
  middleware (M70l). A kernel change owns it.
- **OpenTelemetry semantic-convention renames** (`http.url` → `url.full`, `http.method` →
  `http.request.method`) — a second breaking change that would invalidate existing dashboards, and
  unrelated to the leak.
- **Redacting spans an application creates itself.** Only framework-set attributes are covered;
  wrapping every `span.setAttribute` means wrapping the span object, which changes a surface M24
  committed.
- **Any `logger-plugin` public-surface change** — the service is a constructor dependency of the
  existing loggers, so `src/index.ts` is unchanged and no new symbol is documented (§4).
