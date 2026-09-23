# Milestone 98e — Value-Free Configuration Provenance

> **Status:** Planning on `docs/m98-capability-diagnostics`. Implementation and fixes belong on
> `feat/m98e-configuration-provenance`; `main` remains protected.

## 0. Objective & scope

Record value-free provenance while configuration is already being loaded, then expose only
explicitly approved key and source aliases through the authenticated diagnostics client. The
implementation must work for standalone `loadConfig` followed by `ConfigPlugin({ instance })`
without loading or validating twice.

- **In scope:** approved source/precedence/expansion/schema-step metadata, opaque injected-instance
  behavior, a typed source/token, `/v1/config`, native `configuration()`, docs, tests, and both
  security gates.
- **NOT this milestone:** configuration values or fingerprints, key enumeration, schema dependency
  graphs, secret editing, reload, call-site default tracking, or support for arbitrary custom loader
  internals.

Implementation starts from main containing M98d's fixed inspector-support manifest; HealthPlugin
itself remains optional and is not required for configuration provenance.

## 1. Contracts verified from SOURCE (not names)

| Reference                      | Source (file:line)                                             | Verified surface / fact                                                                       |
| ------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `IConfig`                      | `packages/common/src/services/config.ts:20`                    | Only named `get`, `getOrThrow`, and `has`; no enumeration or provenance.                      |
| `ConfigPluginOptions.instance` | `packages/config-plugin/src/options.ts:79`                     | Injected instance bypasses env/files/schema/expansion; sections still read it.                |
| `loadConfig`                   | `packages/config-plugin/src/services/load-config.ts:55`        | One path merges, expands, schema-parses, constructs `ConfigService`, then validates sections. |
| `loadEnv`                      | `packages/config-plugin/src/services/env-loader.ts:30`         | Files merge lowest-to-highest while runtime env overrides all files.                          |
| `expandVariables`              | `packages/config-plugin/src/services/variable-expander.ts:14`  | Resolves `${NAME}` after merge and detects missing/cyclic references.                         |
| `validateConfig`               | `packages/config-plugin/src/validators/config-validator.ts:41` | Calls schema once, preserves coercions/defaults, and emits value-free validation errors.      |
| `ConfigPlugin`                 | `packages/config-plugin/src/plugin/config-plugin.ts:51`        | Delegates to `loadConfig`; no second loading path exists today.                               |
| `IServiceRegistry`             | `packages/common/src/registry.ts:86`                           | Eager registration can publish a source without lazy reads; registry seals after bootstrap.   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                             | Resolution (picked side)                                              | Doc deliverable (same PR)                                                                                                                  |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | Current docs say values originate from env/files but expose no provenance; ROADMAP M98e requires explicit unknown origins for injected/opaque paths. | Preserve `IConfig` exactly and add a separate diagnostics projection. | Update `PUBLIC_API.md`, `ARCHITECTURE.md`, `docs/diagnostics-protocol.md`, package READMEs, `CHANGELOG.md`, `ROADMAP.md`, and `CLAUDE.md`. |

## 3. Design decisions

### 3.1 Record at resolution, never reconstruct

- **Decision:** Introduce internal `loadEnvWithProvenance`; `loadEnv` delegates to it and discards
  metadata. `loadConfig` calls it once, expansion once, schema parse once, and section validation
  once. A metadata builder observes only approved keys as each existing merge step wins. It records
  source category/alias and overridden source aliases, expansion references whose two endpoints are
  approved, and schema effects derived from approved input/output property presence. It never
  compares, hashes, serializes, measures, or retains values.
- **Why:** Final values cannot reliably reconstruct precedence or defaults, and a second pass can
  change behavior.
- **Test home:** env-loader/load-config provenance tests with call counters and precedence fixtures.

### 3.2 Pre-application lifetime

- **Decision:** `loadConfig(..., { diagnostics })` stores the frozen provenance projection in a
  module-private `WeakMap<IConfig, ConfigProvenanceRecord>`.
  `ConfigPlugin({ instance, diagnostics })` adopts that record when the exact instance was produced
  by this loader, and an adopted entry keeps the real origin the loader observed — `environment` or
  `file` — because injection is how the snapshot reached the application, not where its values came
  from. The WeakMap is non-enumerable and lifetime follows the config object. An arbitrary injected
  instance is the only other case and yields approved aliases with origin and schema effect
  `unknown`; it exposes no presence flag. Provenance collection never adds a `get`, `has`,
  enumeration, getter, or schema call. Existing configured section validation remains authoritative
  and still calls `IConfig.get` once per declared section key exactly as it does without
  diagnostics; tests compare enabled and disabled call counts rather than claiming an opaque
  instance is never read by startup.
- **Why:** Pre-composition and plugin loading remain one snapshot while opaque instances stay
  honest.
- **Test home:** load-then-inject integration tests and malicious custom `IConfig` tests.

### 3.3 Approval model and DTO

- **Decision:** `ConfigDiagnosticsOptions` requires `enabled: true`, `keys` mapping exact config
  keys to unique display aliases, and optional `files` mapping exact configured paths to unique
  source aliases. Limits: 128 keys, eight files, 64 UTF-8 bytes per alias, no controls.
  `ConfigProvenanceEntry` contains only `keyAlias`, `origin` (`environment`, `file`, `unknown`),
  optional `sourceAlias`, approved `overriddenSourceAliases`, `expanded`, approved
  `referenceAliases`, and schema effect (`not-configured`, `validated`, `introduced`, `removed`,
  `unknown`). Every origin value names its producer, and there are exactly two producers of
  `unknown`: an opaque injected instance (§3.2, where the schema effect is `unknown` too), and a key
  the loader itself tracked that is present in the post-schema snapshot with no observed environment
  or file source, whose schema effect `introduced` then reports that it appeared only after schema
  parsing.

  The effect is `introduced` rather than `defaulted`, and the difference is the whole point of §3.1
  and the §8 overclaim risk: effects are derived from approved input/output property PRESENCE, and
  presence cannot distinguish a schema default from a transform that derived the key from other
  inputs. `defaulted` names a mechanism the observation cannot establish, so it would misstate the
  source for every transform-derived key; and it could only ever be established by inspecting schema
  internals, which §0 excludes. `introduced` states exactly what was observed and nothing more.

  A separate `injected` origin was considered and CUT at plan time: `loadConfig` reads only the
  environment and `.env` files (`packages/config-plugin/src/services/load-config.ts:55`), an adopted
  record keeps each entry's real `environment`/`file` origin, and an opaque instance is already
  `unknown` — so no code path could ever emit it, which is the dead-surface case the plan checklist
  requires cutting rather than storing. `ConfigDiagnosticsSnapshot` adds version, instance,
  inspector state, entries, truncation and fixed counters. It contains no presence flag for opaque
  instances.
- **Why:** Even names and override relationships require deliberate approval; fixed categories avoid
  raw detail.
- **Test home:** option compiler and exact DTO tests.

### 3.4 Typed source and fixed connector operation

- **Decision:** Add eager `CAPABILITIES.CONFIG_DIAGNOSTICS` (`config-diagnostics`) and
  `IConfigDiagnosticsSource`. ConfigPlugin always registers one: absent diagnostics reports
  `disabled`; enabled with no approved resolved entries reports `no-data`; opaque instances return
  entries marked `unknown`. DiagnosticsPlugin optionally consumes it and serves only
  `GET /v1/config`; absence returns typed `unsupported`. It sets the fixed authenticated status
  manifest's `configuration` key true. `IDiagnosticsClient.configuration()` first checks that key; a
  false key returns a frozen typed `unsupported` snapshot without requesting the route.
- **Why:** Support and disabled state are explicit without widening `IConfig` into an inspector.
- **Test home:** plugin, protocol, connector, client, and socket e2e tests.

### 3.5 Schema and expansion semantics

- **Decision:** Expansion metadata is evidenced only by the existing `${NAME}` grammar on an
  approved key's already-loaded string and includes references only when their aliases are approved.
  For schema output, input present/output present is `validated` regardless of coercion; input
  absent/output present is `introduced`; input present/output absent is `removed`. `introduced`
  reports appearance and NOT cause: a schema default and a transform deriving the key from other
  inputs produce the identical presence pattern, so naming one mechanism would be the §8 overclaim.
  A consumer reading `introduced` knows the key was not in any observed source and must not conclude
  a default supplied it. Arbitrary transform dependencies and output keys not explicitly approved
  are not inferred. A `get(key, { default })` fallback never changes startup provenance.
- **Why:** These facts can be observed without disclosing values or inventing schema semantics.
- **Test home:** expansion/schema fixtures covering defaults, coercion, removal, transforms, and
  call defaults — including an exact-output case where a schema DEFAULT and a schema TRANSFORM
  deriving a key from other inputs both report `introduced`, which is what pins the effect to
  presence rather than to a mechanism.

### 3.6 Projection and failure isolation

- **Decision:** `IConfigDiagnosticsSource.snapshot(instanceId: string): ConfigDiagnosticsSnapshot`
  is synchronous, requires a non-empty instance ID, throws one fixed value-free `RangeError` for
  invalid input, and returns a deeply frozen snapshot with the same instance ID. Connector/client
  validators require exact own data properties, enums, bounded arrays and matching instance IDs,
  copy fields individually, and apply the existing signed 256 KiB response ceiling. A malformed or
  throwing source produces a fixed `collection-failed` snapshot without its message. Reads use only
  frozen metadata and perform no env, filesystem, schema, config, or lazy-service operation.
- **Why:** A provenance read remains a bounded snapshot read and cannot become a secret lookup
  endpoint.
- **Test home:** hostile source/getter tests and real-client canary tests.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                      | Kind              | Consumer / real code path that READS it                        |
| ---------------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| `ConfigProvenanceOrigin`, `ConfigSchemaEffect`       | common types      | Snapshot entries, connector validator, devtool labels.         |
| `ConfigProvenanceEntry`, `ConfigDiagnosticsSnapshot` | common interfaces | Config source, client, and devtool configuration panel.        |
| `IConfigDiagnosticsSource`                           | common interface  | ConfigPlugin provider and DiagnosticsPlugin consumer.          |
| `CAPABILITIES.CONFIG_DIAGNOSTICS`                    | common token      | Same provider/consumer path.                                   |
| `ConfigDiagnosticsOptions`                           | config type       | `loadConfig` metadata builder and `ConfigPlugin` source setup. |
| `IDiagnosticsClient.configuration`                   | interface method  | Native devtool reads provenance.                               |

`IConfigDiagnosticsSource.snapshot(instanceId)` has the exact synchronous contract in §3.6.
`IDiagnosticsClient.configuration(): Promise<ConfigDiagnosticsSnapshot>` performs pairing and
support negotiation before any config request.

Internal raw-key/path maps, WeakMap records, builders, validators and projectors are not
barrel-exported.

### 4.1 Options — every option names its consumer

| Option                      | Consumer                | Behavior (per implementation)                                                                |
| --------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `diagnostics.enabled: true` | loader/plugin           | Enables metadata building; absence registers inert disabled source.                          |
| `diagnostics.keys`          | loader metadata builder | Selects keys and replaces raw names with aliases before retention.                           |
| `diagnostics.files`         | env loader              | Replaces configured paths with aliases; unapproved file origins become category-only `file`. |

## 5. Implementation files

| File                                                                                                                                                                                | Purpose                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `packages/common/src/services/diagnostics.ts`, `src/tokens.ts`, `src/index.ts`                                                                                                      | Config DTO/source contracts, token, exports.             |
| `packages/config-plugin/src/options.ts`, `src/diagnostics/provenance.ts`                                                                                                            | Public opt-in and private builder/WeakMap/source.        |
| `packages/config-plugin/src/services/env-loader.ts`, `src/services/load-config.ts`, `src/services/variable-expander.ts`                                                             | Single-pass source, precedence and expansion evidence.   |
| `packages/config-plugin/src/validators/config-validator.ts`, `src/plugin/config-plugin.ts`, `src/index.ts`                                                                          | Schema effects, source registration, public type export. |
| `packages/diagnostics-plugin/src/interfaces/index.ts`, `src/plugin/diagnostics-plugin.ts`, `src/protocol/protocol.ts`, `src/transport/connector-handler.ts`, `src/client/client.ts` | Fixed config operation and client.                       |
| `PUBLIC_API.md`, `ARCHITECTURE.md`, `docs/diagnostics-protocol.md`, package READMEs, `CHANGELOG.md`, `ROADMAP.md`, `CLAUDE.md`                                                      | Contract, privacy, support and audit record.             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                   | src covered                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/test/unit/diagnostics-contract.test.ts`, `test/unit/tokens.test.ts`, `test/unit/index.test.ts`             | common changed files               | Contracts export and token grammar.                                                                                                                                                                                                  |
| `packages/config-plugin/test/unit/options.test.ts`, `test/unit/provenance.test.ts`                                          | options/provenance                 | Bounds, aliases, frozen value-free entries, WeakMap lifetime, opaque instances and no added reads.                                                                                                                                   |
| `packages/config-plugin/test/unit/env-loader.test.ts`                                                                       | env-loader                         | Exact env/file precedence and path aliasing without another read.                                                                                                                                                                    |
| `packages/config-plugin/test/unit/load-config.test.ts`                                                                      | load-config                        | One load/expand/schema/section pass; opaque get-call parity with diagnostics off/on; metadata adoption keeping `environment`/`file` origins; both `unknown` producers — opaque instance and schema-introduced key — emitted exactly. |
| `packages/config-plugin/test/unit/variable-expander.test.ts`, `test/unit/config-validator.test.ts`                          | variable-expander/config-validator | Approved references and evidenced schema effects; errors remain value-free.                                                                                                                                                          |
| `packages/config-plugin/test/integration/config-plugin.test.ts`, `test/unit/barrel-exports.test.ts`                         | plugin/index                       | Eager source, disabled/no-data/opaque states and exports.                                                                                                                                                                            |
| `packages/diagnostics-plugin/test/unit/protocol.test.ts`, `test/unit/connector-handler.test.ts`, `test/unit/plugin.test.ts` | protocol/connector/plugin          | Support key, canonical target, auth before read, exact projection, unsupported and source failure.                                                                                                                                   |
| `packages/diagnostics-plugin/test/unit/client.test.ts`, `test/index.test.ts`                                                | client/interfaces/index            | False-key no-request, `configuration()` verification, DTO rejection, close/deadline semantics.                                                                                                                                       |
| `packages/diagnostics-plugin/test/e2e/config-provenance.test.ts`                                                            | all paths                          | Real load and socket; precedence useful; canary values, hashes, lengths, paths and errors absent everywhere.                                                                                                                         |

## 7. Verification gates

```bash
git branch --show-current   # feat/m98e-configuration-provenance during implementation
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage
```

Enforce per-file 90% branch/function/line from the ANSI-stripped table. On the committed tree run
`deno task publish:check` and `deno task release:verify <version>`. Record the reviewed revision,
tests, findings, dispositions and unsupported paths in the implementation PR.

## 8. Risks & mitigations

- Provenance becomes a value side channel: prohibit values, hashes, lengths and value comparison.
- Metadata changes config behavior: use the existing single path and assert invocation counts and
  object identity.
- Paths leak machines: retain configured aliases only and never copy loader errors into diagnostics.
- Diagnostics adds reads to opaque `IConfig`: mark provenance unknown and assert identical existing
  section-validation calls with diagnostics disabled and enabled.
- Schema metadata overclaims causality: report only property-presence effects and no arbitrary
  dependency graph.

## 9. Out of scope

- Values, editing/reload, full environment inventories, arbitrary key lookup, and validation
  payloads.
- Explaining application call-site defaults or arbitrary schema internals.
- Persisting provenance beyond the exact configuration object's lifetime.

## 10. Design security review — completed before implementation

**Reviewed flow:** configured aliases → existing env/file merge events → expansion grammar → schema
input/output presence → primitive-only builder → frozen WeakMap record → typed source →
authenticated fixed projector → signed frame → validating client. No value reaches the builder API.
For an injected instance, provenance performs no read; separately configured sections retain their
pre-existing `IConfig.get` calls whether diagnostics is disabled or enabled.

**Approved budgets:** 128 keys, eight file aliases, eight precedence entries per key, sixteen
expansion references per key, 64-byte aliases, one immutable snapshot, and the connector's 256 KiB
ceiling. Disabled mode builds no metadata record; close drops connector access and GC owns the
WeakMap lifetime.

| Finding                                            | Resolution in this plan                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| Hashes and lengths still reveal secrets.           | Neither is computed or represented.                                           |
| Pre-app load could require a second pass.          | Metadata travels with the exact `IConfig` through a WeakMap.                  |
| Custom instances may have malicious reads.         | Diagnostics adds none; configured sections retain their existing `get` calls. |
| Generic config inspection invites arbitrary reads. | Dedicated snapshot DTO, source token and `/v1/config` only.                   |

The implementation audit plants canaries in env, files, expanded strings, defaults, transforms,
validation errors and paths; checks builder inputs, retained records, frames and connector
errors/logs; proves useful aliases and precedence survive; and reruns M98b
wrong/replay/expiry/revocation/origin/instance tests for this operation.
