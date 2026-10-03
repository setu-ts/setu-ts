# Milestone 101h — documentation, plus redaction setup that takes extra work

> **Status:** Planning. Branch: `feat/m101h-docs-and-redaction`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

The code is correct and a reader following the documentation still cannot set it up. One code change
rides with it, additive: a redaction policy can name a redactor per field path, so two treatments
inside one classification (mask the email, erase the name — both `pii`) no longer need invented
classification strings. Closes `smoke/DEFECTS.md` rows **V8-30, V8-42, V8-43, V8-44**. This is the
M95d / M90h letter: documentation that survives contact, carried on one branch with no behavioural
risk.

**Sequence (decided in `PLAN-BRIEF.md`):** lands AFTER M101c, M101d and M101g, because it documents
final shapes. Three things are therefore dependencies and NOT deliverables here: the SAML CSRF
recipe (M101c owns V8-9's correction in the auth README), the multi-tenancy `dataStore` row (M101c
widens it; this letter adds the five OTHER missing rows to the same table and rebases on M101c), and
any generator that writes a plugin's `diagnostics` option (M101g's no-row deliverable; this letter
documents the option by hand for a reader who writes it by hand).

- **In scope:** `packages/common` (the per-field redactor, `src/redaction/*`), and the READMEs of
  `storage-plugin`, `multi-tenancy-plugin`, `telemetry-plugin`, `logger-plugin`, `auth-plugin`,
  `events-plugin`, `health-plugin`, `config-plugin`, `queue-plugin`, `scheduler-plugin`, `common`,
  plus `PUBLIC_API.md`, `CHANGELOG.md` and `docs/upgrading.md`.
- **NOT this milestone:** the SAML recipe (M101c); the `dataStore` row (M101c); the SDK, React
  Router and full-stack-starter docs (M101d); every CLI generator (M101e/f/g); a redaction audit of
  `audit-plugin`/`telemetry-plugin` beyond their option tables (M96 shipped and verified them); any
  new `DATA_CLASSIFICATIONS` member.

## 1. Contracts verified from SOURCE (not names)

| Reference                                     | Source (file:line)                                                                                                                                                                                                                                                                                                   | Verified surface / fact                                                                                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RedactionPolicy`                             | `packages/common/src/redaction/policy.ts:7-14`                                                                                                                                                                                                                                                                       | `fields: Record<string, DataClassification>`, `redactors?: Record<string, Redactor>` keyed by CLASSIFICATION, `defaultRedactor?`. There is no per-path redactor — the V8-30 mechanism                                                                                           |
| Redactor selection                            | `packages/common/src/redaction/redaction-service.ts:24-46`                                                                                                                                                                                                                                                           | `createRedactionService(policy, { caseSensitive? })`: `match(path)` returns a classification; the redactor is `policy.redactors[classification]`, else `defaultRedactor`, else `eraseRedactor` (`:34-37`)                                                                       |
| Field matcher                                 | `packages/common/src/redaction/field-matcher.ts:11-33,37-59`                                                                                                                                                                                                                                                         | compiles patterns to `{ segments, classification }`; returns `selected?.classification`; ties broken by `specificity` (literals > `*` > `**`, then length), equal patterns keep declaration order                                                                               |
| `Redactor` / `RedactionContext`               | `packages/common/src/redaction/redactors.ts:9-14`                                                                                                                                                                                                                                                                    | `Redactor = (value, { path, classification }) => unknown`; `eraseRedactor`, `createMaskRedactor({ keep })`                                                                                                                                                                      |
| `DATA_CLASSIFICATIONS` / `DataClassification` | `packages/common/src/redaction/classification.ts:8-18`                                                                                                                                                                                                                                                               | `{ PII: 'pii', PHI: 'phi', PCI: 'pci', SECRET: 'secret' }`; the type admits any `string` — `'private'` (logger README `:93`) compiles and is nothing the framework knows                                                                                                        |
| `common` barrel for redaction                 | `packages/common/src/index.ts:252-254`                                                                                                                                                                                                                                                                               | `MaskOptions`, `RedactionContext`, `Redactor`, `RedactionPolicy`, `createRedactionService` exported; `DATA_CLASSIFICATIONS` exported (common README export row `:184`)                                                                                                          |
| Policy consumers that BUILD `fields`          | `packages/logger-plugin/src/plugin/logger-plugin.ts:281-287` (M99a §1); telemetry `interfaces/index.ts:160`; audit per M96                                                                                                                                                                                           | every consumer passes a policy through to `createRedactionService`; none inspects `fields` values, so widening the value type reaches them with no change                                                                                                                       |
| Storage `'local'` option row                  | `packages/storage-plugin/README.md:84-90`; `packages/storage-plugin/src/interfaces/index.ts:162-165`; `src/providers/local-provider.ts:45`                                                                                                                                                                           | the row names `LocalStorageProviderOptions` and lists no field; the type has exactly `rootDir?: string`, default `'.'`; `README.md:137` already documents the write-permission requirement                                                                                      |
| Multi-tenancy options table                   | `packages/multi-tenancy-plugin/README.md:87-95`; `packages/multi-tenancy-plugin/src/interfaces/index.ts:90-150`                                                                                                                                                                                                      | the table has `resolver`, `database`, `dataStore`, `cache`, `required`, `rejectionStatus`, `middlewarePriority`; the type ALSO has `subdomain`, `header`, `path`, `jwt`, `exclude` (`:94-108,149`) — five rows missing, as V8-43 says                                           |
| Telemetry options table                       | `packages/telemetry-plugin/README.md:42-52,96`; `packages/telemetry-plugin/src/interfaces/index.ts:160,162,173`                                                                                                                                                                                                      | table lacks `redaction?: RedactionPolicy \| IRedactionService`, `queryParameters?: 'omit' \| 'redact'` and `diagnostics?: TraceDiagnosticsOptions`; `:96` mentions `queryParameters` in prose only                                                                              |
| Logger README example                         | `packages/logger-plugin/README.md:86-100`                                                                                                                                                                                                                                                                            | `## Redaction` uses `fields: { 'user.email': 'private' }`                                                                                                                                                                                                                       |
| Auth rate-limit key: source vs docs           | `packages/auth-plugin/src/middleware/rate-limit-middleware.ts:205-219`; `packages/auth-plugin/README.md:1037-1039,1088`                                                                                                                                                                                              | source: `user:<id>` → `ip:<CLIENT_IP_STATE_KEY>` → `ip:<request.ip>` → `'anonymous'`; prose `:1037-1039` says the same; the options table `:1088` says `ip ?? 'anonymous'` — the contradiction V8-43 names                                                                      |
| `CAPABILITIES.AUTH`                           | `packages/common/src/tokens.ts:57,59`; `packages/auth-plugin/README.md:24,83,445`                                                                                                                                                                                                                                    | the token member is `AUTH` (value `'authentication'`); there is no `AUTHENTICATION` member. The README uses the string literal at `:83` and the constant at `:445`                                                                                                              |
| `IPrincipal`                                  | `packages/common/src/services/auth.ts:16-25`; `PUBLIC_API.md:2491`                                                                                                                                                                                                                                                   | `id`, `roles?`, `permissions?`, `claims?`; `PUBLIC_API.md` lists it only as a re-export row — no shape                                                                                                                                                                          |
| `RedactionPolicy` shape in docs               | `grep -rn "defaultRedactor\|redactors:" PUBLIC_API.md packages/common/README.md packages/logger-plugin/README.md docs/*.md` → empty; `PUBLIC_API.md:10181` `### Redaction`                                                                                                                                           | the three members of the policy are documented nowhere in prose; `PUBLIC_API.md`'s Redaction section describes classifications and the two shipped redactors but not the policy's own fields                                                                                    |
| Diagnostics option names                      | auth `interfaces/index.ts:296` (`authorizationDiagnostics?: AuthorizationDiagnosticsOptions`, type at `:113`); events `:121` (`diagnostics?: EventsDiagnosticsOptions`, `:54`); health `:206` (`:71`); config `options.ts:130` (`:146`); queue `:310` (`:353`); scheduler `:142` (`:160`); telemetry `:173` (`:207`) | seven source packages carry an option; `grep -ln "^## Diagnostics\|^### Diagnostics" packages/*/README.md` finds only cache, realtime-backplane, sse, storage, websocket; the auth and events READMEs mention theirs only as export-table rows (`auth:1142,1146`, `events:116`) |
| sdk README already covers its source          | `packages/sdk/README.md:429`                                                                                                                                                                                                                                                                                         | `## Outbound HTTP observations (devtool)` documents `createObservedFetch` — not a V8-44 site                                                                                                                                                                                    |
| Fence-compiler gate                           | `test/package-readme-fence-compiler.test.ts:58-129,162-172`                                                                                                                                                                                                                                                          | pins a compilable-fence COUNT per README (storage 3, multi-tenancy 3, scheduler 3, queue 10, auth 16, common 2, config 6, health 3, logger 3, telemetry 2); `events-plugin/README.md` sits in `UNGATED`                                                                         |
| Export-table drift gate                       | `scripts/check-docs.ts:2268-2284`; `deno.json:86` (`docs:exports`)                                                                                                                                                                                                                                                   | `## Exports` tables must match the barrel; regenerated by `deno task docs:exports`                                                                                                                                                                                              |
| `check:docs` chain                            | `deno.json:56`                                                                                                                                                                                                                                                                                                       | runs `check-docs.ts` (structure, links, catalog, version claims), prose assertions, example behaviour, `@since` tags against jsr.io, changelog coverage, and the API-doc generator check                                                                                        |
| Upgrade guide structure                       | `docs/upgrading.md:10-13`                                                                                                                                                                                                                                                                                            | the guide's own rule says entries land under `## Unreleased` at milestone time; no such heading exists yet (first heading is `## 0.8.0`) — M101c/M101d add it, this letter rebases                                                                                              |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                | Resolution (picked side)                                                                                                                                         | Doc deliverable (same PR)                                                                   |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| C1 | Auth README options table says the default key is `ip ?? 'anonymous'`; the prose three screens above and `defaultRateLimitKey` say principal → client IP → `IRequest.ip` → `'anonymous'`                                                                                                                                | The source wins; the table cell is corrected to the four-step order and cross-references the prose                                                               | `packages/auth-plugin/README.md:1088` + the matching `PUBLIC_API.md` rate-limit options row |
| C2 | The logger README's only redaction example classifies a field `'private'`, a string the framework's `DATA_CLASSIFICATIONS` does not know and no shipped redactor is keyed to                                                                                                                                            | Keep the example's intent, use `DATA_CLASSIFICATIONS.PII`, and say in one sentence that an application-defined string is legal and reaches `redactors[<string>]` | `packages/logger-plugin/README.md:86-100`                                                   |
| C3 | The auth README reaches `IAuthService` by the string `'authentication'` in one fence and by `CAPABILITIES.AUTH` in another                                                                                                                                                                                              | Constants everywhere (AI_GUIDELINES §11.2); one sentence states the member is `AUTH`, not `AUTHENTICATION`                                                       | `packages/auth-plugin/README.md:83` (and `:24`'s table cell gains the constant name)        |
| C4 | `ROADMAP.md` M101h lists `packages/storage-plugin`, `packages/auth-plugin`, `packages/events-plugin` as packages; the auth-plugin `src` is untouched here (its README is), and V8-44 names "siblings" that turn out to be five more packages (§1)                                                                       | The package list is READMEs plus `common`; no `src` outside `packages/common` changes, asserted as a command in §7                                               | Reported in the hand-back (no `ROADMAP.md` edit here)                                       |
| C5 | `ROADMAP.md` M101h and `X58-FINDINGS.md` say `RedactionPolicy` and `DATA_CLASSIFICATIONS` are "documented nowhere (they appear only in `.d.ts`)"; `PUBLIC_API.md:10181` and the common README DO name them — what is absent is the policy's SHAPE (`fields`/`redactors`/`defaultRedactor`) and the classification table | The finding is narrowed to what `grep` shows: the shape, not the names                                                                                           | Reported in the hand-back; the shape lands in both sites (§3.3)                             |

## 3. Design decisions

### 3.1 V8-30 — a field pattern may carry its own redactor

- **Decision:** `RedactionPolicy.fields` widens from `Record<string, DataClassification>` to
  `Record<string, DataClassification | FieldRedaction>` where
  `FieldRedaction = { readonly classification: DataClassification; readonly redactor?: Redactor }`
  (a new exported type). Selection precedence becomes, in order: the matched field's own `redactor`,
  then `redactors[classification]`, then `defaultRedactor`, then `eraseRedactor`.
  `createFieldMatcher` returns the matched compiled pattern (classification + optional redactor)
  instead of the classification alone — an INTERNAL change; the matching and specificity rules are
  untouched, so which pattern wins is identical to today. `RedactionContext.classification` keeps
  reporting the matched classification, so a per-field redactor still sees it.
- **Why:** the register's model is "classify as `pii`"; today two treatments inside one
  classification force a second classification string whose only purpose is to key a redactor, and
  that string then leaks into every `RedactionContext` and audit trail as if it were a real class. A
  string value stays legal, so every existing policy is byte-identical in behaviour; the widening is
  additive. Precedence puts the most specific declaration first, matching how the matcher already
  prefers the most specific PATTERN.
- **Test home:** `packages/common/test/unit/redaction-service.test.ts` (extended): two `pii` fields,
  `user.email` with `createMaskRedactor({ keep: 4 })` and `user.name` erased, through ONE policy; a
  field-level redactor beats `redactors.pii`; a field with no redactor falls through to
  `redactors.pii`, then `defaultRedactor`, then erase; `redactRecord` and `redactValue` agree; the
  existing specificity cases are unchanged. **Negative control:** with the per-field branch removed,
  both `pii` fields take `redactors.pii` and the mask assertion fails.

### 3.2 V8-30 — every consumer inherits the widening with no edit

- **Decision:** `logger-plugin`, `telemetry-plugin` and `audit-plugin` are not edited: each passes
  its policy through to `createRedactionService` (§1). One kernel-level test proves a per-field
  policy supplied through `LoggerPlugin({ redaction })` reaches the console transport.
- **Why:** the "one capability, one implementation" rule — the seam is the only place that reads
  `fields`, and a plugin-side copy of the precedence would be the M56 class.
- **Test home:** `packages/logger-plugin/test/unit/redaction-per-field.test.ts` (new): a stock
  `LoggerPlugin({ redaction: { fields: { 'user.email': { classification: 'pii', redactor: mask } } } })`
  in a real kernel app masks the email and leaves `user.name` intact.

### 3.3 V8-43 — the redaction policy shape and the classification table get a home

- **Decision:** `PUBLIC_API.md` `### Redaction` (`:10181`) gains the policy's three members as a
  table (`fields`, `redactors`, `defaultRedactor`), the `FieldRedaction` arm, the precedence list
  from §3.1, and the `DATA_CLASSIFICATIONS` table (four members, "any string is accepted"). The
  common README gains a `## Redaction` section carrying the same table and ONE compilable fence (a
  policy with both value forms), with a link to `PUBLIC_API.md` for the rest.
- **Why:** the common README is the page jsr.io renders for the package that owns the seam; the
  logger, telemetry and audit READMEs already link to it for the policy and so stop needing a copy.
- **Test home:** the fence compiler pins the common README count 2 → 3; the prose precedence list is
  asserted executable through an `assert:js` table (M77) evaluating `createRedactionService` over
  the documented example — so the documented precedence IS a test.

### 3.4 V8-43 — the other five sites

- **Decision, per site:** (1) multi-tenancy README options table gains `subdomain`, `header`,
  `path`, `jwt` (each "options forwarded to that resolver") and `exclude` (with its default list);
  the `dataStore` row is M101c's and is rebased, not rewritten. (2) telemetry README options table
  gains `redaction`, `queryParameters` (with the fail-closed-to-omit rule from M96) and
  `diagnostics`. (3) logger README `'private'` → `DATA_CLASSIFICATIONS.PII` (C2). (4) `IPrincipal`
  gets a four-row shape table in the auth README "Strategies" section and in `PUBLIC_API.md`'s
  `common` Authentication rows. (5) the rate-limit table cell (C1) and the `CAPABILITIES.AUTH`
  constant (C3).
- **Why:** each is a reader hitting the `.d.ts` because the README table stopped short of the type;
  every row names the TYPE from §1 so the export-table drift gate and `deno doc` keep them honest.
- **Test home:** `check:docs` (structure and links), the fence compiler (auth 16 → 17 for the
  `CAPABILITIES.AUTH` fence if it is rewritten as a fence; otherwise unchanged), and a prose
  assertion (`assert:js`) on the rate-limit paragraph evaluating `defaultRateLimitKey` over a
  minimal context with a principal, with only a client IP, and with nothing — the M90h C1 shape, so
  the table cell cannot drift from the source again.

### 3.5 V8-44 — one `## Diagnostics` section per source package

- **Decision:** `auth-plugin`, `events-plugin`, `health-plugin`, `config-plugin`, `queue-plugin`,
  `scheduler-plugin` and `telemetry-plugin` each gain a `## Diagnostics` section following the five
  that already exist (cache, realtime-backplane, sse, storage, websocket): the option NAME
  (`authorizationDiagnostics` for auth, `diagnostics` elsewhere), the option TYPE, its fields as a
  table read from the interface in §1, what is recorded and what is never captured (the plan's
  minimization sentence per M98 letter), the connector path it answers on, and one compilable
  registration fence. `events-plugin/README.md` moves from `UNGATED` into the gated table of the
  fence compiler; any pre-existing fence in it that does not compile is fixed in the same PR (the
  M70i fold precedent).
- **Why:** X60's eleven option objects were written from `.d.ts` or `PUBLIC_API.md`; the README is
  where a reader starts. M101g's generator removes the need for most readers, which is why that
  deliverable is cited here as the dependency and NOT duplicated: this letter documents the option
  for the reader who still writes it by hand, and links to `setu devtool enable` as the shortcut.
- **Test home:** the fence compiler (auth +1, config +1, health +1, queue +1, scheduler +1,
  telemetry +1, events gated with its real count); each section's field table is checked against the
  interface by the export-table drift gate's companion — a new case in `test/docs-gate.test.ts` that
  parses every `## Diagnostics` option table and asserts each listed field is a declared member of
  the named interface (read through `deno doc --json`), so a renamed field fails the gate.
  **Negative control:** renaming a field in one table fails that case.

### 3.6 V8-42 — the storage `'local'` row names `rootDir`

- **Decision:** the `'local'` row's "Required fields" stays `—` (it is optional) and a
  `LocalStorageProviderOptions` sub-table follows the main table: `rootDir?: string`, default `'.'`,
  with the sentence that the directory must be writable and a link to the existing
  `## The local provider needs write permission` section.
- **Why:** the only reason the row is empty is that the type has one optional field; the reader
  still needs its name and default.
- **Test home:** `check:docs` link validation (the intra-README anchor) and the fence compiler count
  (unchanged — a table, not a fence).

### 3.7 No `src` outside `common` changes

- **Decision:**
  `git diff --name-only main...HEAD -- 'packages/*/src' | grep -v '^packages/common/src/'` is empty
  at hand-off (the M90h invariant-as-a-command).
- **Test home:** §7.

## 4. Exported surface — every symbol names its consumer

| Exported symbol             | Kind | Consumer / real code path that READS it                                                                                    |
| --------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| `FieldRedaction` (`common`) | type | the value arm of `RedactionPolicy.fields`; read by `createFieldMatcher` (compile) and `createRedactionService` (selection) |

`RedactionPolicy`'s `fields` member changes type; no other barrel changes.
`packages/common/test/unit/barrel-exports.test.ts` is extended with a compile-time assignment of
both value forms.

### 4.1 Options — every option names its consumer

| Option                                      | Consumer                                 | Behavior (per implementation)                                                                                          |
| ------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `RedactionPolicy.fields[path]` (object arm) | `createRedactionService` via the matcher | `classification` is matched and reported exactly as the string arm; `redactor`, when present, is selected first (§3.1) |

## 5. Implementation files

| File                                                                                                                                                                                 | Purpose                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/redaction/policy.ts`                                                                                                                                            | `FieldRedaction`; `fields` value union                                                                                 |
| `packages/common/src/redaction/field-matcher.ts`                                                                                                                                     | compiled pattern carries the optional redactor; returns the pattern                                                    |
| `packages/common/src/redaction/redaction-service.ts`                                                                                                                                 | four-step selection                                                                                                    |
| `packages/common/src/index.ts`                                                                                                                                                       | barrel: `FieldRedaction`                                                                                               |
| `packages/common/README.md`                                                                                                                                                          | `## Redaction` section (§3.3)                                                                                          |
| `packages/storage-plugin/README.md`                                                                                                                                                  | `LocalStorageProviderOptions` sub-table (§3.6)                                                                         |
| `packages/multi-tenancy-plugin/README.md`                                                                                                                                            | five option rows (§3.4), rebased on M101c's `dataStore` row                                                            |
| `packages/telemetry-plugin/README.md`                                                                                                                                                | three option rows + `## Diagnostics`                                                                                   |
| `packages/logger-plugin/README.md`                                                                                                                                                   | classification example (C2) + a link to the policy shape                                                               |
| `packages/auth-plugin/README.md`                                                                                                                                                     | rate-limit cell (C1), `CAPABILITIES.AUTH` (C3), `IPrincipal` table, `## Diagnostics`                                   |
| `packages/events-plugin/README.md`, `packages/health-plugin/README.md`, `packages/config-plugin/README.md`, `packages/queue-plugin/README.md`, `packages/scheduler-plugin/README.md` | `## Diagnostics` sections (§3.5)                                                                                       |
| `test/package-readme-fence-compiler.test.ts`                                                                                                                                         | counts; events moves to the gated table                                                                                |
| `test/docs-gate.test.ts`                                                                                                                                                             | the `## Diagnostics` field-table case (§3.5)                                                                           |
| `PUBLIC_API.md`                                                                                                                                                                      | Redaction shape + classification table; rate-limit row; `IPrincipal` rows                                              |
| `CHANGELOG.md`, `docs/upgrading.md`                                                                                                                                                  | `Added` entry for `FieldRedaction` (no upgrade step — additive); rebase on the `## Unreleased` heading M101c/M101d add |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

The three `src` files are the only code; every documentation deliverable names the EXISTING gate
that pins it, because a doc correction with no gate is the M90h lesson.

| Test file / gate                                                                     | src or doc covered                                                                                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/redaction-service.test.ts` (extended)                     | `redaction/policy.ts`, `redaction/field-matcher.ts`, `redaction/redaction-service.ts`               | §3.1 cases against `createRedactionService(policy, options?)`; both `fields` value forms in one policy; precedence table iterated as data (field redactor / class redactor / default / erase); specificity unchanged; `caseSensitive` unchanged                                                                |
| `packages/common/test/unit/redaction-default-patterns.test.ts`                       | `redaction/classification.ts`                                                                       | unchanged — pins that the M99a default list is untouched                                                                                                                                                                                                                                                       |
| `packages/common/test/unit/barrel-exports.test.ts` (extended)                        | `src/index.ts`                                                                                      | `FieldRedaction` exported; compile-time assignment of a string-valued and an object-valued policy to `RedactionPolicy`                                                                                                                                                                                         |
| `packages/logger-plugin/test/unit/redaction-per-field.test.ts` (new)                 | consumer inheritance (§3.2); no logger `src` change                                                 | real kernel app, stock `LoggerPlugin({ redaction })`, console transport: masked email, intact name                                                                                                                                                                                                             |
| `test/package-readme-fence-compiler.test.ts` (counts updated; events gated)          | every README fence added here                                                                       | each new fence compiles against the real packages; the pinned counts move by exactly the fences added                                                                                                                                                                                                          |
| `test/docs-gate.test.ts` (new case)                                                  | the seven `## Diagnostics` field tables + the five existing ones                                    | every field row names a declared member of the named options interface                                                                                                                                                                                                                                         |
| `test/prose-assertion-gate.test.ts` + `scripts/check-prose-assertions.ts` (existing) | the `assert:js` tables added to the common README (precedence) and the auth README (rate-limit key) | the documented claims evaluate to the documented values in a permission-denied subprocess (M77)                                                                                                                                                                                                                |
| `deno task check:docs` (existing chain)                                              | all READMEs, `PUBLIC_API.md`, `docs/upgrading.md`                                                   | structure, intra-document anchors (`#the-local-provider-needs-write-permission`), export-table drift (`docs:exports` regenerates nothing — no barrel changed except `common`'s one type), `@since` tags on `FieldRedaction` (`0.9.0`, verified by `check-since-tags` as ahead-of-registry), changelog coverage |

Per-file bar: `field-matcher.ts` and `redaction-service.ts` are at 100% on `main` (measured by
`deno task test:coverage:pkg common` before the branch is cut, recorded in the PR); the new
object-arm branches are each driven by a named unit case above, so both stay at 100%.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m101h-docs-and-redaction, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs        # fence counts, export tables, prose assertions, anchors, @since, changelog
deno task publish:check     # committed tree
deno task release:verify 0.8.0
git diff --name-only main...HEAD -- 'packages/*/src' | grep -v '^packages/common/src/'   # MUST print nothing
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/common/src/redaction
```

Plus the negative controls, each observed failing and reverted: §3.1 (per-field branch removed → the
mask assertion fails), §3.5 (a renamed field in one `## Diagnostics` table → the docs-gate case
fails), §3.3/§3.4 (an `assert:js` value edited away from the measured one → the prose gate fails).

## 8. Risks & mitigations

- Widening `fields`' value type could break an out-of-repo function that READS a policy's values as
  strings → recorded as `Changed` with the migration note "narrow with `typeof value === 'string'`";
  no in-repo reader exists (§1).
- Moving `events-plugin/README.md` into the gated fence table may surface fences that never compiled
  → fixed in this PR (the M70i fold found four such fences; budgeted for).
- This letter edits README tables M101c also edits (multi-tenancy `dataStore`) → M101h is sequenced
  after M101c and rebases; the `dataStore` row is never rewritten here.
- `docs/upgrading.md`'s `## Unreleased` heading is added by M101c/M101d → if neither has landed when
  this branch is cut, this letter adds it; the attribution gate (M90h) refuses a heading with no
  matching CHANGELOG section, so the entry lands under `Unreleased` only.
- A `## Diagnostics` field table hand-copied from a `.d.ts` can go stale → the new docs-gate case
  reads the interface through `deno doc --json`, so it cannot.

## 9. Out of scope

- M101c: the SAML recipe, the `dataStore` row, the session README tenant-binding section.
- M101d: the SDK retry/trace/codegen docs, the React Router boundary, the full-stack snapshot
  accessor docs.
- M101g: any CLI command that writes a `diagnostics` option; this letter links to it.
- A per-field `caseSensitive` override, a redactor receiving the whole record, and asynchronous
  redactors — each a seam change, none a documentation gap.
- Re-auditing M96's telemetry and audit redaction defaults (verified in Part 12 / X54).
