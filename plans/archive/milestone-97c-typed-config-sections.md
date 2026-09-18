# Milestone 97c — Typed Configuration Sections (`@setu-ts/config-plugin`)

> **Status:** Complete ([PR #330](https://github.com/setu-ts/setu-ts/pull/330)). Archived on
> completion. Branch: `feat/m97c-typed-config-sections`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Make a configuration read return a value whose type was checked, rather than a value whose type the
caller asserted. `IConfig.get<T>(key)` is flat over a `Record<string, unknown>` and its
implementation ends in `return value as T`, so `config.get<number>('PORT')` compiles, returns
whatever is in the store, and is typed `number` regardless. There is no way to name a group of
related settings and no way for a consumer to receive one.

**The validation seam is already built and the parsed type is discarded one line from where it
exists.** `ConfigPluginOptions.validationSchema` takes a Zod-compatible `StructuralSchema<T>` whose
`parse` runs at startup, so a schema declaring `z.coerce.number()` means the stored value really is
a number — and then `validateConfig` ends with `return parsed as Record<string, unknown>`. That
erasure is the whole gap. This is the one of M97's three letters where the ergonomic is also a
safety improvement, and it is the ASP.NET `IOptions<T>` row.

- **In scope:** `defineConfigSection` and a section accessor; startup validation of every declared
  section; a disclosure-safe failure message; `ConfigPluginOptions.sections`; README,
  `PUBLIC_API.md` and `docs/getting-started.md` updates.
- **NOT this milestone:** Any change to `get`, `getOrThrow` or `has`. Reloading or change
  notification — ASP.NET's `IOptionsMonitor` needs a file watcher or a poll and this framework loads
  configuration once at startup by design. Per-section default merging beyond what the schema
  expresses. Decorators for non-HTTP ingress — M97a. Response shaping — M97b.

## 1. Contracts verified from SOURCE (not names)

| Reference                                                      | Source (file:line)                                                                                                  | Verified surface / fact                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IConfig` is flat and its `T` is unchecked                     | `packages/common/src/services/config.ts:20-54`                                                                      | Exactly four members: `get<T>(key)`, `get<T>(key, { default })`, `getOrThrow<T>(key)`, `has(key)`. No section concept.                                                                                                                                                   |
| The cast is explicit in the implementation                     | `packages/config-plugin/src/services/config-service.ts:20,29-31,48-56`                                              | `ConfigService implements IConfig`, constructor shallow-copies into `private readonly data: Readonly<Record<string, unknown>>`, and `get` ends `return value as T`.                                                                                                      |
| The schema seam exists and already coerces                     | `packages/config-plugin/src/options.ts:56`; `packages/config-plugin/src/validators/config-validator.ts:19-28,41-76` | `validationSchema?: StructuralSchema<unknown>`; `StructuralSchema<T>` is `{ parse(input: unknown): T }`; `validateConfig(raw, schema)` calls `schema.parse(raw)` and returns the parsed object. Coerced values survive into the store.                                   |
| …and then discards the type                                    | `packages/config-plugin/src/validators/config-validator.ts:75`                                                      | `return parsed as Record<string, unknown>` — the last line of the function.                                                                                                                                                                                              |
| The failure message deliberately discloses nothing             | `packages/config-plugin/src/validators/config-validator.ts:47-53`                                                   | The `catch` throws `new Error('Configuration validation failed.')` with a comment: "Schema errors may include configuration values (for example invalid enum input). Never propagate their message or cause across this boundary." The section path must hold this line. |
| Non-object schema output is already refused by shape           | `packages/config-plugin/src/validators/config-validator.ts:56-73`                                                   | Null/undefined, array and non-object outputs each throw with their own message, the array one naming `z.object({ ... })`.                                                                                                                                                |
| `loadConfig` is the shared entry point                         | `packages/config-plugin/src/services/load-config.ts:54-63`                                                          | `loadConfig(runtime, options?): Promise<IConfig>`; an injected `options.instance` is returned verbatim, so "the values the composition branched on are the values handlers read" (the M36c property). Sections must be validated on BOTH paths.                          |
| `ConfigPluginOptions` today                                    | `packages/config-plugin/src/options.ts:20-64`                                                                       | `envFilePath`, `envFileOptional`, `validationSchema`, `expandVariables`, plus `instance` (read by `loadConfig` above).                                                                                                                                                   |
| The barrel is small                                            | `packages/config-plugin/src/index.ts`                                                                               | Exports `ConfigPlugin`, `ConfigPluginOptions`, `loadConfig`, and the `StructuralSchema` type. Any addition is visible in `PUBLIC_API.md`'s config section.                                                                                                               |
| A required `IConfig` member would be breaking for implementors | `packages/common/src/services/config.ts:20` + M74's precedent in `CLAUDE.md`                                        | M74 added required `peek` to two realtime contracts and recorded it as breaking-for-implementors with the framework's own service the only one in-repo. The same reasoning and the same blast-radius check apply here.                                                   |
| Real consumers of `IConfig` to name in §4                      | `packages/starters/*/src`, CLI templates                                                                            | The generated `full-stack` template emits `config.getOrThrow('SESSION_SECRET')` and the starters read connection URLs, which is the shape a section replaces. Verified during implementation by grep before the section's examples are written.                          |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                  | Resolution (picked side)                                                                                                                                                            | Doc deliverable (same PR)                                                                                                                             |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `docs/migration-nestjs.md:462-505` maps Nest's `ConfigModule` onto `ConfigPlugin` with a flat `config.get('KEY')`. Nest's actual idiom is `registerAs('database', () => ({ … }))` plus a namespaced `ConfigService` read, which is the section shape this milestone adds. | The mapping is corrected to show the section form as the closer equivalent, with the flat read kept for single values.                                                              | Update the existing Configuration fence in `docs/migration-nestjs.md`; its fence count is unchanged and the expected-count comment records that fact. |
| C2 | `PUBLIC_API.md`'s config section documents `IConfig`'s four members and `validationSchema` as whole-store validation. A section accessor changes what "validated" means for a reader.                                                                                     | `validationSchema` keeps its exact current meaning — whole-store validation — and sections compose with it rather than replacing it; the doc states both and says which runs first. | `PUBLIC_API.md` config rows for the new symbols and a sentence on ordering.                                                                           |
| C3 | No committed doc claims typed sections exist, so there is no third conflict. Checked: `README.md`, `ARCHITECTURE.md` §config, `packages/config-plugin/README.md`, `docs/getting-started.md`.                                                                              | Nothing to resolve.                                                                                                                                                                 | None.                                                                                                                                                 |

## 3. Design decisions

### 3.1 A free function, not a new `IConfig` member

- **Decision:** `getConfigSection(config, definition)` is a free function exported by
  `config-plugin`, taking the resolved `IConfig` and a definition produced by `defineConfigSection`.
  `IConfig` in `common` is **unchanged**, so there is no `common` edit and no breaking change for
  any implementor.
- **Why:** §1 establishes that adding a required member follows M74 and is breaking for
  implementors, and the cost buys nothing here. A free function also keeps `common` free of the
  section concept, which matters because `common` must not acquire a validator dependency (the
  reason `StructuralSchema` lives in `config-plugin` at all).
- **Where the parsed value lives — added in review, because an earlier draft left this undefined.**
  That draft said the value is "cached on the plugin side" AND that the accessor "reads through the
  public `get`", which are two different mechanisms with neither chosen — the M10 shape, where an
  unspecified core seam gets improvised at implementation time. The decision is a **module-level**
  **`WeakMap<IConfig, Map<ConfigSection, unknown>>`** owned by `sections/config-section.ts`: startup
  validation writes each section's parsed value into it keyed by the `IConfig` instance, and
  `getConfigSection` reads it. Not a reserved store key, which would pollute a namespace the
  application also writes and would be reachable through `get`; not a parse per call, which
  contradicts §3.3. A `WeakMap` module registry is established practice here — M69 added exactly one
  in `drizzle-database.ts` to map a witness back to its database. A section read for an `IConfig`
  the plugin never validated throws naming the prefix, because that means the section was never
  declared in `ConfigPluginOptions.sections`.
- **Test home:** `test/unit/config-section.test.ts` plus a compile-time assertion that `IConfig`
  still declares exactly its four members.

### 3.2 `defineConfigSection` produces a definition carrying the prefix, keys, and schema

- **Decision:** `defineConfigSection<T>({ prefix, keys, schema })` returns an opaque
  `ConfigSection<T>` carrying all three. `keys` names the prefix-stripped keys that belong to the
  section (`prefix: 'DATABASE_', keys: ['URL', 'POOL_SIZE']` selects `DATABASE_URL` and
  `DATABASE_POOL_SIZE`), and `schema` parses that selected subset — the schema declares
  `{ URL: …, POOL_SIZE: … }`, not `{ DATABASE_URL: … }`.
- **Why:** `IConfig` has named reads but no enumeration method. A prefix alone can select keys from
  the record available while loading a normal snapshot, but cannot select from an arbitrary injected
  `IConfig`, which §3.4 must validate too. Explicit stripped keys preserve the free-function,
  no-`common` design and make both paths honest. **Stripping** decides what every user's schema
  literally looks like; repeating the prefix inside the schema would state it twice with nothing
  checking the two agree. The cost is that a section's schema is not reusable as a whole-store
  `validationSchema`, and that its key list accompanies the schema; the README states both rather
  than leaving this distinction to discovery.
- **Test home:** `test/unit/config-section.test.ts` — the selected keys are read with the prefix
  stripped, and an undeclared key never reaches the schema.

### 3.3 Sections validate at startup, not at first read

- **Decision:** `ConfigPluginOptions.sections?: readonly ConfigSection<unknown>[]`. Every declared
  section is parsed during `loadConfig`, and its parsed value is cached. A missing or unparseable
  section fails `ConfigPlugin.register()` naming the section's prefix.
- **Why:** This is the property that makes the typed read honest. A read-time parse means a
  configuration error surfaces on the first request that happens to touch that section, which is the
  fail-open shape M90a closed twice (`maxBodyBytes: NaN`, `maxNodes: NaN`). Caching at startup is
  also what lets §3.1's accessor be a plain lookup rather than a parse per call.
- **Test home:** `test/unit/config-section-startup.test.ts` asserts `register()` throws for a bad
  section and that a good one is parsed exactly once across repeated accessor calls.

### 3.4 Both `loadConfig` paths validate sections, including the injected-instance path

- **Decision:** `loadConfig` validates declared sections after resolving the store, and the
  `options.instance` early return (§1) validates them against the injected instance too.
- **Why:** §1 records that M36c's whole point was that the values the composition branched on are
  the values handlers read. Skipping section validation on the injected path would mean a
  `createFullStackAppFromConfig` application gets no section checking at all — the path most likely
  to be used with sections, and the one least likely to be noticed.
- **Test home:** `test/unit/config-section-startup.test.ts` covers both paths; a negative control
  confirms an invalid section on the injected path fails.

### 3.5 The section failure message names the prefix and discloses no value

- **Decision:** A section parse failure throws `Configuration section "<prefix>" validation failed.`
  with no cause attached.
- **Why:** §1 quotes `config-validator.ts`'s own comment: a schema error may include a configuration
  value, for example an invalid enum input. The section path crosses the same boundary, so it holds
  the same line. Naming the prefix is safe because a prefix is a declared identifier rather than a
  value.
- **Test home:** `test/unit/config-section-startup.test.ts` asserts a bad enum value does not appear
  in the thrown message and that `cause` is absent.

### 3.6 `validationSchema` runs first, then sections

- **Decision:** Whole-store `validationSchema` (when supplied) parses first and its output becomes
  the store; sections then read their declared prefix-plus-key entries out of that store.
- **Why:** The ordering has to be one way or the other and only this one composes: a section reading
  a coerced value requires the whole-store coercion to have already happened. The reverse would make
  a section see raw strings while `get` saw coerced values, which is two answers for one key.
- **Test home:** `test/unit/config-section-ordering.test.ts` — a section whose schema expects a
  number over a store whose `validationSchema` coerced it.

## 4. Exported surface — every symbol names its consumer

| Exported symbol       | Kind | Consumer / real code path that READS it                                                                                                                                                                                                                                             |
| --------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineConfigSection` | fn   | Application code declaring a section; `ConfigPluginOptions.sections` receives its result; the README and `docs/migration-nestjs.md` fences.                                                                                                                                         |
| `getConfigSection`    | fn   | Application code reading a section from the resolved `IConfig`; §6's integration test drives it through a real kernel application.                                                                                                                                                  |
| `ConfigSection<T>`    | type | The return type of `defineConfigSection` and the element type of `ConfigPluginOptions.sections` — both public, so the type must be nameable (the M52c lesson: the barrel exported `DataSource` whose parameter type it did not export, making the type unnameable by any consumer). |

### 4.1 Options — every option names its consumer

| Option                                                             | Consumer                                                     | Behavior (per implementation)                                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigPluginOptions.sections?: readonly ConfigSection<unknown>[]` | `loadConfig` (both paths, §3.4) and `ConfigPlugin.register`. | Each entry is parsed at startup and cached. Absent means no sections, and the plugin behaves byte-identically to today — asserted, not assumed (§6). |
| `defineConfigSection({ prefix, keys })`                            | `loadConfig`'s selection step.                               | Reads `prefix + key` for every stripped key. Missing keys are omitted, so the schema remains the authority on whether they are optional.             |
| `defineConfigSection({ schema })`                                  | `loadConfig`'s parse step.                                   | A `StructuralSchema<T>`, the same Zod-compatible shape `validationSchema` already takes (§1).                                                        |

## 5. Implementation files

| File                                | Purpose                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/index.ts`                      | Barrel: the three symbols in §4.                                                                       |
| `src/sections/config-section.ts`    | `defineConfigSection`, `ConfigSection<T>`, declared-key selection, and `getConfigSection` (§3.1–§3.2). |
| `src/sections/validate-sections.ts` | Startup parse + cache + the disclosure-safe throw (§3.3, §3.5).                                        |
| `src/services/load-config.ts`       | Calls the section validation on both paths (§3.4) and orders it after `validationSchema` (§3.6).       |
| `src/options.ts`                    | The `sections` option.                                                                                 |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                     | src covered                                                | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/config-section.test.ts`            | `sections/config-section.ts`                               | Declared keys are read with the prefix stripped; `getConfigSection` returns the parsed value typed as the schema's output; an undeclared key never reaches the schema. Calls type-check against `StructuralSchema<T>` from §1 — a test passing a bare object literal as a schema is a plan defect.        |
| `test/unit/config-section-cache.test.ts`      | `sections/config-section.ts`                               | §3.1a: the `WeakMap` is keyed by the `IConfig` instance, so two applications in one process do not share a section value; reading a section for an `IConfig` the plugin never validated throws naming the prefix.                                                                                         |
| `test/unit/config-section-startup.test.ts`    | `sections/validate-sections.ts`, `services/load-config.ts` | §3.3: `register()` throws for an unparseable section. §3.4: both `loadConfig` paths validate, including `options.instance`. §3.5: the message names the prefix, contains no configuration value, and carries no `cause`. Parsed exactly once across repeated accessor calls.                              |
| `test/unit/config-section-ordering.test.ts`   | `services/load-config.ts`                                  | §3.6: a section schema expecting a number succeeds over a store whose `validationSchema` coerced it, and the reverse ordering is shown to fail — so the decision is proven rather than asserted.                                                                                                          |
| `test/unit/barrel-exports.test.ts` (extended) | `src/index.ts`                                             | The barrel gains exactly the three symbols; `ConfigSection<T>` is nameable by a consumer (§4). A compile-time assertion pins that `IConfig` still declares four members (§3.1).                                                                                                                           |
| `test/integration/config-section-app.test.ts` | all of the above                                           | A real kernel application registers `ConfigPlugin({ sections })`, a handler resolves `CAPABILITIES.CONFIG` and reads the section through `getConfigSection`, and the response carries the coerced typed values. Also asserts that an application declaring NO sections produces the same store as before. |

Per-file 90% branch/function/line on every changed `src` file.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m97c-typed-config-sections, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs        # fence counts for docs/migration-nestjs.md
deno task publish:check     # committed tree — config-plugin's barrel changes
deno task release:verify 0.6.0
```

## 8. Risks & mitigations

- **A section schema's error message leaks a configuration value.** The single worst outcome here,
  and the reason `validateConfig` already refuses to propagate one. Mitigation: §3.5 plus a test
  asserting a bad enum value is absent from the message and `cause` is unset.
- **`NaN` or an out-of-domain value passes a section as "configured".** `Number(env.X)` yields `NaN`
  for an unset variable, and M90a found this fail-open twice in one milestone. Mitigation: the
  section schema is the authority and the README example uses a Zod schema that refuses `NaN`; the
  plan does not add a second validation layer that could disagree with it.
- **The injected-instance path is forgotten.** It is an early `return` before any parsing (§1), so
  it is the natural thing to miss. Mitigation: §3.4 makes it a decision with its own test row and a
  negative control.
- **A test double that is not a real schema.** A fake `{ parse: (v) => v }` would make every section
  test pass while proving nothing about coercion. Mitigation: §6 requires the real Zod-compatible
  shape and the ordering test uses a coercing schema, so a pass-through double fails it.
- **The accessor is typed but unchecked.** If `getConfigSection` ended in a cast it would reproduce
  exactly the defect this milestone closes. Mitigation: the cached value IS the schema's `parse`
  output, so the type comes from the parse rather than from an assertion; a review-visible comment
  at the return site records that, and the ordering test would fail if the cache held raw values.

## 9. Out of scope

- **Reloading and change notification.** ASP.NET's `IOptionsMonitor` needs a file watcher or a poll,
  and this framework loads configuration once at startup by design. A later milestone owns it if a
  consumer ever needs it.
- **Nested configuration objects.** The store is flat environment keys (§3.2); nesting would mean a
  second source format, which is a loader concern.
- **Changing `get`/`getOrThrow`/`has`.** Their unchecked `T` stays, deliberately: narrowing it is a
  breaking change to the most-used API in the framework and the section accessor is the safe route.
- **A required `IConfig.getSection` member** — §3.1, declined with reason rather than deferred.
- **Wiring sections into the CLI templates or the starters.** Those emit flat reads today and
  changing them is a behaviour change to generated output; recorded here so it is a later decision
  rather than an omission.
- **Decorators for non-HTTP ingress** — M97a. **Response shaping** — M97b.
