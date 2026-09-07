# Milestone 90e — Static Delivery Correctness (`@setu-ts/static-plugin`)

> **Status:** Complete (PR pending). Branch: `feat/m90e-static-delivery-correctness`. `main` is
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

Two findings, one root shape: the plugin **selects** a representation correctly and then **describes
it wrongly**. X31-1 is High — a `.gz` sidecar is answered with `Content-Encoding: gz`, which is not
a registered content coding, so a standard client decodes **0 bytes** from a `200` that looks fine
in `curl` without `--compressed`. Brotli is correct only by coincidence, because `br` maps to
itself, so every brotli-based check passes and every gzip-only deployment — which is what most build
pipelines emit by default — serves an undecodable bundle to every browser. Measured through a real
nginx `proxy_cache`, a shared cache stores and redistributes the mislabelled variant, so the failure
**outlives an origin fix** until the entry expires. X31-2 is the same family: a cross-variant
`If-None-Match` answers `304`, because the conditional is evaluated against the **original** file
before content negotiation has chosen the representation, which RFC 9110 §13.1.2 requires it to be
compared against.

Neither fix is a new capability. Both are the repo's own "one capability, one implementation" rule
applied to a translation and to an evaluation that each exist twice — the format→token map is
consulted on the request side and re-spelled on the response side, and the conditional is evaluated
once for the original and again for the sidecar. Collapsing each to one is what makes the fix hold.

- **In scope:** X31-1 (all three `Content-Encoding` emission sites), X31-2 (negotiate first, then
  evaluate the conditional once against the selected representation), the shared translation helper,
  a real-bytes decode assertion that a header-token assertion cannot replace, and the doc
  corrections C1–C2 below.
- **NOT this milestone:** Adding a compression format beyond `br`/`gz`, or compressing on the fly —
  the plugin negotiates sidecars a build produced and does not compress, and nothing here changes
  that. `If-Range` and the strong/weak validator split — M55's review settled both and X31 confirms
  they hold. The SPA `fallback`, `cacheControl` resolution and range handling, all checked correct
  in the same run.

## 1. Contracts verified from SOURCE (not names)

| Reference                               | Source (file:line)                                                | Verified surface / fact                                                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the format→token map                    | `static-plugin/src/http/precompressed.ts:22-25`                   | `CONTENT_ENCODINGS = { br: 'br', gz: 'gzip' }`. The `br` entry is an **identity** mapping — which is precisely why a brotli-only assertion cannot fail and the gzip arm rotted.                                                      |
| the map's only current reader           | `static-plugin/src/http/precompressed.ts:87`                      | `const encoding = CONTENT_ENCODINGS[format] ?? format;` inside `isEncodingAcceptable`. **This expression exists exactly once**, on the request side, so the response side re-spells the value rather than sharing it.                |
| the sidecar's own shape                 | `static-plugin/src/http/precompressed.ts:111-113`                 | `findPrecompressedSidecar` resolves `{ path, format, stat } \| null`. `format` is a **file extension** (`'br'`/`'gz'`), never a wire token — so every consumer must translate.                                                       |
| emission site 1 (the sidecar `304`)     | `static-plugin/src/handler/static-handler.ts:295`                 | `response.header('Content-Encoding', sidecar.format);` — the extension, untranslated.                                                                                                                                                |
| emission site 2 and 3                   | `static-plugin/src/handler/static-handler.ts:421,484`             | Both emit `contentEncoding` **verbatim**, so they are correct the moment the argument is. They are not separate defects.                                                                                                             |
| the argument that is wrong              | `static-plugin/src/handler/static-handler.ts:300`                 | `serveCompressedFile(ctx, fs, sidecar.path, sidecarStat, sidecar.format, …)` — the extension passed into a parameter whose own JSDoc (`:342`) calls it "the `Content-Encoding` header value".                                        |
| the only other call site                | `static-plugin/src/handler/static-handler.ts:315`                 | Passes `undefined` for the uncompressed path. So **two** call sites exist and only one needs translating — which is what makes §3.1's boundary fix reach all three emission sites.                                                   |
| the conditional runs before negotiation | `static-plugin/src/handler/static-handler.ts:255-267`             | `shouldReturn304({ etag: true, stat, ifNoneMatch, ifModifiedSince })` against the **original** `stat`, returning `304` — and the sidecar block does not begin until `:270`. This is X31-2's mechanism, stated exactly.               |
| the duplicated second evaluation        | `static-plugin/src/handler/static-handler.ts:287-298`             | "Re-check conditional with sidecar ETag" — a hand-rolled `ifNoneMatch === sidecarEtag \|\| ifNoneMatch === '*'` that does **not** use `shouldReturn304`, so it handles neither a comma list, nor weak tags, nor `If-Modified-Since`. |
| what `shouldReturn304` actually handles | `static-plugin/src/http/conditional.ts:63-90`                     | `*`, comma-separated lists, weak-tag normalisation, then `If-Modified-Since` at whole-second precision. All of it is bypassed by the hand-rolled copy above.                                                                         |
| the ETag per variant is already right   | `static-plugin/src/handler/static-handler.ts:284`                 | `const sidecarEtag = etag ? computeETag(sidecarStat) : undefined;` — so X31-2 is an **ordering** defect, not a validator defect. `PUBLIC_API.md:10918` already documents "ETag from sidecar stat".                                   |
| `Cache-Control` uses the ORIGINAL path  | `static-plugin/src/handler/static-handler.ts:292,301-306`         | Deliberate, with a comment: `app-a1b2c3d4.js.br` never matches the content-hash pattern, so resolving from the sidecar path would drop `immutable`. **This must survive the §3.2 restructure** — it is an M55 review fix.            |
| `Vary` is already emitted everywhere    | `static-plugin/src/handler/static-handler.ts:259,293,412,442,475` | `Vary: Accept-Encoding` at five sites — the `304`, the sidecar `304`, both `206` branches and the `200`. X31 confirms the `304` carries it. Nothing here needs adding.                                                               |
| `inject()` does expose headers          | `kernel/src/application/application.ts:81-90`                     | `InjectResponse` carries `headers: Headers` — but `body` is `string \| null` and a byte body is **UTF-8 decoded**. So a gzip body cannot survive `inject()`, which is why §3.4 requires `app.fetch`.                                 |
| the package can open a socket           | `static-plugin/deno.json` `test.permissions.net`                  | `net: true`. A real-HTTP e2e needs no permission change.                                                                                                                                                                             |
| nothing here is barrel-exported         | `static-plugin/src/index.ts`                                      | `CONTENT_ENCODINGS`, `isEncodingAcceptable`, `findPrecompressedSidecar`, `shouldReturn304` and `computeETag` are **absent** from the barrel — all internal. So §3.1's helper is an internal addition with no `PUBLIC_API` row.       |
| the measured blast radius               | `smoke/X31-FINDINGS.md` (X31-1)                                   | `content-encoding: gz` → `curl --compressed` yields **0 bytes** where 2017 is correct; through a real nginx `proxy_cache`, `X-Cache-Status: HIT` with the same broken variant redistributed.                                         |
| the RFC rule X31-2 cites                | `smoke/X31-FINDINGS.md` (X31-2), RFC 9110 §13.1.2                 | The client's tag is compared against the **selected representation**. With `Accept-Encoding: gzip` the selected representation is the sidecar, whose tag is `"75-…"`; the client sent `"2017-…"`, so `200` is correct.               |
| §16.1 doc rule                          | `AI_GUIDELINES.md` §16.1                                          | A behaviour change to a released response header needs `CHANGELOG.md` in the same PR.                                                                                                                                                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                        | Resolution (picked side)                                                                                                                                                                               | Doc deliverable (same PR)                                                                                                                                                                                           |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `static-plugin/README.md:122` states "The `Content-Encoding` and `Vary: Accept-Encoding` headers are set appropriately." Measured, the gzip arm is set to `gz`, which no client recognises.                     | The README is right about intent and wrong about behaviour, so the **code** moves. The sentence then becomes true — and it is replaced with the two token values rather than the word "appropriately". | README `## Precompressed Sidecars` names the emitted tokens (`br` and `gzip`) explicitly, so a future divergence contradicts a checkable claim rather than an adverb.                                               |
| C2 | `PUBLIC_API.md:10918` documents "Precompressed sidecars: `.br` preferred over `.gz`, ETag from sidecar stat" — accurate about the validator, silent about which validator a conditional request is compared to. | A gap rather than a contradiction. State the rule, since X31-2 shows the silence covered a wrong answer.                                                                                               | `PUBLIC_API.md` static section gains: negotiation precedes conditional evaluation, and `If-None-Match` is compared against the selected representation's ETag. The README conditional-requests note gains the same. |

## 3. Design decisions

### 3.1 One translation, at the boundary, shared with the request side

- **Decision:** export an internal `contentEncodingFor(format: string): string` from
  `http/precompressed.ts`, implemented as `CONTENT_ENCODINGS[format] ?? format`.
  `isEncodingAcceptable` calls it in place of its inline expression, and the handler calls it at the
  **two** sidecar sites (`static-handler.ts:295` and the argument at `:300`). `serveCompressedFile`
  is unchanged: once its argument is a wire token, its own two emission sites (`:421`, `:484`) are
  already correct, and its JSDoc stops being a lie.
- **Why:** X31-1's suggested fix is "emit the translated expression at the three `Content-Encoding`
  sites", which would leave the expression written in **four** places — the exact split that
  produced the defect, since the request side and the response side disagreed about whether
  translation had happened. Translating at the boundary means a sidecar's extension stops existing
  as soon as it becomes a response, so there is one place a future format can be spelled wrongly and
  one place to change when one is added. It also deletes an inline copy rather than adding one
  (§11.1).
- **Test home:** `test/unit/precompressed.test.ts` for the helper itself (both arms, and an unknown
  format falling through), `test/unit/static-handler.test.ts` for the two call sites.

### 3.2 Negotiate first, then evaluate the conditional once, against the selected representation

- **Decision:** the serve path moves sidecar negotiation **above** the conditional block. One
  `selected` descriptor — `{ path, stat, contentEncoding }`, where `contentEncoding` is `undefined`
  for the original — is resolved first; `shouldReturn304` is then called exactly once with
  `selected.stat`; and the `304` emitter is one block that adds `Content-Encoding` when the selected
  representation has one. The hand-rolled `ifNoneMatch === sidecarEtag || ifNoneMatch === '*'` block
  at `:287-298` is **deleted**.
- **Why:** RFC 9110 §13.1.2 compares against the selected representation, and selection is content
  negotiation — so the order in the source is the rule. Evaluating once is also what fixes three
  silent gaps the duplicate carried: it handled no comma-separated list, no weak-tag normalisation
  and no `If-Modified-Since`, all of which `shouldReturn304` already implements
  (`conditional.ts:63-90`). Keeping two evaluators and merely reordering them would leave a sidecar
  request answering `200` for a client that sent a valid list containing the right tag.
- **Test home:** `test/unit/static-handler.test.ts` (the four X31-2 rows, plus a comma-list and a
  weak tag on the sidecar path — the two cases the deleted block could never answer) and
  `test/integration/static-integration.test.ts`.

### 3.3 `Cache-Control` keeps resolving from the ORIGINAL relative path

- **Decision:** the restructure carries `relativePath` (the original, leading-slash, root-relative
  path) through the `selected` descriptor and resolves `Cache-Control` from it on every branch,
  including the `304`.
- **Why:** this is an M55 code-review fix with its reason written at the call site — a hashed asset
  loses `immutable` if the value is resolved from `app-a1b2c3d4.js.br`, because the sidecar name
  never matches the content-hash pattern, and every modern browser sends
  `Accept-Encoding: br, gzip`, so resolving from the served path would make the plugin's headline
  default inoperative in practice. A restructure of this path is exactly where that fix would be
  lost, so it is a decision rather than an assumption.
- **Test home:** `test/unit/review-regressions.test.ts` — the existing case is kept and extended to
  the `304` branch, which the restructure newly routes through the shared emitter.

### 3.4 The X31-1 guard decodes real bytes, and it cannot use `inject()`

- **Decision:** the regression guard boots a real application, requests through `app.fetch`, and
  pipes the body through `DecompressionStream('gzip')`, asserting the decoded length and content.
  The header-token assertion is kept beside it, not instead of it.
- **Why:** `InjectResponse.body` is `string | null` and UTF-8 decodes a byte body
  (`application.ts:87-90`), which destroys gzip bytes — so the one assertion that reproduces the
  finding is unavailable through `inject()`. And a header assertion alone is what the package
  already had in effect: it passes for `br` by identity, which is how this shipped. Decoding is what
  a standard client does, so decoding is what the test does. **Brotli gets the header assertion
  only**, because `DecompressionStream` has no `br` arm — that asymmetry is recorded in the test
  rather than left for a reader to rediscover.
- **Test home:** `test/e2e/static-application.test.ts`.

### 3.5 The gzip-only deployment is the case under test

- **Decision:** the e2e fixture set includes an asset with **only** a `.gz` sidecar, and the gzip
  assertions run against that asset rather than against one carrying both.
- **Why:** X31-1 establishes that with both sidecars present a browser-style `Accept-Encoding`
  selects brotli and takes the working path, hiding the defect — so a fixture carrying both would
  produce a green test over a broken code path. Most build pipelines emit gzip only, brotli being
  opt-in, so this is also the common deployment rather than an edge case.
- **Test home:** `test/e2e/static-application.test.ts`, `test/fixtures/`.

### 3.6 Both changes are behaviour changes to released responses, and are recorded as such

- **Decision:** `CHANGELOG.md` records both under **Fixed** with the observable difference spelled
  out: a gzip sidecar's `Content-Encoding` changes from `gz` to `gzip`, and a cross-variant
  `If-None-Match` changes from `304` to `200`.
- **Why:** the first can invalidate a cached mislabelled variant — an operator running a shared
  cache needs to know a purge is the fast path to recovery, since the entry outlives the origin fix.
  The second changes a status code, and a consumer that had adapted to the wrong `304` sees more
  traffic. Neither is a breaking API change, so neither is a `Changed` entry; both are consequences
  a reader must be able to find.
- **Test home:** none — a doc deliverable, verified by `deno task check:docs`.

## 4. Exported surface — every symbol names its consumer

**No change to `src/index.ts`.** `CONTENT_ENCODINGS`, `isEncodingAcceptable`,
`findPrecompressedSidecar`, `shouldReturn304` and `computeETag` are all internal today (absent from
the barrel), and `contentEncodingFor` joins them as internal. The plugin's public surface —
`StaticPlugin`, `IStaticFiles`, `StaticPluginOptions` — is untouched.

| Exported symbol | Kind | Consumer / real code path that READS it                                                                                                                    |
| --------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None added      | —    | The milestone changes behaviour behind the existing surface; `test/unit/barrel-exports.test.ts` pins that the surface did not move (the M56 defect class). |

### 4.1 Options — every option names its consumer

| Option     | Consumer | Behavior (per implementation)                                                                                                                                                                    |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| None added | —        | `compressed` and `etag` already gate both code paths and neither changes meaning. Adding a "legacy token" opt-out was rejected: `gz` is not a content coding, so no client can be relying on it. |

## 5. Implementation files

| File                                         | Purpose                                                                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/http/precompressed.ts`                  | `contentEncodingFor`; `isEncodingAcceptable` calls it instead of its inline expression.                                                                                            |
| `src/handler/static-handler.ts`              | Negotiation hoisted above the conditional; one `selected` descriptor; one `shouldReturn304` call; one `304` emitter; the duplicate block deleted; the two sidecar sites translate. |
| `README.md`, `PUBLIC_API.md`, `CHANGELOG.md` | C1, C2 and the two Fixed entries.                                                                                                                                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                | src covered                 | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/precompressed.test.ts` (extended)             | `http/precompressed.ts`     | `contentEncodingFor('gz') === 'gzip'`, `contentEncodingFor('br') === 'br'`, an unknown format returns itself; `isEncodingAcceptable` still answers as before for `gzip`, `br;q=0, *`, and a wildcard.                                                                                                                                                                                                           |
| `test/unit/static-handler.test.ts` (extended)            | `handler/static-handler.ts` | The sidecar `200` and the sidecar `304` both emit `gzip` for a `.gz` sidecar (asserted on the **gzip** arm specifically); the X31-2 matrix — plain tag + `Accept-Encoding: gzip` → `200`, sidecar tag + no `Accept-Encoding` → `200`, stale → `200`, `*` → `304`; and the two cases the deleted block could not answer — a comma-separated list containing the sidecar tag → `304`, a weak sidecar tag → `304`. |
| `test/unit/conditional.test.ts` (unchanged)              | `http/conditional.ts`       | Kept as the evaluator's own coverage; the restructure gives it a second caller rather than changing it.                                                                                                                                                                                                                                                                                                         |
| `test/unit/review-regressions.test.ts` (extended)        | `handler/static-handler.ts` | A hashed asset served as a `.br` **and** a `.gz` sidecar keeps `immutable`; the same on the `304` branch, which the restructure newly routes through the shared emitter.                                                                                                                                                                                                                                        |
| `test/integration/static-integration.test.ts` (extended) | `handler/static-handler.ts` | Through a kernel application: the header token on both arms, and the X31-2 cross-variant row.                                                                                                                                                                                                                                                                                                                   |
| `test/e2e/static-application.test.ts` (extended)         | whole serve path            | Against a fixture with **only** a `.gz` sidecar and a browser-style `Accept-Encoding: gzip, deflate, br`: `app.fetch` returns `content-encoding: gzip`, and the body piped through `DecompressionStream('gzip')` decodes to the exact source with the exact byte length. A brotli-only fixture asserts the `br` token (no decode — the stream has no `br` arm).                                                 |
| `test/unit/barrel-exports.test.ts` (unchanged)           | `src/index.ts`              | The public surface did not move.                                                                                                                                                                                                                                                                                                                                                                                |

**Negative controls to run and revert before hand-off**, each observed failing:

1. Revert `contentEncodingFor` at the two sidecar sites → the e2e decode assertion fails with 0
   bytes and the gzip header assertions fail, while every **brotli** assertion still passes. That
   asymmetry is the finding, so seeing it is what proves the suite discriminates.
2. Restore the pre-restructure order (conditional before negotiation) → the cross-variant row fails.
3. Restore the hand-rolled sidecar conditional in place of `shouldReturn304` → the comma-list and
   weak-tag rows fail while the four X31-2 rows still pass.
4. Point the e2e fixture at an asset carrying **both** sidecars → the gzip assertions stop running
   against the gzip path, and the suite goes green with the defect reintroduced. This one must be
   observed **passing**, because it is the trap §3.5 exists to close.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m90e-static-delivery-correctness, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs        # C1/C2 fences and links
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.4.0
```

## 8. Risks & mitigations

- **The §3.2 restructure is the largest edit in a file that already carries two M55 review fixes
  with reasons written at the call site.** Losing one is the realistic failure. Mitigation: §3.3
  makes the `Cache-Control` fix a decision with its own regression test, and
  `review-regressions.test.ts` is extended rather than replaced — the M55 lesson, where 1,123 lines
  of pre-existing coverage were deleted and swapped for new tests.
- **`DecompressionStream('gzip')` availability.** Mitigation: it is web-standard and present in
  Deno; the e2e asserts the decoded length, so a runtime that silently produced nothing fails rather
  than passes. Brotli deliberately gets no decode assertion (§3.4) rather than a fake one.
- **A consumer could be relying on the `gz` token.** Mitigation: no client can be — `gz` is not a
  registered content coding, which is the whole finding — so no opt-out is offered (§4.1) and the
  CHANGELOG states the cache-purge consequence instead.
- **Per-file coverage can drop after deleting the duplicate conditional block**, because its
  branches disappear from a file whose remaining branches are unchanged. Mitigation: read the
  ANSI-stripped per-file table after the deletion, not only after the additions.

## 9. Out of scope

- **On-the-fly compression** — the plugin negotiates sidecars a build produced; compressing here is
  a capability decision, not a correctness fix.
- **A third format (`zstd`)** — `COMPRESSION_FORMATS` is ordered and the map is now read through one
  helper, so adding one is a small change later; nothing in this milestone needs it.
- **Multi-range `206`** — M55 deliberately falls back to `200`, and X31 confirms ranges, `If-Range`
  and the strong/weak validator split behave as documented.
- **The CDN composition itself** — X31's nginx `proxy_cache` leg established the blast radius; a
  committed CDN harness would be an exercise, and the e2e's decode assertion is what a cache would
  have stored.
