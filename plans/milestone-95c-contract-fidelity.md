# Milestone 95c — Session (`@setu-ts/session-plugin`), Common (`@setu-ts/common`), Static (`@setu-ts/static-plugin`)

> **Status:** Planning. Branch: `feat/m95c-contract-fidelity`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Three places where a documented contract and the code disagree. Each was found by following the
documentation literally rather than by reading source, which is why all three passed every gate — a
test written from the source agrees with the source.

1. **`csrfTokenField()` ignores the plugin's configured `csrf.fieldName`**, so a form rendered by
   the README's own recipe `403`s on every post.
2. **A structurally malformed multipart part is promoted to a real field named `unknown`**, where
   the platform drops it — and the same sentinel is what the `v0.6.0` release used as its _failure
   signal_, so a nameless part and a header that failed to parse are indistinguishable.
3. **The `cacheControl` callback receives a path that three doc sites describe differently**, and
   the README's own worked example tests a value the callback can never receive.

- **In scope:** the three rows above, their doc corrections, and a guard for each that drives the
  documented entry point rather than the internal one.
- **NOT this milestone:** M95a owns the generated deployment that cannot start (the only High); M95b
  owns Service Bus reachability. No capability token is added and no plugin gains a new
  registration.

## 1. Contracts verified from SOURCE (not names)

Rows marked **measured** were reproduced on this machine on Deno 2.9.6. R5–R8 are four divergences
between our multipart parser and the platform, of which the ROADMAP recorded one — and R6/R7 are why
§3.4 is two changes rather than the one the ROADMAP names.

| Reference                                                    | Source (file:line)                                                                                                     | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 the helper resolves its OWN options                       | `packages/session-plugin/src/csrf/token.ts:100-107`                                                                    | `csrfTokenField(ctx, options = {})` calls `resolveCsrfConfig(options)`. With no second argument that yields the shared default `'_csrf'`, independent of anything the plugin was configured with.                                                                                                                                                                                                                                                                                               |
| R2 the verifier reads the PLUGIN's config                    | `packages/session-plugin/src/csrf/verify.ts:103-123`, `middleware/csrf-form-middleware.ts:51-53`                       | `csrfFormMiddleware(options)` resolves ONCE at registration and passes that `ResolvedCsrfConfig` into `verifyWithConfig`, which reads `config.fieldName` from the form. Two resolutions of one setting, from two different inputs.                                                                                                                                                                                                                                                              |
| R3 the plugin passes its block to the middleware             | `packages/session-plugin/src/plugin/session-plugin.ts:125-128`                                                         | `ctx.middleware.add(csrfFormMiddleware(options.csrf), …)`. The plugin's `csrf` block reaches the verifier and reaches nothing else — there is no published resolved config the helper could read.                                                                                                                                                                                                                                                                                               |
| R4 the state-key convention is gated                         | `test/state-key-convention.test.ts:68-96`                                                                              | A declaration-scanning test requires every `*_STATE_KEY` constant to be `<existing-package>:<kebab-key>`. It scans declarations rather than an import list, so a new key is covered with no edit to the gate.                                                                                                                                                                                                                                                                                   |
| R5 platform drops a nameless part                            | **measured**                                                                                                           | `Response.formData()` on a part whose `Content-Disposition` carries no `name` returns only the sibling legitimate field. Ours returns BOTH, the nameless one under `unknown` — `["unknown=ORPHAN","unknown=legit"]` against the platform's `["unknown=legit"]`. The ROADMAP's recorded case.                                                                                                                                                                                                    |
| R6 platform ACCEPTS an unquoted `name`                       | **measured**                                                                                                           | `name=x` (no quotes) yields the field `x` on the platform; ours yields `unknown`, because the regex requires `name="…"`. **So the name is lost, not merely mislabelled** — and a fix that only drops nameless parts would DELETE this field instead.                                                                                                                                                                                                                                            |
| R7 platform accepts an unquoted `filename`                   | **measured**                                                                                                           | `name="f"; filename=a.txt` is delivered as a **File** by the platform and as a plain text field by ours, so `getUploadedFile()` finds nothing for an upload the client did send.                                                                                                                                                                                                                                                                                                                |
| R8 platform drops an EMPTY name                              | **measured**                                                                                                           | `name=""` yields no entry at all on the platform; ours yields a field whose name is the empty string. So "no usable name" means absent **and** empty, which the ROADMAP did not record.                                                                                                                                                                                                                                                                                                         |
| R9 unquoted-token semantics                                  | **measured**                                                                                                           | The unquoted value runs to the next `;` or end of line and is then trimmed (`name=hello world` → `hello world`; `name=x` → `x`; `name=x;` → `x`). The PARAMETER name is case-sensitive (`NAME=x` yields nothing) while the header FIELD name is not (`content-disposition` works).                                                                                                                                                                                                              |
| R10 the sentinel's other job                                 | `packages/common/src/form/multipart-parser.ts:135-146`                                                                 | The parser's own JSDoc uses `'unknown'` as the recorded _failure signal_ for the case-insensitivity defect `v0.6.0` fixed: "the part arrived under the name `'unknown'`". One string means both "malformed" and a legitimate field name.                                                                                                                                                                                                                                                        |
| R11 the parser stays internal                                | `packages/common/src/index.ts:130-133`                                                                                 | The barrel exports `formEncodingOf`, `parseFormBody`, `FormBody`, `FormEncoding`, `FormFile`, `FormValue`. `parseMultipart` and `ParsedPart` are NOT exported, so §3.3 changes no published symbol.                                                                                                                                                                                                                                                                                             |
| R12 the only consumers                                       | `packages/common/src/form/form-body.ts:212,263`; `packages/storage-plugin/src/middleware/upload-middleware.ts:182-192` | `parseMultipart` feeds `multipartForm`, which builds the `FormBody` every `IRequest.formData?()` producer returns; the upload middleware reads that `FormBody` via `getAll(fieldname).filter(isFormFile)`. So §3.3's blast radius is exactly these two paths.                                                                                                                                                                                                                                   |
| R18 the runtimes DISAGREE, so the platform is not one oracle | **measured** (Node 24.18.0, same five inputs as R5-R9)                                                                 | Node's native `Response.formData()` **throws** `Failed to parse body as FormData.` for a nameless part and for an unparseable disposition, where Deno drops the part and keeps its siblings; it **preserves** `name=""` where Deno drops it; and it matches the parameter name **case-insensitively** (`NAME=x` → `x`) where Deno does not. Three of five inputs differ, including the two §3.4 turns on — so a Deno-only parity test would silently pin one runtime's choices as the contract. |
| R13 the callback receives the FULL path                      | **measured** (real handler, fake fs)                                                                                   | Five requests, five observed values. `urlPrefix: '/assets'`: `/assets/app-A9acsx54.js` → `/assets/app-A9acsx54.js`; `/assets` → `/assets/index.html`; `/assets/` → `/assets/index.html`. Root-mounted: `/app-A9acsx54.js` → `/app-A9acsx54.js`; `/` → `/index.html`.                                                                                                                                                                                                                            |
| R14 the callback NEVER receives `'/'`                        | **measured**; `packages/static-plugin/src/handler/static-handler.ts:149,190,207`                                       | `rootRelative` is `'/'` only for a directory request, and a directory is served by resolving the index, so the callback is handed `/index.html`. **In every configuration, root-mounted included** — stronger than the ROADMAP's "unreachable under any non-root prefix".                                                                                                                                                                                                                       |
| R15 the code asserts the prefixed form is the contract       | `packages/static-plugin/src/handler/static-handler.ts:109-114`                                                         | `callbackPath` exists specifically to prepend the prefix, under a comment reading "per the documented contract (`/assets/app.js`, never the prefix-stripped `/app.js`)". The behaviour is deliberate, not an oversight.                                                                                                                                                                                                                                                                         |
| R16 the README agrees with the code, then contradicts itself | `packages/static-plugin/README.md:96-99`                                                                               | Same paragraph: "`/assets/app-A9acsx54.js` for a file under the prefix above" (matches R13) AND "the literal `'/'` when the request equals the prefix root" (falsified by R14). Its example at `:90-91` tests `path === '/'`.                                                                                                                                                                                                                                                                   |
| R17 the other two doc sites                                  | `packages/static-plugin/src/http/cache-control.ts:49-59`; `PUBLIC_API.md:11586`                                        | The type's JSDoc says "the leading-slash root-relative request path (e.g. `/assets/app-A9acsx54.js`)" — its prose and its example disagree about whether the prefix is included; the parameter is named `relativePath`; PUBLIC_API repeats the wording.                                                                                                                                                                                                                                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                         | Resolution (picked side)                                                                                                                                                                                                                                                                                | Doc deliverable (same PR)                                                                                                                             |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `packages/session-plugin/README.md:186-188` documents the WORKAROUND: use the helper bare, and "when your `SessionPlugin` configuration customizes `csrf.fieldName`, pass the same name". §3.1 removes the need. | The workaround sentence is struck. Passing the name stays SUPPORTED as an explicit override (for a standalone `csrfFormMiddleware` on a different name), but it stops being required.                                                                                                                   | `packages/session-plugin/README.md` and `PUBLIC_API.md:3345-3360` — the helper defaults to the plugin's configured name; the argument is an override. |
| C2 | The multipart parser's JSDoc (R10) uses `'unknown'` as a failure signal while the code emits it as a real field name.                                                                                            | The sentinel is removed entirely (§3.4), so the string stops having two jobs. The JSDoc keeps the historical record and is reworded to describe the old failure rather than to name a value the parser can still produce.                                                                               | `packages/common/src/form/multipart-parser.ts` JSDoc.                                                                                                 |
| C3 | Three sites describe the `cacheControl` path as "root-relative" and name the parameter `relativePath`, while R13/R15 show it is the full request path including `urlPrefix`, deliberately.                       | **The behaviour is correct and stays.** A cache policy is about the URL the client caches under, so the served path is the right input; and stripping the prefix would silently break every existing callback that matches on it (AI_GUIDELINES §9.4). The DOCS and the parameter NAME are what change. | `packages/static-plugin/README.md`, `src/http/cache-control.ts` (JSDoc + parameter renamed `requestPath`), `PUBLIC_API.md:11586`.                     |
| C4 | `packages/static-plugin/README.md:90-91` tests `path === '/'`, which R14 measures as unreachable in every configuration — so the published example's first branch is dead code.                                  | The example is replaced with one whose branches are reachable, and the sentence claiming the callback receives `'/'` is struck and replaced with what a directory request actually delivers.                                                                                                            | `packages/static-plugin/README.md` example and prose.                                                                                                 |

## 3. Design decisions

### 3.1 The middleware publishes its resolved CSRF config; the helper reads it

- **Decision:** `csrfFormMiddleware` writes its already-resolved `ResolvedCsrfConfig` into
  `ctx.state` under a new exported `CSRF_CONFIG_STATE_KEY = 'session-plugin:csrf-config'`, and
  `csrfTokenField` reads it. Precedence is: an explicit `options.fieldName` argument wins, then the
  published config, then the `'_csrf'` default.
- **Why:** this is the repo's own rule — _one capability, one implementation; every entry point
  honours the same config_ — whose worked example is `validateBody` ignoring the configured
  `errorFormat`. The middleware is the right publisher because it already holds the resolution (R2),
  it is where the plugin's block arrives (R3), and it is registerable standalone, so the helper
  works on both paths. Reading from `ISessionService` was rejected: the service holds no CSRF
  configuration, and adding it there would give one setting two homes, which is the defect restated.
- **Test home:** `packages/session-plugin/test/integration/csrf-field-name.test.ts` — the rule's own
  prescribed guard, driving BOTH entry points under a non-default `fieldName`.

### 3.2 The config is published BEFORE the ignore-methods branch

- **Decision:** the write happens at the top of the middleware, before the `ignoreMethods` and
  `exclude` short-circuits.
- **Why:** the helper is called on the **GET** that renders the form, and `GET` is in
  `DEFAULT_IGNORE_METHODS`, so a write placed after that branch would never be visible to the one
  request that needs it. This is the whole fix, and it is the arm most likely to be written the
  other way round.
- **Test home:** the same integration suite renders the form on a GET, which is the path that fails
  if the write moves.

### 3.3 The helper keeps working with no middleware registered

- **Decision:** with no published config in `ctx.state`, `csrfTokenField` falls back to
  `resolveCsrfConfig(options)` exactly as today. No throw, no new error class.
- **Why:** `verifyCsrfToken` is exported for standalone use (a React Router action), so a valid
  application can mint a token on a request the middleware never saw. Throwing would convert a
  working configuration into a startup-time surprise to fix a naming mismatch that does not exist
  there.
- **Test home:** a unit case rendering the field on a context with no published config, asserting
  today's output byte-for-byte.

### 3.4 Multipart: accept the unquoted parameter form FIRST, then drop a part with no usable name

- **Decision:** two changes, landing together. (a) `parseHeaders` accepts the unquoted token form
  for both `name` and `filename` — value to the next `;` or line end, then trimmed, with the
  parameter NAME matched **case-insensitively**. (b) A part whose resulting `name` is **absent** is
  DROPPED rather than renamed; `name=""` is KEPT as a legitimate empty-named field.

  Both halves of that differ from the first draft, and R18 is why: **the runtimes disagree**, so
  "match the platform" is not a contract. The normative table is stated here and the parity test
  asserts these literals rather than whatever the host runtime happens to do:

  | input                   | our contract          | Deno 2.9.6   | Node 24.18.0          |
  | ----------------------- | --------------------- | ------------ | --------------------- |
  | `name="x"`              | field `x`             | field `x`    | field `x`             |
  | unquoted `name=x`       | field `x`             | field `x`    | field `x`             |
  | uppercase `NAME=x`      | field `x`             | part dropped | field `x`             |
  | `name=""`               | field `` (empty name) | part dropped | field `` (empty)      |
  | no `name` parameter     | part dropped          | part dropped | **whole body throws** |
  | unparseable disposition | part dropped          | part dropped | **whole body throws** |

  Each divergence is decided against silent data loss, which is this milestone's own thesis.
  Case-insensitive matching follows RFC 2183 header-parameter semantics and Node, and it only ever
  turns a part that would be dropped into one that is delivered. `name=""` is kept because Node
  keeps it, an empty name carries no collision risk (it can only collide with another empty name,
  which is the same field), and dropping it discards data the client deliberately sent. A nameless
  or unparseable part is dropped rather than made fatal, because Node's throw destroys every
  legitimate field in the body — and M94b already fixed the framework's own position here, recording
  that an unparseable multipart body yields an empty form rather than a throw.
- **Why:** (b) alone is a regression. R6 measures that an unquoted `name=x` currently arrives as
  `unknown`; dropping nameless parts without (a) would turn a wrongly-named field into a **silently
  deleted** one, which is worse than the defect being fixed and is exactly the shape of failure this
  milestone exists to remove. R7 adds that the same gap demotes a real upload to a text field. (a)
  and (b) together satisfy the normative table above on every row.
- **Test home:** `packages/common/test/unit/form/multipart-platform-parity.test.ts` — a table run
  through BOTH our parser and the platform's `Response.formData()`, asserting they agree.

### 3.5 The sentinel is removed, not replaced

- **Decision:** no replacement sentinel, and no unrepresentable name. A part with no usable name
  produces no entry at all.
- **Why:** the ROADMAP offers keeping a sentinel "unrepresentable as a real field name" as an
  alternative; it is rejected because nothing reads it. R12 shows the only consumers are
  `multipartForm` and the upload middleware's `getAll(fieldname)`, neither of which can act on a
  malformed part — so a sentinel would be dead surface with the collision risk merely made rarer.
  Neither runtime emits a sentinel (R18): they drop the part or refuse the body, and no platform
  invents a field name.
- **Test home:** the parity table above includes the collision case from R5 and asserts the field
  count, so a reintroduced sentinel fails by arithmetic.

### 3.6 Static: the documentation changes, the behaviour does not

- **Decision:** the `cacheControl` callback keeps receiving the full request path. The parameter is
  renamed `requestPath` in `CacheControlOptions` and `resolveCacheControl`, the three doc sites are
  corrected to say "the full leading-slash request path, including `urlPrefix`", and the README's
  dead `'/'` example is replaced.
- **Why:** C3. The served path is the correct input for a cache policy, the behaviour is deliberate
  (R15), and stripping the prefix would silently change what every existing callback matches — §9.4,
  and M70n already shipped this parameter's shape as a breaking change once. Practical impact of the
  doc defect is narrow, as the ROADMAP notes: `endsWith('.html')` still works and the shipped
  content-hash default still matches, because the hash survives the prefix. Renaming the parameter
  is what stops the misreading recurring, since `relativePath` is the half that actually misleads.
- **Test home:** `packages/static-plugin/test/unit/cache-control-path.test.ts` — a table asserting
  the exact string the callback receives for each of R13's five cases, so the documented value and
  the delivered value are pinned together.

### 3.7 The README examples become fence-compiled evidence

- **Decision:** the corrected static and session README examples are covered by the existing
  package-README fence compiler (`test/package-readme-fence-compiler.test.ts`).
- **Why:** M70i folded READMEs into that gate and immediately found four uncompilable fences. A
  corrected example that no gate compiles is the next drift. The fence compiler cannot see a
  _value_, so §3.6's table is what checks the claim; the fence compiler checks the example still
  compiles.
- **Test home:** the existing gate, with both READMEs in its list.

## 4. Exported surface — every symbol names its consumer

| Exported symbol         | Kind            | Consumer / real code path that READS it                                                                                                                                                                                                                                             |
| ----------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSRF_CONFIG_STATE_KEY` | const           | Written by `csrfFormMiddleware` (`middleware/csrf-form-middleware.ts`), read by `csrfTokenField` (`csrf/token.ts`). Exported because two modules in the package share it and because R4's gate reads declared keys; an application may also read it to render its own field markup. |
| `CacheControlOptions`   | type (existing) | Unchanged shape; its callback parameter is RENAMED `requestPath`. A parameter name is not part of the type's assignability, so no consumer breaks.                                                                                                                                  |

**No other barrel changes.** `parseMultipart` and `ParsedPart` stay internal (R11), so §3.4 alters
no published symbol in `@setu-ts/common`. Each of the three changed packages carries a
`barrel-exports` assertion (the M56 defect class, where dropping an export left 18 other tests
green).

### 4.1 Options — every option names its consumer

| Option                                              | Consumer                                      | Behavior (per implementation)                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `csrfTokenField(ctx, { fieldName })` (existing)     | `csrf/token.ts`                               | Now an OVERRIDE rather than the only source. Supplied → wins. Omitted → the published plugin config (§3.1). Neither → `'_csrf'` (§3.3).             |
| `SessionPlugin({ csrf: { fieldName } })` (existing) | `csrf-form-middleware.ts`, and now the helper | One resolution, two readers. This is the whole point of the row.                                                                                    |
| `StaticPlugin({ cacheControl })` (existing)         | `http/cache-control.ts`                       | Unchanged behaviour. The callback receives the full request path including `urlPrefix`, now documented as such and with the parameter named for it. |

No new option is introduced. A switch to restore the `unknown` sentinel, or to strip the static
prefix, would each be a way to ask for the defect back.

## 5. Implementation files

| File                                                                                     | Purpose                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/session-plugin/src/index.ts`                                                   | Adds `CSRF_CONFIG_STATE_KEY` (§4).                                                                                                                                                                                               |
| `packages/session-plugin/src/middleware/csrf-form-middleware.ts`                         | Publishes the resolved config before the short-circuits (§3.1, §3.2).                                                                                                                                                            |
| `packages/session-plugin/src/csrf/token.ts`                                              | `csrfTokenField` precedence (§3.1) and the no-middleware fallback (§3.3).                                                                                                                                                        |
| `packages/common/src/index.ts`                                                           | Unchanged — the parser stays internal (R11).                                                                                                                                                                                     |
| `packages/common/src/form/multipart-parser.ts`                                           | Unquoted parameter form, drop on no usable name, sentinel removed (§3.4, §3.5); C2 JSDoc.                                                                                                                                        |
| `packages/static-plugin/src/index.ts`                                                    | Unchanged.                                                                                                                                                                                                                       |
| `packages/static-plugin/src/http/cache-control.ts`                                       | Parameter renamed `requestPath`; JSDoc corrected (§3.6).                                                                                                                                                                         |
| `packages/static-plugin/src/handler/static-handler.ts`                                   | The `callbackPath` comment updated to cite the corrected docs; no behaviour change.                                                                                                                                              |
| `packages/session-plugin/README.md`, `packages/static-plugin/README.md`, `PUBLIC_API.md` | C1, C3, C4.                                                                                                                                                                                                                      |
| `CHANGELOG.md`                                                                           | The two multipart behaviour changes, and `csrfTokenField` defaulting to the plugin's configured `fieldName` — NOT a change to the `'_csrf'` default itself, which §3.3 keeps as the no-middleware fallback. With migration text. |
| `docs/upgrading.md`                                                                      | The reader-side action for the multipart change, filed under `Unreleased` (the M90h attribution rule).                                                                                                                           |
| `ROADMAP.md`                                                                             | The M95c status flip, in this same PR.                                                                                                                                                                                           |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                | src covered                                           | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/session-plugin/test/integration/csrf-field-name.test.ts` (new) | `csrf/token.ts`, `middleware/csrf-form-middleware.ts` | Through a REAL kernel app with `SessionPlugin({ secret, csrf: { fieldName: 'xsrf' } })`: the GET renders `name="xsrf"`; a POST under the rendered name → `200`; a POST under `_csrf` → `403`. Repeated with default config, where both names behave as they do today — so the check discriminates rather than passing on the default. Calls type-check against `csrfTokenField(ctx: IRequestContext, options?: Pick<CsrfFormOptions,'fieldName'>): string`.                                                                                                                                                                                                                        |
| `packages/session-plugin/test/unit/csrf-token-field.test.ts` (extended)  | `csrf/token.ts`                                       | Explicit argument beats the published config; no published config falls back to `'_csrf'` (§3.3) with byte-identical output to today; the rendered attribute is escaped exactly as before.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/common/test/unit/form/multipart-platform-parity.test.ts` (new) | `form/multipart-parser.ts`                            | One table asserting `parseMultipart(body, contentType)` against the **literal expected values of §3.4's normative table**, not against whatever the host runtime returns — R18 measures the runtimes disagreeing on three of six rows, so a host-as-oracle test would pin Deno's choices and read as a contract. Rows: nameless part beside a legitimate `unknown` field (R5), unquoted `name=x` (R6), unquoted `filename` (R7), `name=""` (R8), uppercase `NAME=x` (R18), unquoted-token trimming (R9). The file additionally records each runtime's own answer as a comment beside the row it diverges on, so a future reader can see the choice was made rather than inherited. |
| `packages/common/test/unit/form/form-body.test.ts` (extended)            | `form/form-body.ts`                                   | `parseFormBody` over the R5 collision body yields ONE `unknown` entry, not two — the arithmetic check that §3.5 relies on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/storage-plugin/test/unit/upload-middleware.test.ts` (extended) | `middleware/upload-middleware.ts`                     | An unquoted-`filename` part is now delivered by `getUploadedFile()` (R7), and a nameless part carrying a filename is NOT delivered under any field (R5). Drives the middleware, which is R12's second consumer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/static-plugin/test/unit/cache-control-path.test.ts` (new)      | `handler/static-handler.ts`, `http/cache-control.ts`  | The exact string the callback receives for each R13 case, including both directory forms and the root mount. Pins R14 — the callback never receives `'/'` — so the corrected README sentence is checked rather than reviewed.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/package-readme-fence-compiler.test.ts` (existing)                  | both corrected READMEs                                | §3.7 — the replaced examples compile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test/state-key-convention.test.ts` (existing, no edit)                  | the new state key                                     | R4 — its declaration scan covers `CSRF_CONFIG_STATE_KEY` with no change to the gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Coverage.** Three `src` files gain branches (`csrf/token.ts`, `csrf-form-middleware.ts`,
`multipart-parser.ts`); every new arm is reachable from a documented entry point, so the tables
above take each to the per-file bar. `cache-control.ts` and `static-handler.ts` gain no branch — a
rename and comments only — so their existing numbers must not move, which is itself checked by
re-reading the per-file table after the change.

**Negative controls** (each observed failing, then reverted, and the result recorded in the PR):

1. Revert §3.1 → the integration suite's custom-`fieldName` POST fails `403`, reproducing the
   finding, while the default-config case still passes — proving the check discriminates.
2. Move §3.2's write below the `ignoreMethods` branch → the GET renders `_csrf` and the same POST
   fails, proving the placement is load-bearing.
3. Apply §3.4(b) WITHOUT §3.4(a) → the parity table fails on R6 and R7, proving the two-change
   decision rather than asserting it.
4. Reintroduce the `unknown` sentinel → the `form-body` arithmetic case fails with two entries.
5. Strip `urlPrefix` in `callbackPath` → the static path table fails on the prefixed cases, pinning
   C3's chosen side so a later "fix the docs by fixing the code" reads this decision first.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m95c-contract-fidelity, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task check:docs        # README / PUBLIC_API / CHANGELOG / upgrading edits
deno task publish:check     # committed tree
deno task release:verify 0.6.0
```

## 8. Risks & mitigations

- **§3.4 is a behaviour change to form parsing, which sits under authentication.** A part that used
  to arrive as `unknown` now arrives under its real name or not at all. Mitigation: the platform is
  the normative table in §3.4, decided against silent data loss where the runtimes disagree (R18)
  and recorded row by row; both consumers (R12) are driven directly; and CHANGELOG plus
  `docs/upgrading.md` carry the reader-side action rather than leaving it to discovery.
- **An application may be relying on the `unknown` field.** It can only have been relying on
  receiving a part the platform discards, which no correct client sends. Mitigation: stated in the
  CHANGELOG as a behaviour change rather than filed under a fix, so an upgrading reader meets it.
- **Accepting the unquoted form could admit something the platform refuses.** Mitigation: R9 pins
  the exact semantics — trimming, terminator, and the case-sensitivity asymmetry — and the parity
  table asserts agreement rather than asserting our own rule.
- **§3.1 adds a second reader of `ctx.state` in the request path.** Mitigation: it is one `get` on a
  key the middleware already wrote, on the render path only; the verifier is untouched and keeps
  reading its registration-time resolution (R2), so the hot path does not change.
- **C3 leaves a documented-behaviour mismatch that some readers will still expect to be a code
  fix.** Mitigation: the decision, its §9.4 reason and the rejected alternative are recorded in the
  plan and in the JSDoc, and negative control 5 makes the chosen side fail loudly if reversed.

## 9. Out of scope

- **Streaming multipart.** `mapWebRequestToFrameworkRequest` buffers the body and `IRequest` exposes
  no body stream; M70k recorded that limit and it is unchanged here.
- **Multi-value `Content-Disposition` extended parameters** (`filename*=UTF-8''…`, RFC 5987). Not a
  `v0.6.0` finding, not measured, and admitting it without measurement is the mistake this plan's §1
  exists to prevent.
- **Making `cacheControl` receive the prefix-stripped path.** Decided against in C3/§3.6 with its
  reason, so its absence reads as a decision rather than an oversight.
- **A second CSRF cookie or a stateless synchronizer token.** M48 chose the session-backed strategy
  deliberately; this row is about one setting having one resolution.
- **M95a** (the generated deployment that cannot start) and **M95b** (Service Bus reachability) —
  separate letters, separate branches.
