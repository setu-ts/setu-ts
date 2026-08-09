# Milestone 56 — RFC 9457 Problem Details (`@setu-ts/exceptions`, `@setu-ts/validation-plugin`)

> **Status:** Planning. Branch: `feat/m56-rfc9457-problem-details`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

RFC 7807 was obsoleted by **RFC 9457** (July 2023). The framework advertises "RFC 7807 Problem
Details" in two packages, a public `ErrorFormat` union value (`'rfc7807'`), an exported symbol
(`rfc7807Formatter`) in each package, three starters, and eleven documentation sites — all naming a
withdrawn specification. This milestone moves the framework onto RFC 9457: it renames the public
surface with a §9.2 deprecation path, and it corrects the one place where the emitted body reflects
a 7807-era habit that 9457 argues against — a synthetic `type` URI minted from the status code for
every error, which carries no information the `status` member does not already carry.

The wire format is otherwise **unchanged**, and that is a finding rather than an assumption: RFC
9457 Appendix D lists exactly three changes from 7807 — a registry of common problem type URIs
(§4.2), clarified handling of multiple problems (§3), and guidance for non-dereferenceable type URIs
(§3.1.1). The five core members, the `application/problem+json` media type, and extension members
are all carried over verbatim. The bodies this framework emits are already structurally valid under
9457.

- **In scope:** the `rfc9457` public naming with `rfc7807` deprecated-not-removed in both packages;
  `about:blank` for status-only problems in `@setu-ts/exceptions`; correcting the content-type
  identity check in both packages so it survives the second formatter; updating the three starters,
  the CLI template prose, `scripts/jsr-metadata.ts`, and every documentation site.
- **NOT this milestone:** realigning the `errors` extension from `{ field, message, code }` to the
  `{ detail, pointer }` shape RFC 9457 §3 illustrates — explicitly declined by the maintainer, since
  `errors[].field` is the most widely consumed part of the validation response. Registering any
  framework problem type in the IANA registry (§4.2) is not framework work at all; it is a
  specification submission. Documentation of the migration in the user-facing guides belongs to
  **M38**.

## 1. Contracts verified from SOURCE (not names)

| Reference                       | Source (file:line)                                                             | Verified surface / fact                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RFC 9457 changes from 7807      | RFC 9457 Appendix D (fetched from rfc-editor.org)                              | Exactly three: type-URI registry (§4.2), multiple-problems clarification (§3), non-dereferenceable type-URI guidance (§3.1.1). Core members, media type, extensions all unchanged. |
| RFC 9457 `about:blank`          | RFC 9457 §4.2, §3.1                                                            | Registry is pre-populated with `about:blank`, meaning "no semantics beyond the HTTP status code". Absent `type` is **assumed** to be `about:blank`.                                |
| `ERROR_TYPE_BASE`               | `packages/exceptions/src/formatters/rfc7807-formatter.ts:22`                   | `'https://setu-ts.dev/errors'`. Exported public API.                                                                                                                               |
| `ProblemDetails`                | `packages/exceptions/src/formatters/rfc7807-formatter.ts:32`                   | `type`/`title`/`status`/`detail` required; `instance`/`errors`/`stack` optional; open index signature for extensions.                                                              |
| `rfc7807Formatter` (exceptions) | `packages/exceptions/src/formatters/rfc7807-formatter.ts:78`                   | Emits `type: ${ERROR_TYPE_BASE}/${statusCode}` for **every** error. `errors` copied from `details.errors` when present.                                                            |
| `ErrorFormat` (exceptions)      | `packages/exceptions/src/formatters/error-formatter.ts:40`                     | `'default' \| 'rfc7807'`. A two-arm union.                                                                                                                                         |
| `selectFormatter`               | `packages/exceptions/src/formatters/error-formatter.ts:105`                    | `switch` over the union; a function passes through; unknown string throws `TypeError`.                                                                                             |
| Content-type identity check     | `packages/exceptions/src/middleware/error-handler.ts:93`                       | `const isRfc7807 = formatter === rfc7807Formatter;` — a **reference identity** test, not a string test.                                                                            |
| `statusTitle` / `STATUS_TITLES` | `packages/exceptions/src/errors/exceptions.ts:39,61`                           | Maps 11 status codes to their reason phrases, `'Error'` otherwise. Already exactly what §4.2 wants beside `about:blank`.                                                           |
| `validationError()`             | `packages/exceptions/src/errors/exceptions.ts:140`                             | Builds `new HttpError(422, summary, { errors })` — the ONLY factory putting `errors` into `details`.                                                                               |
| `HttpError` shape               | `packages/exceptions/src/errors/exceptions.ts:81,145,175`                      | Carries `statusCode`, `message`, optional `details`, optional `cause`. **No distinct problem-type identity beyond the status code.**                                               |
| `rfc7807Formatter` (validation) | `packages/validation-plugin/src/formatters/rfc7807-formatter.ts:17`            | Emits `type: 'https://setu-ts.dev/errors/validation'` — a hardcoded literal, NOT derived from status. Already 9457-correct.                                                        |
| `ErrorFormat` (validation)      | `packages/validation-plugin/src/formatters/error-formatter.ts:54`              | `'default' \| 'rfc7807' \| 'nestjs'`. A **different, three-arm** union from the exceptions one.                                                                                    |
| Content-type check (validation) | `packages/validation-plugin/src/middleware/validation-middleware.ts:129`       | `const isProblemJson = formatter === rfc7807Formatter;` — the same reference-identity pattern, duplicated.                                                                         |
| Starter call sites              | `packages/starters/{rest,microservice,full-stack}-starter/src/app.ts:93,63,82` | All three pass the string literal `errorHandler({ format: 'rfc7807' })`.                                                                                                           |
| JSR package descriptions        | `scripts/jsr-metadata.ts:100,128`                                              | Both name "RFC 7807"; reapplied by `deno task release:set-metadata`, so a stale string persists on jsr.io until corrected here.                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                     | Resolution (picked side)                                                                                                                                               | Doc deliverable (same PR)                                                                                 |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md:6656` states "RFC 7807 compliance" as a guarantee. After this milestone the emitted `type` follows 9457 §4.2, which 7807 does not describe. The claim becomes wrong for the new default.      | The framework targets **RFC 9457**. 7807 compliance is retained only under the deprecated `'rfc7807'` alias, and is documented as such.                                | Rewrite `PUBLIC_API.md` §Exceptions notes and the `ErrorFormat`/`rfc7807Formatter` rows.                  |
| C2 | `PUBLIC_API.md:622` shows `errorFormat: 'rfc7807'` in the validation-plugin example while `PUBLIC_API.md:6645` documents the exceptions union as `'default' \| 'rfc7807'` — two different unions, same name. | Keep them as two distinct unions (they legitimately differ: validation carries `'nestjs'`). Document each explicitly rather than implying one shared type.             | Correct both `PUBLIC_API.md` sites to name their owning package and list the correct arms.                |
| C3 | `packages/exceptions/README.md` and `packages/validation-plugin/README.md` both advertise RFC 7807 as the standards-compliant option, with no mention that it is withdrawn.                                  | READMEs lead with RFC 9457; RFC 7807 appears only in a deprecation note.                                                                                               | Rewrite the Problem Details section of both package READMEs.                                              |
| C4 | Root `README.md` and `ARCHITECTURE.md` describe the error story as "RFC 7807".                                                                                                                               | Both move to RFC 9457.                                                                                                                                                 | Update the `README.md` feature row and the `ARCHITECTURE.md` error-handling section.                      |
| C5 | `scripts/jsr-metadata.ts:100,128` publish "RFC 7807" as the live jsr.io description for two packages.                                                                                                        | Update both strings. This does not take effect until `release:set-metadata` runs, which is a release step, not a publish step — noted so it is not mistaken for a bug. | Update both descriptions; note in the plan's §8 that the live page changes only on the next metadata run. |

## 3. Design decisions

### 3.1 Public naming — add `rfc9457`, deprecate `rfc7807`, remove nothing

- **Decision:** Each package gains an `'rfc9457'` union arm and an exported `rfc9457Formatter`. The
  existing `'rfc7807'` arm and `rfc7807Formatter` export both remain, marked `@deprecated` with a
  migration path in JSDoc, per AI_GUIDELINES §9.2. Nothing is removed in this milestone; removal is
  a 1.0 concern.
- **Why:** §9.2 mandates deprecate-then-remove, and §9.1 forbids breaking a released public API
  outside a major bump. Both symbols are published on JSR at `0.1.0-alpha.5` and are called by name
  in three starters and in user code.
- **Test home:** `exceptions/test/unit/error-formatter.test.ts` and
  `validation-plugin/test/unit/formatters.test.ts` — each asserts both arms resolve and that the
  deprecated arm still resolves to a working formatter.

### 3.2 `about:blank` for status-only problems (`@setu-ts/exceptions` only)

- **Decision:** `rfc9457Formatter` in `@setu-ts/exceptions` emits `type: 'about:blank'` for every
  error whose only semantics are its status code, and `type: '${ERROR_TYPE_BASE}/validation'` when
  the error carries `details.errors`. No other type URI is minted.
- **Why:** §1 establishes that `HttpError` carries no problem-type identity beyond `statusCode`, so
  `https://setu-ts.dev/errors/404` duplicates the `status` member and identifies nothing — precisely
  the case RFC 9457 §4.2 registers `about:blank` for. The one exception is the body produced by
  `validationError()`, which defines an `errors` extension member and is therefore a genuine problem
  type deserving its own URI. That URI is spelled to match the literal `validation-plugin` already
  emits, so both packages identify the same problem type identically. `title` continues to come from
  `statusTitle()`, which already yields the status reason phrase that §4.2 expects alongside
  `about:blank`.
- **Test home:** `exceptions/test/unit/rfc9457-formatter.test.ts` — one case per status-only factory
  asserting `about:blank`, one asserting the validation URI, and one asserting `ERROR_TYPE_BASE` is
  still read on a live path (so it is not dead surface).

### 3.3 The deprecated `rfc7807Formatter` keeps 7807 behavior in `@setu-ts/exceptions`

- **Decision:** `rfc7807Formatter` continues to emit `type: ${ERROR_TYPE_BASE}/${statusCode}`,
  byte-identically to today. It is a separate exported const from `rfc9457Formatter`, and the two
  produce different bodies.
- **Why:** AI_GUIDELINES §9.4 forbids changing the behavior of a public API without a version bump.
  A deprecated symbol whose whole purpose is a working migration path must not silently start
  emitting a different body — that is worse than a rename and worse than no change at all, because
  the caller has no signal. Keeping it faithful also makes the deprecation honest: the symbol named
  after RFC 7807 emits RFC 7807, and callers move deliberately.
- **Test home:** `exceptions/test/unit/rfc7807-formatter.test.ts` (the existing file, retained) — a
  regression case pinning the status-derived URI, plus one case asserting the two formatters produce
  **different** `type` values for the same error.

### 3.4 `validation-plugin`'s deprecated alias is the same reference

- **Decision:** In `@setu-ts/validation-plugin`, `rfc7807Formatter` is exported as a deprecated
  alias bound to the **same object** as `rfc9457Formatter`. One implementation, two names.
- **Why:** §1 establishes that this formatter's `type` is a hardcoded semantic URI, never derived
  from status, so its body is already valid under 9457 and there is no behavior to preserve
  separately. Two byte-identical implementations would be the duplicated logic §11.1 forbids, and
  binding one reference keeps the identity check in §3.5 correct for both spellings for free.
- **Test home:** `validation-plugin/test/unit/formatters.test.ts` — asserts reference equality and
  that both selector arms resolve to it.

### 3.5 Content-type selection becomes a membership test in both packages

- **Decision:** `error-handler.ts:93` and `validation-middleware.ts:129` stop comparing against a
  single formatter reference and instead test membership in a module-level frozen `Set` of
  problem-details formatters. In `exceptions` that set holds both formatters; in `validation-plugin`
  it holds the single shared reference.
- **Why:** Both sites key `application/problem+json` off **reference identity** so that passing a
  formatter directly (`format: rfc7807Formatter`, a documented and tested usage) gets the same media
  type as the string alias. Adding `rfc9457Formatter` without touching this check means
  `format: rfc9457Formatter` silently emits `application/json` — a Problem Details body under the
  wrong media type, which every generic problem-details client ignores. This is the defect this
  milestone is most likely to ship green, because the string arm `'rfc9457'` would test fine while
  the by-reference arm broke.
- **Test home:** `exceptions/test/unit/error-handler.test.ts` and
  `validation-plugin/test/unit/formatters.test.ts` — each drives the formatter **by reference** (not
  by string) and asserts `content-type: application/problem+json`, for both the new and deprecated
  spellings.

### 3.6 One shared core behind both entry points

- **Decision:** `exceptions` grows an internal, non-exported
  `buildProblemDetails(error, ctx, typeOf)` where `typeOf` is a `(error: HttpError) => string`
  strategy. `rfc9457Formatter` and `rfc7807Formatter` are thin consts differing only in the strategy
  they pass.
- **Why:** §11.1 forbids duplicated logic, and the CLAUDE.md self-review checklist requires that a
  behavior reachable two ways funnel through one implementation. The `title`/`status`/`detail`/
  `instance`/`errors` assembly is identical between the two formats; only `type` differs.
- **Test home:** `exceptions/test/unit/rfc9457-formatter.test.ts` — one case drives **both** entry
  points with the same `HttpError` and a request context, asserting every member except `type` is
  identical and `type` differs.

### 3.7 Downstream literals move to the new spelling

- **Decision:** The three starters change `errorHandler({ format: 'rfc7807' })` to `'rfc9457'`. The
  CLI `rest` template's prose comments, the `validation-plugin` JSDoc examples, and both
  `scripts/jsr-metadata.ts` descriptions move to RFC 9457.
- **Why:** These are the framework's own recommended compositions. Leaving them on the deprecated
  arm would mean every newly scaffolded project starts life emitting a withdrawn specification's
  body shape and consuming a deprecated symbol — and their own tests would pin that as correct.
- **Test home:** the three `starters/*/test/integration/app-integration.test.ts` files, whose
  existing assertions on the error body are updated to expect `about:blank`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                        | Kind  | Consumer / real code path that READS it                                                                                                              |
| -------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rfc9457Formatter` (exceptions)        | const | `selectFormatter` §3.1; the problem-details `Set` in `error-handler.ts` §3.5; all three starters §3.7.                                               |
| `rfc7807Formatter` (exceptions)        | const | Retained deprecated export. `selectFormatter`'s `'rfc7807'` arm and the same `Set`. Existing user code and its own regression test §3.3.             |
| `rfc9457Formatter` (validation-plugin) | const | `selectFormatter`'s `'rfc9457'` arm; `validation-middleware.ts` media-type set §3.5.                                                                 |
| `rfc7807Formatter` (validation-plugin) | const | Retained deprecated export, same reference as above §3.4. `selectFormatter`'s `'rfc7807'` arm.                                                       |
| `ERROR_TYPE_BASE`                      | const | Still read on a live path: `rfc9457Formatter` composes the validation type URI from it §3.2, and `rfc7807Formatter` composes its status URI from it. |
| `ProblemDetails`                       | type  | Return type of both exceptions formatters. Unchanged — `type` is already `string`, so `'about:blank'` needs no widening.                             |
| `ErrorFormat` (exceptions)             | type  | Widened to `'default' \| 'rfc9457' \| 'rfc7807'`. Read by `selectFormatter` and `ErrorHandlerOptions.format`.                                        |
| `ErrorFormat` (validation-plugin)      | type  | Widened to `'default' \| 'rfc9457' \| 'nestjs' \| 'rfc7807'`. Read by `selectFormatter` and `ValidationPluginOptions.errorFormat`.                   |

### 4.1 Options — every option names its consumer

| Option                                  | Consumer                                        | Behavior (per implementation)                                                                                                                    |
| --------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ErrorHandlerOptions.format: 'rfc9457'` | `errorHandler()` → `selectFormatter`            | Resolves to `rfc9457Formatter`; response carries `application/problem+json` and `type: 'about:blank'` for status-only errors.                    |
| `ErrorHandlerOptions.format: 'rfc7807'` | `errorHandler()` → `selectFormatter`            | **Unchanged from today.** Resolves to `rfc7807Formatter`; `application/problem+json` and the status-derived `type`. Deprecated in JSDoc only.    |
| `ValidationPluginOptions.errorFormat`   | `ValidationPlugin` → `validation-middleware.ts` | Gains `'rfc9457'`; `'rfc7807'` retained and resolves to the identical formatter object §3.4, so both spellings produce byte-identical responses. |

No new option is introduced. Both changes widen an existing union.

## 5. Implementation files

| File                                                                  | Purpose                                                                                                                                |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/exceptions/src/formatters/problem-details.ts`               | **New, internal.** `buildProblemDetails(error, ctx, typeOf)` shared core §3.6. Not exported from `index.ts`.                           |
| `packages/exceptions/src/formatters/rfc9457-formatter.ts`             | **New.** `rfc9457Formatter` with the `about:blank` strategy §3.2. Re-exports `ERROR_TYPE_BASE` and `ProblemDetails` as their new home. |
| `packages/exceptions/src/formatters/rfc7807-formatter.ts`             | Reduced to the deprecated `rfc7807Formatter` over the shared core with the status-derived strategy §3.3.                               |
| `packages/exceptions/src/formatters/error-formatter.ts`               | `ErrorFormat` widened; `selectFormatter` gains the `'rfc9457'` case.                                                                   |
| `packages/exceptions/src/middleware/error-handler.ts`                 | Identity check becomes a membership test §3.5; JSDoc and the `PROBLEM_JSON` comment move to RFC 9457.                                  |
| `packages/exceptions/src/index.ts`                                    | Exports `rfc9457Formatter`; keeps the deprecated `rfc7807Formatter`; `ERROR_TYPE_BASE`/`ProblemDetails` re-pointed to the new module.  |
| `packages/validation-plugin/src/formatters/rfc9457-formatter.ts`      | **New.** `rfc9457Formatter`, moved verbatim from the 7807 module (body already 9457-valid, §1).                                        |
| `packages/validation-plugin/src/formatters/rfc7807-formatter.ts`      | Reduced to `export const rfc7807Formatter = rfc9457Formatter` with a `@deprecated` tag §3.4.                                           |
| `packages/validation-plugin/src/formatters/error-formatter.ts`        | `ErrorFormat` widened; selector gains the `'rfc9457'` case.                                                                            |
| `packages/validation-plugin/src/middleware/validation-middleware.ts`  | Identity check becomes a membership test §3.5; comments move to RFC 9457.                                                              |
| `packages/validation-plugin/src/plugin/validation-plugin.ts`          | JSDoc option list and `@example` move to `'rfc9457'`.                                                                                  |
| `packages/validation-plugin/src/index.ts`                             | Exports `rfc9457Formatter` alongside the deprecated alias.                                                                             |
| `packages/starters/{rest,microservice,full-stack}-starter/src/app.ts` | `format: 'rfc7807'` → `'rfc9457'` §3.7.                                                                                                |
| `packages/cli/src/templates/rest.ts`                                  | Prose comments only — no emitted code changes.                                                                                         |
| `scripts/jsr-metadata.ts`                                             | Both package descriptions §3.7.                                                                                                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                | src covered                                                                         | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exceptions/test/unit/problem-details.test.ts` **(new)**                                                 | `src/formatters/problem-details.ts`                                                 | Drives `buildProblemDetails(error, ctx, typeOf)` directly: `instance` present with ctx and omitted without; `errors` copied only when `details.errors` exists; non-`HttpError` maps to 500. Branch coverage of the shared core.                                 |
| `exceptions/test/unit/rfc9457-formatter.test.ts` **(new)**                                               | `src/formatters/rfc9457-formatter.ts`                                               | `about:blank` for `notFound`/`badRequest`/`internalServerError`; `${ERROR_TYPE_BASE}/validation` for `validationError([...])`; §3.6 both-entry-point case asserting all members but `type` identical. Signature: `(Error, IRequestContext?) => ProblemDetails`. |
| `exceptions/test/unit/rfc7807-formatter.test.ts` **(retained)**                                          | `src/formatters/rfc7807-formatter.ts`                                               | Regression: status-derived `type` unchanged for every factory §3.3. Verified to FAIL if the deprecated formatter is repointed at the 9457 strategy.                                                                                                             |
| `exceptions/test/unit/error-formatter.test.ts` **(extended)**                                            | `src/formatters/error-formatter.ts`                                                 | `selectFormatter('rfc9457') === rfc9457Formatter`; `selectFormatter('rfc7807') === rfc7807Formatter`; unknown string still throws `TypeError`.                                                                                                                  |
| `exceptions/test/unit/error-handler.test.ts` **(extended)**                                              | `src/middleware/error-handler.ts`                                                   | §3.5: `format: 'rfc9457'`, `format: rfc9457Formatter` (**by reference**), `format: 'rfc7807'`, and `format: rfc7807Formatter` all yield `application/problem+json`; `'default'` yields `application/json`. Body has no `message`.                               |
| `exceptions/test/integration/error-handler-app.test.ts` **(extended)**                                   | end-to-end through a kernel app                                                     | A real `createApplication` + `inject` route throwing `notFound()` returns a `404` whose body is field-by-field the documented 9457 shape: `type: 'about:blank'`, `title`, `status`, `detail`, `instance`, and **no** `message`.                                 |
| `validation-plugin/test/unit/formatters.test.ts` **(extended)**                                          | `src/formatters/rfc9457-formatter.ts`, `rfc7807-formatter.ts`, `error-formatter.ts` | Reference equality of the alias §3.4; both selector arms resolve to it; `type` remains the validation URI; `errors[]` still `{ field, message, code? }` (pinning the declined scope).                                                                           |
| `validation-plugin/test/unit/validation-middleware.test.ts` **(extended)**                               | `src/middleware/validation-middleware.ts`                                           | §3.5 membership test driven **by reference** for both spellings, asserting `application/problem+json`.                                                                                                                                                          |
| `validation-plugin/test/e2e/validation-application.test.ts` **(updated)**                                | plugin wiring                                                                       | `errorFormat: 'rfc9457'` end-to-end through a kernel app produces the problem+json body.                                                                                                                                                                        |
| `starters/{rest,microservice,full-stack}-starter/test/integration/app-integration.test.ts` **(updated)** | `src/app.ts` ×3                                                                     | The starter's error body now carries `type: 'about:blank'` §3.7.                                                                                                                                                                                                |

Every `src/` file in §5 has a named test file above. No external dependency is involved, so no
guarded real-import test applies — the one such requirement in the CLAUDE.md checklist does not
arise here (checked).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m56-rfc9457-problem-details, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Plus the two publish gates, on a committed tree, since this changes exported surface in two
packages:

```bash
deno task publish:check
deno task release:verify 0.1.0-alpha.5
```

Both new formatter consts need written-out return types (`ProblemDetails`, `FormatValidationErrors`)
— an inferred return type on a barrel export is the slow-type defect that JSR rejects and that only
`publish:check` sees (the M51 precedent).

## 8. Risks & mitigations

- **The by-reference media-type check silently regresses.** Adding a second formatter without §3.5
  produces a Problem Details body under `application/json`, which type-checks, lints, and passes any
  string-keyed test. → Mitigated by tests that drive the formatter **by reference**, not by alias,
  for all four spellings across the two packages.
- **`about:blank` is a breaking wire change for clients matching on `type`.** → Flagged as a
  breaking change in `CHANGELOG.md` with a before/after body, alongside the note that the same field
  moved in `0.1.0-alpha.5` (breaking 4 of 5), so callers pinning it are already on notice. The
  deprecated `'rfc7807'` arm is the documented escape hatch for anyone not ready.
- **`ERROR_TYPE_BASE` becomes dead surface** if `about:blank` were applied unconditionally. → §3.2
  keeps it on a live path via the validation type URI, and §6 pins that with an assertion.
- **The jsr.io description does not change on publish.** `scripts/jsr-metadata.ts` is applied by
  `release:set-metadata`, a separate release step. → Recorded here so a reviewer does not read the
  unchanged live page as a failed deliverable.
- **Two `ErrorFormat` unions with the same name drift apart.** They already differ (C2). → The doc
  deliverable names the owning package at each site rather than implying a shared type.

## 9. Out of scope

- **Realigning the `errors` extension to `{ detail, pointer }`** (RFC 9457 §3's illustrated shape) —
  declined by the maintainer this milestone because `errors[].field` is the most widely consumed
  part of the validation response. If it is ever taken up it is its own milestone with its own
  breaking-change note.
- **Removing the `'rfc7807'` arm and `rfc7807Formatter`.** §9.2 puts removal in the next major; the
  1.0 release owns it.
- **IANA registration of a framework problem type** (§4.2) — a specification submission, not code.
- **User-facing migration documentation.** The getting-started and error-handling guides are
  **M38**'s deliverable; this milestone updates only `PUBLIC_API.md`, `ARCHITECTURE.md`, the root
  `README.md`, both package READMEs, and `CHANGELOG.md`.
