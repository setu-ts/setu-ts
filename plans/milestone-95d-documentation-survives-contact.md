# Milestone 95d — Documentation That Survives Contact (`docs/`, `@setu-ts/common`, `@setu-ts/view-plugin`, `scripts/`)

> **Status:** Planning. Branch: `feat/m95d-documentation-survives-contact`. `main` is protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Four findings from the `v0.6.0` Part 11 exercise run (`smoke/X46-X51-FINDINGS.md`) where **the code
is correct and a reader following the documentation still ends up wrong**. That is the M90h shape,
and this letter holds it to M90h's standard: a claim is corrected where it is made, and where a gate
could have caught it the gate is extended rather than the claim reworded.

> **On the version literals in this letter** (PR #309 finding 6): `v0.5.0` and `v0.6.0` name a
> historical boundary — the releases these findings were produced against — not a moving target. The
> repository's convention for text a version bump must not rewrite is the `version:history` marker
> `check-docs.ts` already honours, and the ROADMAP's Part 11 paragraph carries the same literals for
> the same reason. Both are records of what was run, so a bump that rewrote them would make them
> false; they are deliberately not parameterised.

1. **A user-supplied `javascript:` URL survives escaping and executes** — `docs/mvc.md`'s otherwise
   thorough §Escaping builds the belief that JSX makes user data safe in a view, and that belief is
   false for a URL attribute. Demonstrated in real Chrome 152.
2. **`docs/mvc.md` never mentions error pages**, so M92 (the view capability) and M94a (the
   `respond` hook) shipped in the same release and were never joined.
3. **No worked example of `respond` exists anywhere**, and its natural spelling serves `200` for
   every error.
4. **Six `@since` tags in `packages/common/src/form/` name `0.5.0`**, a release that does not
   contain the module.

**Two of the four want gate work, and this is the only M95 letter that carries any.** Row 1's gate
already exists and structurally cannot see the defect; row 4's does not exist at all, and a manual
sweep for exactly that class has already been run once and missed this module.

- **In scope:** the four rows above, the two gate extensions, and the six tag corrections. No
  behaviour changes in any package; `packages/*/src` gains no logic.
- **NOT this milestone:** M95a owns the generated deployment that cannot start; M95b owns
  reachability that fails open; M95c owns the five contract-fidelity rows. **A URL-sanitising helper
  is explicitly not built here** — see §3.1. The `view-plugin` README's published `0.6.0` example is
  already fixed on `main` and belongs in the `0.6.1` release notes as an advisory, per the M95
  umbrella.

## 1. Contracts verified from SOURCE (not names)

| Reference                                         | Source (file:line)                                                                        | Verified surface / fact                                                                                                                                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 the behaviour gate's only payload              | `scripts/check-example-behaviour.ts:28`                                                   | `export const HOSTILE = '<script>alert(1)</script>'`. One payload, substituted into every documented component's props. Escaping neutralises it correctly, so a URL-scheme defect passes the gate — the check is not weak, it is aimed elsewhere. |
| D2 the claim that gate backs                      | `docs/mvc.md` §Escaping, closing paragraph                                                | "This is checked, not just asserted", naming `scripts/check-example-behaviour.ts`. True of what it checks; the finding is what it cannot reach.                                                                                                   |
| D3 `docs/mvc.md` has no error-page section        | `docs/mvc.md` headings                                                                    | Registering the engine · functional entry point · class-based entry point · Forms · Rendered output is buffered · Layouts · by-name engine · Escaping · Health · More. No error page, no `errorHandler`, no `respond`.                            |
| D4 the guide already teaches status-before-render | `docs/mvc.md:156`                                                                         | `ctx.response.status(422); // unprocessable — and the page IS the error report`. The technique row 3 needs is already demonstrated in the guide, in a different context — it needs connecting, not inventing.                                     |
| D5 `respond` owns its status, documented once     | `packages/exceptions/README.md:48`                                                        | "the callback owns that result's status, headers, and body." The contract is stated and correct; nothing demonstrates it.                                                                                                                         |
| D6 no worked example exists                       | `grep -rn 'respond(' docs/*.md packages/*/README.md PUBLIC_API.md`                        | Returns the options-table row and three unrelated `messaging-plugin` hits for broker `respond()`. No code fence anywhere calls the hook.                                                                                                          |
| D7 `renderView` takes no status                   | `packages/view-plugin` — `renderView(ctx, component, props)`                              | Three parameters, no status. So the statement row 3 is about has no natural place inside the call a reader writes, which is why omitting it is the default outcome rather than a slip.                                                            |
| D8 CSP has no default                             | `packages/http-security-plugin/src/middleware/security-headers-middleware.ts:171`         | "Content-Security-Policy (no default — only when explicitly configured)". So the recommended composition ships no mitigation for row 1.                                                                                                           |
| D9 the guide steers toward `'unsafe-inline'`      | `docs/mvc.md` §"An inline `<script>` must use `raw()`"                                    | Teaches inline script blocks for `EventSource`/`WebSocket` from a rendered page. Measured: `script-src 'self'` blocks the payload, `script-src 'self' 'unsafe-inline'` does not — so the guide's two sections compose into the unprotected case.  |
| D10 the form module is new in `0.6.0`             | `https://jsr.io/@setu-ts/common/0.5.0/src/form/form-body.ts` → **404**; `0.6.0` → **200** | Probed against the registry, not inferred from the changelog. `0.5.0`'s published manifest lists no `/src/form/` file at all.                                                                                                                     |
| D11 six tags claim `0.5.0`                        | `packages/common/src/form/` — `grep -rho '@since [0-9.]*'`                                | Six `@since 0.5.0`, one `@since 0.6.0`, covering `FormEncoding`, `FormFile`, `FormValue` and `FormBody`.                                                                                                                                          |
| D12 this class already had a dedicated fix        | PR #286, merged (`fix/since-tags-unreleased-surface`)                                     | Corrected 26 such tags across view-plugin, `IViewEngine`, `@Render` and the M93a recorder, naming the cause as systematic: a release branch bumps each manifest, so an author reading `@since` from it is wrong every time.                       |
| D13 why that fix missed this module               | the same branch's tree                                                                    | It carries no `packages/common/src/form/` — the branch was cut before M94b landed. The sweep was correct and simply could not see a module that did not exist yet.                                                                                |
| D14 nothing gates `@since`                        | `grep -rln '@since' scripts/*.ts`                                                         | Returns nothing. No script compares a `@since` tag to the version that shipped the symbol, which is why D12's manual sweep is the only control and D13 is how it failed.                                                                          |
| D15 React neutralises the same payload            | `react-dom/server` `renderToStaticMarkup`, probed                                         | Emits `href="javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')"`. So row 1 is a difference BETWEEN rendering runtimes, not a property of JSX — which is what makes it worth documenting.                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| Conflict                                                                                                                   | Resolution (this plan's decision)                                                                                                                                            | Deliverable                                               |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| C1 §Escaping's safety story is complete for HTML structure and silent on URL schemes, while closing with "This is checked" | State the boundary explicitly: escaping protects structure, not schemes. Keep the "this is checked" sentence and make it true for the new case by extending the gate (§3.2). | `docs/mvc.md` §Escaping; `packages/view-plugin/README.md` |
| C2 §"An inline `<script>` must use `raw()`" steers toward a CSP that disables the row-1 mitigation                         | Cross-reference the two sections so the trade-off is visible where the advice is given, rather than leaving them to compose silently.                                        | `docs/mvc.md`, both sections                              |
| C3 `docs/mvc.md` documents a complete server-rendered application and never mentions its error page                        | Add the section; state the rule in one sentence and name what it leaves uncovered.                                                                                           | `docs/mvc.md` (new §Error pages)                          |
| C4 `packages/exceptions/README.md:48` states the status contract with no example                                           | Add the worked example carrying `ctx.response.status(error.statusCode)`.                                                                                                     | `packages/exceptions/README.md`                           |
| C5 six `@since` tags name a release that does not contain the module                                                       | Correct them to `0.6.0`, and gate the class (§3.4) since D12/D13 show a manual sweep does not hold.                                                                          | `packages/common/src/form/*`; `scripts/`                  |

## 3. Design decisions

### 3.1 Row 1 is documentation plus a gate — NOT a sanitising helper

The tempting fix is a `safeUrl()` helper in `view-plugin`. It is rejected, and the reason is the
package's own design: **the view plugin holds no escaping logic at all** — escaping belongs to the
rendering runtime, which is the property that lets one engine serve both authoring arms and makes
the capability Workers-portable. A helper would put a security-relevant transform in the one package
that deliberately has none, and it would be opt-in, so a reader who does not know about the hazard
would not reach for it — which is precisely the reader this finding is about.

What actually reaches that reader is the documentation they are already following, plus a gate that
fails the repository's own examples if one ever renders a hostile scheme. An application-side rule
(validate the scheme before it reaches the view) is what the docs will prescribe.

### 3.2 The behaviour gate substitutes a URL payload into URL-valued props

`scripts/check-example-behaviour.ts` gains a second payload beside `HOSTILE` (D1):
`javascript:alert(1)`. It is substituted into props whose rendered position is a URL attribute, and
the gate fails if the rendered output carries the scheme in an `href`, `src` or `action`.

**The hard part is knowing which props are URL-valued, and the plan picks the honest answer rather
than the clever one:** do not infer it from the prop name. Substitute the URL payload into **every**
prop, and assert on the OUTPUT — a rendered `href="javascript:…"` fails regardless of which prop fed
it. That needs no per-component knowledge, cannot drift as components change, and catches a
component that routes a differently-named prop into an attribute.

**Two blind spots are inherited from the existing props model and must be stated, not discovered**
(corrected after review, PR #309 finding 9). The probe builds props as a `Proxy` over `[HOSTILE]`
whose `get` returns the proxy for any key (`check-example-behaviour.ts:395-406`), and it stubs
`raw()` to a benign `'<!--raw-->'` marker (`:412`) so the documented opt-out does not report itself
as a defect. Consequently: a component that routes a URL through **`raw()`** renders the marker, not
the payload; and **`{...props}`** spreads the proxy's array-backed own keys rather than named props,
so `<a {...props} />` produces no `href`. Both limits apply to the existing `HOSTILE` check exactly
as they do to the new URL payload — this row inherits them rather than introducing them — and the
gate's claim is scoped accordingly: it proves a component that interpolates a prop into a URL
attribute directly, and proves nothing about one that launders it through `raw()` or a spread.
Widening the props model is a change to the existing gate's core and is named here rather than
smuggled in.

A documented example that deliberately demonstrates the hazard is handled the way the existing gate
already handles one: `COUNTER_EXAMPLE_MARKERS` (`check-example-behaviour.ts:48`) is
`['UNSAFE', 'DO
NOT USE']`, and a component carrying one of them is checked in the OTHER direction —
so a warning that stopped being true fails rather than quietly misinforming. The URL payload reuses
that machinery rather than adding a second convention.

### 3.3 The error-page section states the rule, then what it leaves uncovered

The rule is one sentence: **`respond` covers what `errorHandler` catches; every M70f responder
terminal is outside it.** The section then names what that leaves uncovered in a browser-facing
application, because the rule alone does not make the consequence visible: a mistyped URL (`404`), a
logged-out user (`401`), an unconfigured authorization service (`501`), a stale form (`403`) and a
throttled client (`429`).

**This is a documentation row, not a behaviour one, and the plan says so plainly.** The measured 9×2
matrix in `smoke/X46-X51-FINDINGS.md` confirms the split is exactly what both
`packages/exceptions/README.md` and the `v0.6.0` CHANGELOG describe. Nothing about the framework's
behaviour is wrong; the consequences are simply not discoverable from the guide a reader is
following.

The worked example carries `ctx.response.status(error.statusCode)` on its own line, since D7 shows
`renderView` gives that statement nowhere else to live, and D4 shows the guide already teaches the
technique two sections earlier.

### 3.4 The `@since` gate compares the tag to the version that shipped the SYMBOL

A new `scripts/check-since-tags.ts`, run from `check:docs`.

**It scans every published package, and the glob is the part to get right** (corrected after review,
PR #309 finding 12). `packages/*/src` **misses the three starters**, which live at
`packages/starters/*/src` — so a "repository-wide audit" would have silently skipped a whole package
family. The scan derives its roots from the workspace member list in the root `deno.json`, which is
the one place that already knows every published package and cannot drift as packages are added.

**The check is symbol-level, not file-level** (corrected after review, PR #309 finding 4). The first
draft resolved only whether the containing FILE existed at the claimed version, and deliberately
said so — but that misses the commonest drift by construction: a symbol added to a long-lived file
passes with any `@since` at all, and `packages/common/src/http.ts` has accumulated members across a
dozen releases. For each `@since X.Y.Z`, the gate fetches that file at that version from the
registry and fails when the exported name is absent from it. A file that does not exist at the
version fails the same way, so D10's case is still covered as the degenerate one.

**The registry is queried once per (package, version) pair**, not once per tag, and the result is
cached for the run. An unpublished version — a tag ahead of the registry, the normal state on a
release branch — is skipped rather than failed, so the gate cannot block a release PR.

**Offline behaviour cannot be exit 77 here, and the first draft was wrong about it** (corrected
after review, PR #309 finding 5). `check:docs` is an `&&` chain of `deno run` invocations, so ANY
non-zero status fails the task — exit 77 included. `check-apps.ts` gets away with the convention
because it _handles_ the code itself; nothing handles it inside an `&&` chain, so a transient
registry outage would fail the documentation job and block release PRs. Instead the gate **reports
the skip on stderr and exits 0**, and — so that silence is never mistaken for a pass — it prints the
number of tags it verified on every run, which is zero when it skipped. `test/docs-gate.test.ts`
asserts a skipped run says so.

### 3.5 Row 4's six tags are corrected in the same change as the gate

Correcting the tags without the gate repeats D12 — a manual sweep that held until the next module
landed. Shipping the gate without the tags would fail the build on the first run. Both go together,
and the gate is verified to fail on the pre-correction tree (§6).

## 4. Exported surface — every symbol names its consumer

**None (checked).** No package's `src/index.ts` changes, no symbol is added, removed, or re-typed,
and no capability token is touched. `scripts/check-since-tags.ts` is a repository gate, not a
published module — `scripts/` is outside every package's export map.

A `barrel-exports` assertion is therefore not added; the existing ones in `common` and `view-plugin`
already pin those surfaces, and this plan's §7 verifies the barrels are byte-identical instead.

### 4.1 Options — every option names its consumer

**None (checked).** No plugin option is added or changed. The only new configuration is
`check:docs`'s composition of one more script, which takes no arguments.

## 5. Implementation files

| File                                 | Purpose                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `docs/mvc.md`                        | C1 (URL schemes in §Escaping), C2 (the inline-`<script>` cross-reference), C3 (the new §Error pages with its example). |
| `packages/view-plugin/README.md`     | C1 — the same boundary, stated where a reader of the package lands.                                                    |
| `packages/exceptions/README.md`      | C4 — the worked `respond` example carrying the status line.                                                            |
| `packages/common/src/form/*.ts`      | C5 — six `@since 0.5.0` → `0.6.0` (D11). JSDoc only; no logic.                                                         |
| `scripts/check-example-behaviour.ts` | §3.2 — the URL payload and the output-side assertion.                                                                  |
| `scripts/check-since-tags.ts` (new)  | §3.4 — the tag-versus-registry gate.                                                                                   |
| `deno.json`                          | `check:docs` composes the new script.                                                                                  |
| `scripts/script-coverage.ts`         | The new script joins `SCRIPT_TARGETS`, per the M38 precedent for documentation scripts.                                |
| `PUBLIC_API.md`                      | The `respond` status contract gains its example; no surface change.                                                    |
| `CHANGELOG.md`                       | An `Unreleased` entry covering the four rows and both gates.                                                           |
| `ROADMAP.md`                         | The M95d status flip, in this same PR.                                                                                 |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

No `packages/*/src` logic changes, so the per-file bar applies to the two scripts rather than to a
package. `scripts/script-coverage.ts` enforces ≥90% branch/function/line on both, which is the M38
arrangement for documentation tooling.

| Test file                                              | Covered                              | Key assertions                                                                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/check-since-tags.test.ts` (new)             | `scripts/check-since-tags.ts`        | A tag naming a version whose tarball lacks the file FAILS; a tag naming one that has it passes; a version ahead of the registry is SKIPPED, not failed; a network error SKIPS with a reason and a non-zero-is-not-pass exit. |
| `test/unit/check-example-behaviour.test.ts` (extended) | `scripts/check-example-behaviour.ts` | A component rendering a prop into `href` FAILS under the URL payload; one rendering the same prop as a text child passes; an `UNSAFE`-labelled component is still checked in the other direction (§3.2).                     |
| `test/docs-gate.test.ts` (extended)                    | CI wiring                            | Pins that `check:docs` composes both scripts, so dropping one is a failing test rather than a silent loss of coverage.                                                                                                       |
| The doc fences themselves                              | `docs/mvc.md`, both READMEs          | The new error-page example and the corrected escaping examples are fence-compiled by the existing guide and package-README gates, so they type-check as committed evidence.                                                  |

**Negative controls** (each observed failing, then reverted, and the result recorded in the PR):

1. Revert the six `@since` corrections → `check:since-tags` fails naming `packages/common/src/form/`
   and the version. This is the control that proves the gate would have caught D12/D13.
2. Revert §3.2's URL payload → the new behaviour case passes with a component that renders
   `href="javascript:alert(1)"`, reproducing exactly why the existing gate could not see row 1.
3. Point `check:since-tags` at a version ahead of the registry → it SKIPS rather than failing,
   proving a release branch cannot be blocked by it.
4. Remove the new error-page section's status line from its example → the fence still compiles,
   which is the honest result: it records that no gate can catch row 3, and that the example IS the
   control.

## 7. Verification gates

1. `deno task fmt:check`, `deno task lint`, `deno task check`, `deno task test` — all four.
2. `deno task check:docs` — now including both gates; the fences in the new sections must compile.
3. `deno task check:plan` — this plan lints clean.
4. `deno task test:coverage` — the per-file table read ANSI-stripped; both scripts ≥90% on branch,
   function and line.
5. `deno task publish:check` and `deno task release:verify <version>` on a COMMITTED tree — no
   package surface moves, so both must be green with no new findings.
6. **The barrels are byte-identical.** `git diff -- 'packages/*/src/index.ts'` must be empty, which
   is §4's claim stated as a command.
7. **No package logic changed**, and this is a CHECK rather than a report (corrected after review,
   PR #309 finding 7). The first draft used `git diff --stat`, which prints and always exits 0, so a
   stray source edit would have passed every listed gate. The letter's only `packages/*/src` change
   is JSDoc — six `@since` values — so the gate is:
   `git diff -U0 origin/main...HEAD -- 'packages/*/src'` must contain no added or removed line
   outside a comment. Implemented as a step in the PR checklist and verified by inspection, NOT as a
   new repo task: a general docs-only task would have to be correct for every future milestone,
   which is a larger design than this letter needs and would be dead surface for all three other M95
   letters.

## 8. Risks & mitigations

| Risk                                                                                                                 | Mitigation                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `@since` gate reaches the network from `check:docs`, which other gates do not                                    | §3.4's skip-with-reason on an unreachable registry, plus a per-version cache. The gate never blocks on a version the registry has not seen, which is the release-branch case.                             |
| Substituting a URL payload into EVERY prop produces false failures on a component that legitimately renders a scheme | §3.2 asserts on the rendered output, and the existing `UNSAFE`-label convention is the documented opt-out. A component that must demonstrate the hazard says so in its own comment.                       |
| Row 1's documentation lands and nobody changes their application                                                     | Accepted and stated: this letter's scope is the belief the docs create. A framework-side refusal would be a `view-plugin` behaviour change, which §3.1 rejects with cause and does not defer to a letter. |
| The error-page section drifts from the behaviour it describes                                                        | The rule it states is one sentence and is already pinned by `packages/exceptions`' own tests; the example is fence-compiled. Neither can silently stop matching.                                          |

## 9. Out of scope

- **A URL-sanitising helper or a scheme allowlist in `view-plugin`** — §3.1, rejected with cause,
  not deferred.
- **Changing what `respond` covers.** The uncovered set is the documented rule and is correct;
  widening it would be a behaviour change to a published contract and belongs to its own milestone
  if it is ever wanted.
- **A default CSP in `http-security-plugin`** (D8). Turning one on by default would break every
  application that does not expect it; the documentation names it as the defence in depth instead.
- **Auditing `@since` across every package.** The gate does that mechanically once it exists; this
  letter corrects the six tags the run found and ships the gate. Whatever else the gate reports on
  its first full run is triaged from its output, not predicted here.
- M95a (the generated deployment), M95b (reachability), M95c (contract fidelity) own their own rows.
