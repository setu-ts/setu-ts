# Milestone 101h — documentation, plus redaction setup that takes extra work

> **Status:** Complete (archived). Implementation diverged from this plan in three places, recorded
> in §11.
>
> **Originally:** Branch: `feat/m101h-docs-and-redaction`, cut from `origin/develop` in its own
> worktree. `develop` and `main` are both protected — all work (implementation + fixes) stays on
> this one branch until it merges into `develop` via a single PR (`gh pr create --base develop`).
>
> **Refreshed 2026-10-10 against `develop` at `bd063034`** (34 merges after the plan was written at
> `a3b7781c`). Every §1 citation was re-read at that commit. The redaction sources §3.1 changes are
> untouched since the plan was written, so the design stands; what changed is listed in §10.

## 0. Objective & scope

The code is correct and a reader following the documentation still cannot set it up. One code change
rides with it, additive: a redaction policy can name a redactor per field path, so two treatments
inside one classification (mask the email, erase the name — both `pii`) no longer need invented
classification strings. Closes `smoke/DEFECTS.md` rows **V8-30, V8-42, V8-43, V8-44**. This is the
M95d / M90h letter: documentation that survives contact, carried on one branch with no behavioural
risk.

**Sequence (decided in `PLAN-BRIEF.md`):** lands AFTER M101c, M101d and M101g, because it documents
final shapes — all three are now merged (PRs #411, #403, #415). So the three things that were
dependencies are now facts: the SAML CSRF recipe is in the auth README (M101c's V8-9 correction),
the multi-tenancy `dataStore` row exists with its `RegistryFactory` arm (`README.md:99`; this letter
adds the five OTHER missing rows around it and does not touch it), and M101g's generator writes a
`diagnostics` option for a reader who uses the CLI (this letter documents the option for a reader
who writes it by hand).

**Lands BEFORE M111a (maintainer, 2026-10-10).** M111 moves the toolchain off Deno, and this plan's
gates are the Deno-era ones. Two consequences: no NEW gate is built on a Deno-only tool (the
original §3.5 field-table check read interfaces through `deno doc --json`; it is replaced by a text
check plus the fence compiler, both of which M111b ports as ordinary tests), and every README this
letter edits will be edited again by M111f for install lines. M111f owns that; nothing here
anticipates it. The `FieldRedaction` `@since 0.9.0` tag stays correct, since `v0.9.0` is held for
the first npm release.

- **In scope:** `packages/common` (the per-field redactor, `src/redaction/*`), and the READMEs of
  `storage-plugin`, `multi-tenancy-plugin`, `telemetry-plugin`, `logger-plugin`, `auth-plugin`,
  `events-plugin` and `common`, plus `PUBLIC_API.md`, `CHANGELOG.md` and `docs/upgrading.md`. The
  `health-plugin`, `config-plugin`, `queue-plugin` and `scheduler-plugin` READMEs were in scope and
  are REMOVED: each already documents its diagnostics option in its own section (C6).
- **NOT this milestone:** the SAML recipe (M101c); the `dataStore` row (M101c); the SDK, React
  Router and full-stack-starter docs (M101d); every CLI generator (M101e/f/g); a redaction audit of
  `audit-plugin`/`telemetry-plugin` beyond their option tables (M96 shipped and verified them); any
  new `DATA_CLASSIFICATIONS` member.

## 1. Contracts verified from SOURCE (not names)

| Reference                                          | Source (file:line)                                                                                                                                                                                        | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RedactionPolicy`                                  | `packages/common/src/redaction/policy.ts:7-14`                                                                                                                                                            | `fields: Record<string, DataClassification>`, `redactors?: Record<string, Redactor>` keyed by CLASSIFICATION, `defaultRedactor?`. There is no per-path redactor — the V8-30 mechanism. Unchanged since `a3b7781c`                                                                                                                                                                                                                                                                                                                                                                                                             |
| Redactor selection                                 | `packages/common/src/redaction/redaction-service.ts:24-46`                                                                                                                                                | `createRedactionService(policy, { caseSensitive? })`: `match(path)` returns a classification (`:31`); the redactor is `policy.redactors[classification]`, else `defaultRedactor`, else `eraseRedactor` (`:29,34-37`)                                                                                                                                                                                                                                                                                                                                                                                                          |
| Field matcher                                      | `packages/common/src/redaction/field-matcher.ts:11-33,37-59`                                                                                                                                              | compiles patterns to `{ segments, classification }`; returns `selected?.classification` (`:32`); ties broken by `specificity` (`:49`; literals > `*` > `**`, then length), equal patterns keep declaration order                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Redactor` / `RedactionContext`                    | `packages/common/src/redaction/redactors.ts:6-14,17,32`                                                                                                                                                   | `Redactor = (value, { path, classification }) => unknown`; `eraseRedactor`, `createMaskRedactor({ keep })`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DATA_CLASSIFICATIONS` / `DataClassification`      | `packages/common/src/redaction/classification.ts:8-18`                                                                                                                                                    | `{ PII: 'pii', PHI: 'phi', PCI: 'pci', SECRET: 'secret' }`; the type admits any `string` — `'private'` (logger README `:93`) compiles and is nothing the framework knows                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `common` barrel for redaction                      | `packages/common/src/index.ts:295-301`                                                                                                                                                                    | `DATA_CLASSIFICATIONS`, `DEFAULT_SECRET_FIELD_PATTERNS`, `DataClassification`, `createMaskRedactor`, `eraseRedactor`, `MaskOptions`, `RedactionContext`, `Redactor`, `RedactionPolicy`, `createRedactionService`, `IRedactionService`; common README export row `:220`                                                                                                                                                                                                                                                                                                                                                        |
| Readers of `policy.fields`                         | `packages/common/src/redaction/redaction-service.ts:28`; `grep -rn "\.fields\b\|fields\[" packages/*/src` (re-run at `bd063034`)                                                                          | the only reader is `createRedactionService` handing it to the matcher. Logger (`logger-plugin.ts:268,285`, `console-logger.ts:92`), telemetry (`interfaces/index.ts:166`) and audit (M96) BUILD a policy and pass it through; none reads `fields` back                                                                                                                                                                                                                                                                                                                                                                        |
| Storage `'local'` option row                       | `packages/storage-plugin/README.md:92,142`; `packages/storage-plugin/src/interfaces/index.ts:162-165`; `src/providers/local-provider.ts:45`                                                               | the row names `LocalStorageProviderOptions` and lists no field; the type has exactly `rootDir?: string`, default `'.'`; `README.md:142` (`## The \`local\` provider needs write permission`) documents the write requirement                                                                                                                                                                                                                                                                                                                                                                                                  |
| Multi-tenancy options table                        | `packages/multi-tenancy-plugin/README.md:93-106`; `packages/multi-tenancy-plugin/src/interfaces/index.ts:102-172`                                                                                         | the table has `resolver`, `database`, `dataStore` (M101c's row, `:99`), `cache`, `required`, `rejectionStatus`, `middlewarePriority`; the type ALSO has `subdomain` (`:106`), `header` (`:108`), `path` (`:110`), `jwt` (`:120`) and `exclude` (`:171`) — five rows missing, as V8-43 says                                                                                                                                                                                                                                                                                                                                    |
| Telemetry options table                            | `packages/telemetry-plugin/README.md:38-52,104-109,119`; `packages/telemetry-plugin/src/interfaces/index.ts:166,168,179`                                                                                  | table lacks `redaction?: RedactionPolicy \| IRedactionService`, `queryParameters?: 'omit' \| 'redact'` and `diagnostics?: TraceDiagnosticsOptions`; `## Request URL handling` (`:104`) mentions `queryParameters` in prose only; `## Trace diagnostics (M98g)` (`:119`) already documents the diagnostics option, so only the table row is missing                                                                                                                                                                                                                                                                            |
| Logger README example                              | `packages/logger-plugin/README.md:86-99`                                                                                                                                                                  | `## Redaction` uses `fields: { 'user.email': 'private' }` (`:93`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Auth rate-limit key: source vs docs                | `packages/auth-plugin/src/middleware/rate-limit-middleware.ts:205-219`; `packages/auth-plugin/README.md:1161-1163,1212`; `PUBLIC_API.md:3036-3041`                                                        | source: `user:<id>` → `ip:<CLIENT_IP_STATE_KEY>` → `ip:<request.ip>` → `'anonymous'`; the auth README prose (`:1161-1163`) and `PUBLIC_API.md` (`:3036-3041`) say the same; the auth README options table (`:1212`) says `ip ?? 'anonymous'` — the contradiction V8-43 names. `PUBLIC_API.md` has NO options-table cell for it (C1)                                                                                                                                                                                                                                                                                           |
| `CAPABILITIES.AUTH`                                | `packages/common/src/tokens.ts:57`; `packages/auth-plugin/README.md:24,83,567`; `PUBLIC_API.md:2909,10767`                                                                                                | the token member is `AUTH` (value `'authentication'`); there is no `AUTHENTICATION` member. The auth README uses the string literal at `:24` and `:83` and the constant at `:567`; `PUBLIC_API.md` uses the literal at `:2909` and `:10767` (C3)                                                                                                                                                                                                                                                                                                                                                                              |
| `IPrincipal`                                       | `packages/common/src/services/auth.ts:16-25`; `PUBLIC_API.md:2858,11468`                                                                                                                                  | `id`, `roles?`, `permissions?`, `claims?` — unchanged by M110a/M110b, which added no member; `PUBLIC_API.md` lists it only as a re-export row (`:2858`) and in the `common` Auth row (`:11468`) — no shape                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `RedactionPolicy` shape in docs                    | `grep -rn "defaultRedactor\|redactors:" PUBLIC_API.md packages/common/README.md packages/logger-plugin/README.md docs/*.md` → empty (re-run at `bd063034`); `PUBLIC_API.md:11377` `### Redaction`         | the three members of the policy are documented nowhere in prose; `PUBLIC_API.md`'s Redaction section describes classifications and the two shipped redactors but not the policy's own fields                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Diagnostics option names and their README coverage | auth `interfaces/index.ts:324` (`authorizationDiagnostics?: AuthorizationDiagnosticsOptions`, type at `:119`); events `interfaces/index.ts:121` (`diagnostics?: EventsDiagnosticsOptions`, type at `:54`) | the auth and events READMEs mention theirs ONLY as export-table rows (`auth:1273,1277`, `events:116`) — exactly V8-44's text. The other five source packages already document theirs in a section under their own heading: health `## Health observations (M98d)` (`:54`), queue `## Queue observations (M98f)` (`:197`), scheduler `## Execution observations` (`:127`), telemetry `## Trace diagnostics (M98g)` (`:119`), and config in prose plus a fence (`:145-167`). The original §1 grep matched only the literal heading `## Diagnostics`, so it missed all five; they were documented when the plan was written (C6) |
| sdk README already covers its source               | `packages/sdk/README.md:466`                                                                                                                                                                              | `## Outbound HTTP observations (devtool)` documents `createObservedFetch` — not a V8-44 site                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Fence-compiler gate                                | `test/package-readme-fence-compiler.test.ts:58-143,175-185`                                                                                                                                               | pins a compilable-fence COUNT per README (storage 3, multi-tenancy 3, auth **18** — M110a/M110b added two, common 2, logger 3, telemetry 2); `events-plugin/README.md` sits in `UNGATED` (`:180`) and carries 3 TypeScript fences                                                                                                                                                                                                                                                                                                                                                                                             |
| Export-table drift gate                            | `scripts/check-docs.ts:2270`; `deno.json:90` (`docs:exports`)                                                                                                                                             | `## Exports` tables must match the barrel; regenerated by `deno task docs:exports`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `check:docs` chain                                 | `deno.json:59`                                                                                                                                                                                            | runs `check-docs.ts` (structure, links, catalog, version claims), prose assertions, example behaviour, `@since` tags against jsr.io, changelog coverage, and the API-doc generator check                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Upgrade guide structure                            | `docs/upgrading.md:10-13`                                                                                                                                                                                 | entries land under `## Unreleased` at milestone time; the heading now exists (`:13`, added by the milestones since `0.8.0`), so this letter adds its entry beneath it                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Compatibility statement                            | `scripts/plan-lint.ts:77-91,145-168`                                                                                                                                                                      | every plan states `**Breaking for implementors:**` — `none`, or what breaks and the minor that carries it (patch-is-the-norm from `0.9.0`). §4 states `none`; the reader-side widening of §3.1 lands in `0.9.0`, itself a minor                                                                                                                                                                                                                                                                                                                                                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                 | Resolution (picked side)                                                                                                                                         | Doc deliverable (same PR)                                                                                                                                                                                               |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | Auth README options table says the default key is `ip ?? 'anonymous'`; the prose above it, `PUBLIC_API.md:3036-3041` and `defaultRateLimitKey` all say principal → client IP → `IRequest.ip` → `'anonymous'`                                                                                                                             | The source wins; the table cell is corrected to the four-step order and cross-references the prose                                                               | `packages/auth-plugin/README.md:1212`. `PUBLIC_API.md` needs no edit: it has no options-table cell for the key, and its prose already matches the source (the original plan named a "matching row" that does not exist) |
| C2 | The logger README's only redaction example classifies a field `'private'`, a string the framework's `DATA_CLASSIFICATIONS` does not know and no shipped redactor is keyed to                                                                                                                                                             | Keep the example's intent, use `DATA_CLASSIFICATIONS.PII`, and say in one sentence that an application-defined string is legal and reaches `redactors[<string>]` | `packages/logger-plugin/README.md:86-99`                                                                                                                                                                                |
| C3 | The auth README reaches `IAuthService` by the string `'authentication'` (`:24`, `:83`) and by `CAPABILITIES.AUTH` (`:567`); `PUBLIC_API.md` uses the string at `:2909` and `:10767`                                                                                                                                                      | Constants everywhere (AI_GUIDELINES §11.2); one sentence states the member is `AUTH`, not `AUTHENTICATION`                                                       | `packages/auth-plugin/README.md:24,83`; `PUBLIC_API.md:2909,10767` (the original plan named only the README)                                                                                                            |
| C4 | `ROADMAP.md` M101h listed `auth-plugin`, `events-plugin` "and the five further diagnostics-carrying plugins" among its packages; the auth-plugin `src` is untouched here (its README is), and C6 shows four of those five READMEs need nothing                                                                                           | The package list is READMEs plus `common`; no `src` outside `packages/common` changes, asserted as a command in §7                                               | `ROADMAP.md` M101h `Package(s)` line corrected by the 2026-10-10 refresh (this branch), not by the milestone                                                                                                            |
| C5 | `ROADMAP.md` M101h and `X58-FINDINGS.md` say `RedactionPolicy` and `DATA_CLASSIFICATIONS` are "documented nowhere (they appear only in `.d.ts`)"; `PUBLIC_API.md:11377` and the common README DO name them — what is absent is the policy's SHAPE (`fields`/`redactors`/`defaultRedactor`) and the classification table                  | The finding is narrowed to what `grep` shows: the shape, not the names                                                                                           | Reported in the hand-back; the shape lands in both sites (§3.3)                                                                                                                                                         |
| C6 | The original §3.5 added a `## Diagnostics` section to seven READMEs. Five of them — health, queue, scheduler, telemetry, config — already document their option (§1, "Diagnostics option names"), and did when the plan was written; its grep matched only the literal heading `## Diagnostics`. V8-44 itself names only auth and events | §3.5 narrows to auth and events. Headings are NOT renamed to a uniform `## Diagnostics` — renaming breaks inbound anchors for no reader gain                     | None beyond §3.5; telemetry still gains its missing options-table row (§3.4)                                                                                                                                            |

## 3. Design decisions

### 3.1 V8-30 — a field pattern may carry its own redactor

- **Decision:** `RedactionPolicy.fields` widens from
  `readonly fields: Readonly<Record<string, DataClassification>>` to
  `readonly fields: Readonly<Record<string, DataClassification | FieldRedaction>>` — both `readonly`
  modifiers kept, so the public mutation contract is unchanged and only the value type widens —
  where
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
  additive for every code path that WRITES a policy. It is not for one that READS `policy.fields[k]`
  as a `DataClassification`, which now sees the union and fails `deno check`. In-repo the only
  reader is `createRedactionService` itself (`redaction-service.ts:28`, changed here); every other
  consumer builds a policy and never reads one back. An out-of-repo reader is possible, so the
  CHANGELOG entry states it in one sentence rather than calling the change purely additive — no
  upgrade-guide step, since no released code path is known to read it. Precedence puts the most
  specific declaration first, matching how the matcher already prefers the most specific PATTERN.
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
  the `dataStore` row M101c added (`README.md:99`) is left exactly as it is. (2) telemetry README
  options table gains `redaction`, `queryParameters` (with the fail-closed-to-omit rule from M96)
  and `diagnostics`, whose description links to the existing `## Trace diagnostics (M98g)` section
  rather than repeating it. (3) logger README `'private'` → `DATA_CLASSIFICATIONS.PII` (C2). (4)
  `IPrincipal` gets a four-row shape table in the auth README `## Strategies` section (`:100`) and
  in `PUBLIC_API.md`'s `common` Auth row (`:11468`). (5) the rate-limit table cell (C1) and the
  `CAPABILITIES.AUTH` constant in the auth README and both `PUBLIC_API.md` sites (C3).
- **Why:** each is a reader hitting the `.d.ts` because the README table stopped short of the type;
  every row names the TYPE from §1 so the export-table drift gate keeps the names honest.
- **Test home:** `check:docs` (structure and links); the fence compiler (auth count unchanged by
  this section — `:83` is already inside a counted fence, so swapping the literal for the constant
  moves no count); and a prose assertion (`assert:js`) on the rate-limit paragraph evaluating
  `defaultRateLimitKey` over a minimal context with a principal, with only a client IP, and with
  nothing — the M90h C1 shape, so the table cell cannot drift from the source again.
- **The expression form is measured, not assumed.** `check-prose-assertions.ts:178-187` wraps each
  cell in `const value = (<expression>);` inside a module run as `deno run --no-prompt --ext=ts -`
  from the repository root, so a cell can reach a package through top-level `await import`. Probed
  at `bd063034`:
  `(await import('@setu-ts/auth-plugin')).defaultRateLimitKey({ request: {}, state: new Map() })`
  evaluates to `"anonymous"`, and the same shape over `createRedactionService` returns
  `"[Redacted]"`. A cell must therefore be one expression of that form; a statement, or an
  expression returning an un-awaited promise (which serializes as `{}`), is not.

### 3.5 V8-44 — a diagnostics section for auth and events

- **Decision:** `auth-plugin` and `events-plugin` each gain a `## Diagnostics` section following the
  ones that already exist: the option NAME (`authorizationDiagnostics` for auth, `diagnostics` for
  events), the option TYPE, its fields as a table read from the interface in §1, what is recorded
  and what is never captured (the minimization sentence from M98h / M98j), the connector path it
  answers on (`GET /v1/authorization`, `GET /v1/event`), and one compilable registration fence that
  sets EVERY field the table lists. `events-plugin/README.md` moves from `UNGATED` into the gated
  table of the fence compiler; any of its three existing fences that does not compile is fixed in
  the same PR (the M70i fold precedent). The health, config, queue, scheduler and telemetry READMEs
  are NOT edited here (C6).
- **Why:** V8-44's text names exactly these two: their options appear only as export-table rows
  (§1). M101g's generator writes the option for a reader who uses `setu devtool enable`; this letter
  documents it for the reader who writes it by hand, and links to that command as the shortcut.
- **Test home:** the fence compiler (auth 18 → 19, events gated with its real count). Field-table
  drift is caught WITHOUT a Deno-only tool (the original design read interfaces through
  `deno doc --json`, a gate M111 would replace within months): (a) each section's fence sets every
  field, so a renamed or removed interface member fails the fence compiler with `TS2353`, and (b) a
  new text-only case in `test/docs-gate.test.ts` parses each of the two `## Diagnostics` tables and
  asserts every listed field name appears as a key in that section's fence, so a table row that
  names a field the fence does not set fails. Together a table field must be a key of a fence that
  compiles against the real interface. **Negative controls:** renaming a field in the fence fails
  the fence compiler; renaming it in the table only fails the docs-gate case.

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
  `git diff --name-only origin/develop...HEAD -- 'packages/*/src/**' | grep -v '^packages/common/src/'`
  is empty at hand-off (the M90h invariant-as-a-command).
- **Both halves of the command were wrong in the original plan, and each would have hidden the
  other.** The pathspec `'packages/*/src'` matches NO file: git matches a wildcard pathspec against
  the whole path, so `packages/*/src` does not match `packages/auth-plugin/src/index.ts`. Measured
  at `bd063034`, `git diff --name-only main...develop -- 'packages/*/src'` prints 0 files while the
  `'packages/*/src/**'` form prints 290. And `main` is the last release, not the integration branch,
  so a diff from it sweeps in every PR merged since `0.8.0`. The old form always passed; the
  corrected pathspec alone, against `main`, would always fail. The M90h entry in `CLAUDE.md` records
  the same vacuous pathspec, so that milestone's invariant was never actually checked as written.
- **Test home:** §7.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — `RedactionPolicy.fields` widens to a union that still accepts
every existing policy.

The one reader-side consequence (§3.1: code that reads `policy.fields[k]` as a `DataClassification`
sees the union) lands in `0.9.0`, which is a minor, so it needs no `BREAKING` entry and leaves
`verify-release` check 10 unaffected; the CHANGELOG sentence in §3.1 still states it.

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

| File                                                 | Purpose                                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/src/redaction/policy.ts`            | `FieldRedaction`; `fields` value union                                                                                                                                   |
| `packages/common/src/redaction/field-matcher.ts`     | compiled pattern carries the optional redactor; returns the pattern                                                                                                      |
| `packages/common/src/redaction/redaction-service.ts` | four-step selection                                                                                                                                                      |
| `packages/common/src/index.ts`                       | barrel: `FieldRedaction`                                                                                                                                                 |
| `packages/common/README.md`                          | `## Redaction` section (§3.3)                                                                                                                                            |
| `packages/storage-plugin/README.md`                  | `LocalStorageProviderOptions` sub-table (§3.6)                                                                                                                           |
| `packages/multi-tenancy-plugin/README.md`            | five option rows (§3.4) around M101c's existing `dataStore` row                                                                                                          |
| `packages/telemetry-plugin/README.md`                | three option rows; the `diagnostics` row links to the existing `## Trace diagnostics (M98g)` section                                                                     |
| `packages/logger-plugin/README.md`                   | classification example (C2) + a link to the policy shape                                                                                                                 |
| `packages/auth-plugin/README.md`                     | rate-limit cell (C1), `CAPABILITIES.AUTH` (C3), `IPrincipal` table, `## Diagnostics`                                                                                     |
| `packages/events-plugin/README.md`                   | `## Diagnostics` section (§3.5); existing fences made to compile once gated                                                                                              |
| `test/package-readme-fence-compiler.test.ts`         | counts; events moves to the gated table                                                                                                                                  |
| `test/docs-gate.test.ts`                             | the text-only field-table-versus-fence case for the two new `## Diagnostics` sections (§3.5)                                                                             |
| `PUBLIC_API.md`                                      | Redaction shape + classification table; `IPrincipal` shape in the `common` Auth row; `CAPABILITIES.AUTH` at `:2909` and `:10767` (C3). No rate-limit edit (C1)           |
| `CHANGELOG.md`, `docs/upgrading.md`                  | `Added` entry for `FieldRedaction`, with one sentence naming the reader-side type change (§3.1; no upgrade step); entries go under the existing `## Unreleased` headings |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

The four `src` files — three redaction modules plus the `packages/common/src/index.ts` barrel — are
the only code. The barrel is a re-export, fully covered merely by being loaded, so (the M56
convention) its per-file number proves nothing and its one new export is pinned instead by the
compile-time assignment in `barrel-exports.test.ts`; the 90% bar applies as measured to the three
modules. Every documentation deliverable names the EXISTING gate that pins it, because a doc
correction with no gate is the M90h lesson.

| Test file / gate                                                                     | src or doc covered                                                                                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/redaction-service.test.ts` (extended)                     | `redaction/policy.ts`, `redaction/field-matcher.ts`, `redaction/redaction-service.ts`               | §3.1 cases against `createRedactionService(policy, options?)`; both `fields` value forms in one policy; precedence table iterated as data (field redactor / class redactor / default / erase); specificity unchanged; `caseSensitive` unchanged                                                                |
| `packages/common/test/unit/redaction-default-patterns.test.ts`                       | `redaction/classification.ts`                                                                       | unchanged — pins that the M99a default list is untouched                                                                                                                                                                                                                                                       |
| `packages/common/test/unit/barrel-exports.test.ts` (extended)                        | `src/index.ts`                                                                                      | `FieldRedaction` exported; compile-time assignment of a string-valued and an object-valued policy to `RedactionPolicy`                                                                                                                                                                                         |
| `packages/logger-plugin/test/unit/redaction-per-field.test.ts` (new)                 | consumer inheritance (§3.2); no logger `src` change                                                 | real kernel app, stock `LoggerPlugin({ redaction })`, console transport: masked email, intact name                                                                                                                                                                                                             |
| `test/package-readme-fence-compiler.test.ts` (counts updated; events gated)          | every README fence added here                                                                       | each new fence compiles against the real packages; the pinned counts move by exactly the fences added                                                                                                                                                                                                          |
| `test/docs-gate.test.ts` (new case)                                                  | the auth and events `## Diagnostics` field tables                                                   | every field row names a key the section's fence sets; the fence compiler proves those keys are members of the real options interface                                                                                                                                                                           |
| `test/prose-assertion-gate.test.ts` + `scripts/check-prose-assertions.ts` (existing) | the `assert:js` tables added to the common README (precedence) and the auth README (rate-limit key) | the documented claims evaluate to the documented values in a permission-denied subprocess (M77)                                                                                                                                                                                                                |
| `deno task check:docs` (existing chain)                                              | all READMEs, `PUBLIC_API.md`, `docs/upgrading.md`                                                   | structure, intra-document anchors (`#the-local-provider-needs-write-permission`), export-table drift (`docs:exports` regenerates nothing — no barrel changed except `common`'s one type), `@since` tags on `FieldRedaction` (`0.9.0`, verified by `check-since-tags` as ahead-of-registry), changelog coverage |

Per-file bar, measured at `bd063034` with `deno task test:coverage:pkg common` (branch / function /
line): `field-matcher.ts` 94.6 / 100 / 97.1, `redaction-service.ts` 98.0 / 100 / 100. The original
plan said both were at 100%; neither is. `redactors.ts`, which this letter does not change, measured
88.9 branch in that targeted run — a targeted FAIL is not authoritative (other packages' tests may
cover it), so the full `deno task test:coverage` decides it, and if it is under the bar there, it is
lifted in this PR because the letter touches the module next to it. The new object-arm branches are
each driven by a named unit case above, so neither changed file may drop below its measured number.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m101h-docs-and-redaction, never develop or main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs        # fence counts, export tables, prose assertions, anchors, @since, changelog
deno task publish:check     # committed tree
deno task release:verify 0.8.0
git diff --name-only origin/develop...HEAD -- 'packages/*/src/**' | grep -v '^packages/common/src/'   # MUST print nothing (§3.7)
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/common/src/redaction
```

Plus the negative controls, each observed failing and reverted: §3.1 (per-field branch removed → the
mask assertion fails), §3.5 (a field renamed in a `## Diagnostics` fence → the fence compiler fails;
renamed in the table only → the docs-gate case fails), §3.3/§3.4 (an `assert:js` value edited away
from the measured one → the prose gate fails), §3.7 (touch any file under `packages/auth-plugin/src`
→ the invariant command prints it; this control is what proves the corrected pathspec matches).

## 8. Risks & mitigations

- Widening `fields`' value type could break an out-of-repo function that READS a policy's values as
  strings → recorded as `Changed` with the migration note "narrow with `typeof value === 'string'`";
  no in-repo reader exists (§1).
- Moving `events-plugin/README.md` into the gated fence table may surface fences that never compiled
  → fixed in this PR (the M70i fold found four such fences; budgeted for).
- M111f will rewrite install lines in every README edited here → no conflict in content (this letter
  touches option tables, examples and new sections, not install lines); whichever lands second
  rebases. M101h lands first (maintainer, 2026-10-10).
- A `## Diagnostics` field table hand-copied from a `.d.ts` can go stale → the fence sets every
  listed field and compiles against the real interface, and the docs-gate case ties each table row
  to a fence key (§3.5).
- A gate built for this letter must survive M111b's move to Vitest → both new checks are ordinary
  tests over text and a TypeScript compile; neither shells out to a Deno-only tool.

## 9. Out of scope

- M101c (merged): the SAML recipe, the `dataStore` row, the session README tenant-binding section.
- The health, config, queue, scheduler and telemetry diagnostics sections, which already exist (C6).
- M111f: install lines and the JSR-to-npm rewrite of every README.
- M101d: the SDK retry/trace/codegen docs, the React Router boundary, the full-stack snapshot
  accessor docs.
- M101g: any CLI command that writes a `diagnostics` option; this letter links to it.
- A per-field `caseSensitive` override, a redactor receiving the whole record, and asynchronous
  redactors — each a seam change, none a documentation gap.
- Re-auditing M96's telemetry and audit redaction defaults (verified in Part 12 / X54).

## 10. Refresh log (2026-10-10, `develop` at `bd063034`)

What changed against the plan as written at `a3b7781c`, so a reviewer can see the delta without a
diff:

- **Sequencing:** M101c, M101d and M101g are merged; their three deliverables are now facts (§0).
  M101h lands before M111a, which rules out new Deno-only gates (§0, §3.5).
- **Branch model:** `develop` is the integration branch; the status line and every `main` reference
  in a command now say `develop` / `origin/develop` (§7).
- **§3.7 invariant:** the pathspec matched no file and the base was the last release; both fixed and
  given a negative control (§3.7, §7).
- **V8-44 scope (C6):** five of the seven READMEs already document their diagnostics option; §3.5
  narrows to auth and events, and four packages leave the in-scope list.
- **C1:** `PUBLIC_API.md` has no rate-limit options cell; the "matching row" deliverable is removed.
- **C3:** two `PUBLIC_API.md` sites carrying the `'authentication'` literal are added.
- **§3.5 gate:** `deno doc --json` replaced by fence-sets-every-field plus a text check.
- **§3.4 prose assertions:** the expression form is measured — a cell is one
  `(await import('@setu-ts/…')).…` expression.
- **Coverage baseline:** measured, not assumed; the original 100% claim was false (§6).
- **Citations:** every §1 line number re-read; the auth fence count is 18 (M110a/M110b added two).

## 11. Implementation deviations (recorded at archive time)

- **Upgrade guide (§3.1):** §3.1 said no upgrade-guide step was needed. The branch adds a
  `docs/upgrading.md` entry under `## Unreleased`, stated as a note rather than a required
  migration, so a reader who reads policies back finds the narrowing where readers look. §5 already
  listed the file.
- **CHANGELOG section (§8):** §8 said `Changed`. The entry is under `Added`, beside the
  `FieldRedaction` export it announces, with the reader-side narrowing sentence §3.1 required. §5
  named `Added`.
- **Logger test (§3.2):** §3.2 said the test leaves `user.name` intact. The shipped test gives
  `user.name` a `pii` classification with no field redactor and asserts it falls through to
  `redactors.pii` (`'class-level'`). That is stronger: it exercises both precedence steps in one
  consumer.

## 12. Design security review (recorded after implementation, at the maintainer's direction)

This plan had no design review, but its one code change sits in the policy evaluator that decides
what the logger, telemetry spans and audit trail send out of the process. That is a trust boundary
under `.roo/skills/security-audit/SKILL.md`. This section is recorded after implementation (the
M101a §11 / M101b §10 precedent) and does not claim to have guided the design.

**Flows reviewed.**

- A `RedactionPolicy` supplied by application code reaches `createRedactionService` in one of three
  ways:
  - directly;
  - through `LoggerPlugin({ redaction })`, applied on both the console and Pino transports;
  - through `TelemetryPlugin({ redaction, queryParameters: 'redact' })` (query values under
    `query.<name>`);
  - through `AuditPlugin({ redaction })` (`before`/`after`/`metadata`);
  - through `IdempotencyPlugin({ redaction })` (a stored JSON response body, before it is persisted
    for replay; `core/record.ts`). This fourth path was missing from the review until audit round 1
    (S2).
- The compiled matcher picks one pattern per dot path.
- The service then picks one redactor per matched path: the field's own `redactor`, then
  `redactors[classification]`, then `defaultRedactor`, then `eraseRedactor`.
- That redactor's output is what leaves the process.
- The values being redacted are request-derived application data; the policy itself is
  configuration.

**Assets.**

- The confidentiality of every classified value on every egress path that accepts a policy.
- The logger's default secret-field redaction (M96/M99a), which must keep applying alongside an
  application policy.
- The integrity of the application's own records: redaction never mutates the caller's object.

**Attackers.**

- A remote client controlling the values being logged, traced or audited, and their key names
  (including `__proto__`, `constructor`, dotted or case-varied keys, and deep nesting).
- A misconfiguration reaching the policy from a JavaScript caller or an untyped config file: an
  object entry with no `classification`, a non-string `classification`, a `redactor` that is not a
  function, or a redactor that throws.
- A reader of the resulting logs, spans and audit rows.
- The policy author is trusted: an application that installs an identity redactor has chosen to emit
  that value. That is not a finding.

**Approved budgets.**

- No extra work for a string-valued field: one property read per match beyond the M96 path.
- Policy compilation still happens once per service, never per record.

**Obligations.**

1. **Unchanged behaviour for existing policies.** A policy whose `fields` values are all strings
   behaves exactly as before for every input: same pattern chosen, same redactor, same output.
2. **Pattern choice does not depend on the value's form.** Specificity alone decides which pattern
   wins (literal over `*` over `**`, then length, then declaration order). Whether a field's value
   is a string or a `FieldRedaction` cannot change which pattern matches a path.
3. **The field's own redactor is first.** It is preferred over `redactors[classification]`, and only
   for the pattern that declared it.
4. **Fail closed on a malformed object entry.** If an entry is malformed at runtime (no
   `classification`, a non-string `classification`, `redactor: null`, or `redactor: undefined`), a
   matched value must never leave unredacted: it falls through to `defaultRedactor` or erase.
5. **A non-function `redactor`, or a redactor that throws, never emits the raw value.** Whatever the
   egress plugin does — throw at the call site, drop the record, or substitute — the original value
   must not appear in its output. Whether startup refuses such a policy is a design choice; the
   audit reports which happens.
6. **No prototype-chain lookup.** Selecting a redactor by classification does not reach the
   prototype chain: a classification named `__proto__`, `constructor` or `toString` resolves only to
   an own `redactors` entry.
7. **No mutation.** Neither the caller's record nor the caller's policy object is changed, and
   compiling a policy does not freeze or rewrite it.
8. **Default secret redaction still applies.** With an application policy supplied to
   `LoggerPlugin`, its default secret patterns still redact (for example `password` and
   `authorization`). A per-field redactor on a different path does not disable them.

**Findings.**

| #  | Finding                                                                                                                                                                                                                                                                                   | Disposition                                                                                                                                          |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 | Verification: obligations 1, 3, 7 and 8 driven through real kernel apps (logger console transport, audit row read back, telemetry span `http.url`)                                                                                                                                        | Held; 20-check probe, `.verify/milestone-101h-verification.md`                                                                                       |
| V2 | Verification: removing the per-field branch fails the common and logger suites                                                                                                                                                                                                            | Negative control observed, reverted                                                                                                                  |
| V3 | Verification: the auth Diagnostics table typed `enabled` as literal `true` while `AuthorizationDiagnosticsOptions.enabled` is `boolean`                                                                                                                                                   | Fixed in `759557a4` (documentation only)                                                                                                             |
| R1 | Design review: obligation 5 — a non-function `redactor` from a JavaScript caller is not refused when the service is created; it throws on first use                                                                                                                                       | Open for the audit: whether the throw leaks, drops or fails the egress call decides severity                                                         |
| S1 | Audit round 1 (Medium): `redactor` was read through the prototype chain (`value.redactor` in the matcher, `matched.redactor` in the service), so a polluted `Object.prototype.redactor` emitted every matched value raw, including the logger's default secret list. `develop` was immune | Fixed: both reads are own-property only (`Object.hasOwn`), and so is `classification`. Three regression tests, each verified to fail without the fix |
| S2 | Audit round 1 (Low): the flows above omitted `idempotency-plugin`, a fourth consumer of a policy                                                                                                                                                                                          | Fixed: added to "Flows reviewed"                                                                                                                     |
| O1 | Audit round 1, pre-existing: a throwing redactor in `idempotency-plugin` answers 500, then 409 on retry; it reproduces through the unchanged class-keyed `redactors` arm                                                                                                                  | Not changed here: predates M101h, left for a `fix/…` branch                                                                                          |
| O2 | Audit round 1: `fields: { x: null }` now throws `TypeError` at construction where `develop` erased the value                                                                                                                                                                              | Not changed: fails closed, and only an untyped caller can reach it                                                                                   |

| C1 | PR #445 review (CodeRabbit): an entry without its own `classification` handed `undefined` to
the class lookup, which reads `redactors['undefined']`, so a policy keying an identity redactor
under `'undefined'` emitted the value raw | Fixed: such an entry (or one whose `classification` is
not a string) compiles straight to erase. Regression test verified to fail without the fix |

The S1, S2 and C1 fixes were not re-audited: the maintainer waived a second audit round.
