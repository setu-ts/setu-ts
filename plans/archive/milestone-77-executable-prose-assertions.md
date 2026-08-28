# Milestone 77 — Executable Prose Assertions (`scripts`, `test`)

> **Status:** Complete (PR pending). Branch: `feat/m77-executable-prose-assertions`. `main` is
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

Make a claim about runtime behaviour checkable by a gate, the way a link target and a code fence
already are. The repository gates documentation three ways — `scripts/check-docs.ts` (structural),
`scripts/plan-lint.ts` (structural), and the three fence compilers (type-check committed fixtures) —
and not one of them evaluates a sentence. This milestone adds a fourth gate that reads a claim
stated in a canonical, **rendered** form and evaluates it in a permission-denied subprocess, so a
sentence asserting `Infinity > 0` is `false` fails the build the way a dead link does.

The scope boundary is the tier split the ROADMAP draws. Only **tier 1** — claims decidable by
evaluating a JavaScript expression in a bare runtime — is gated. Tier 2 (live-backend) and tier 3
(platform/toolchain) stay with the guarded real-backend suites and the manual-verification record,
because running them needs a server, `wrangler dev`, or a browser.

- **In scope:** the annotation decision (§3.2); the claim grammar (§3.3); the evaluator and its
  sandbox (§3.4); which documents are scanned (§3.6); the tier-2 routing decision (§3.7); the gate
  script, its wiring into `check:docs`, its coverage target entry, and its test; and seeding the one
  document that carries this milestone's own evidence so the gate is not vacuous.
- **NOT this milestone:** retro-annotating the existing 32 markers across the tree (§9); annotation
  inside `packages/*/src` JSDoc, which the ROADMAP names as a different milestone; compiling
  `PUBLIC_API.md`'s 202 TypeScript fences, which is a fence gate and belongs with the unowned
  documentation-accuracy item recorded beside M77; and the zero-dependency claim audit.

## 1. Contracts verified from SOURCE (not names)

| Reference                      | Source (file:line)                               | Verified surface / fact                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HISTORY_MARKER`               | `scripts/check-docs.ts:1504`                     | `const HISTORY_MARKER = 'version:history'` — a marker spelled **without** comment syntax so one token works in Markdown, YAML, and TypeScript. The precedent this milestone's marker follows.                                 |
| `splitBlocks`                  | `scripts/check-docs.ts:1540`                     | Splits a source on blank lines (and blockquote-only lines) into blocks with first-line numbers. Its JSDoc states the reason: `deno fmt` reflows Markdown prose, so a marker pinned to a line moves off what it exempts.       |
| `collectMarkdown` dotfile skip | `scripts/check-docs.ts:1656`                     | `if (entry.name.startsWith('.')                                                                                                                                                                                               |
| `SCAN_ROOTS`                   | `scripts/check-docs.ts:66`                       | `['.', 'docs', 'packages', 'apps', 'compat']`, with the repo root walked one level deep. `.roo` is absent, and would be skipped by the dotfile rule even if present.                                                          |
| `SCRIPT_TARGETS`               | `scripts/script-coverage.ts:47`                  | Four entries today. The module JSDoc states the parsed row key set MUST equal this set exactly — zero, duplicate, missing, and unknown rows all fail — so adding a script here without a test that imports it fails the gate. |
| `denoCheck`                    | `test/fixtures/snippets/fence-engine.ts:941`     | `new Deno.Command('deno', { args: ['check', ...], stderr: 'piped' })` — the established subprocess shape for a document gate.                                                                                                 |
| AI_GUIDELINES §13.5            | `AI_GUIDELINES.md:787-790`                       | "`eval()` is forbidden. `new Function()` is forbidden." Binding on this gate's own implementation, so evaluation cannot be in-process.                                                                                        |
| `check:docs` task              | `deno.json:54`                                   | Already runs with `--allow-read --allow-run`; appending a third script needs no new permission.                                                                                                                               |
| CI runs `check:docs`           | `.github/workflows/ci.yml:128`                   | `run: deno task check:docs`. Wiring the gate into that task is what makes CI run it.                                                                                                                                          |
| The PR #179 sentence           | `.roo/rules-code-review/01-review-only.md:63-70` | The current, fourth version. Its twelve numeric sub-claims were re-verified mechanically for this plan (§3.1) and all twelve are correct.                                                                                     |
| `deno eval` permissions        | `deno eval --help`, Deno 2.9.5                   | "This command has implicit access to all permissions." It accepts no permission flag. Verified by probe: a bare `deno eval` read `/etc/hostname` successfully.                                                                |
| `deno run` stdin sandbox       | probe, Deno 2.9.5                                | `deno run --no-prompt --ext=ts -` evaluates code from stdin, prints the correct result, and denies `Deno.readTextFileSync` with `NotCapable`.                                                                                 |
| `deno fmt` table stability     | probe on a scratch file                          | Table cells are padded, never wrapped — a 92-character expression cell survived intact past the 100-column line width — and an escaped `\|` inside a cell survives. Prose in the same file reflows.                           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                      | Resolution (picked side)                                                                                                                                                                                                                            | Doc deliverable (same PR)                                                                                                            |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | The ROADMAP's marker table (32 across six locations) is reproducible **only case-insensitively**. A case-sensitive scan of the same four strings answers 27 total and 10 in `packages/*/src`, against the table's 14.                                                         | The table is correct; the convention is case-insensitive in practice, because authors write `Measured:` at the start of a sentence. The gate's own scanning must therefore be case-insensitive, and the plan records the qualifier the table omits. | Add "(case-insensitive)" to the M77 measurement sentence in `ROADMAP.md`.                                                            |
| C2 | The ROADMAP presents "promote the existing parentheticals" as the leading annotation option. Classifying all 14 `packages/*/src` markers by tier (§3.1) gives 11 tier 3, 1 tier 2, and 2 tier 1 — so promoting them yields a gate that can evaluate 2 of 14 of its own input. | Reject promotion as the primary mechanism, with the measurement. The existing parentheticals keep their present meaning as an author-applied provenance note; the gate takes a new marker (§3.2).                                                   | Amend the M77 "Where a design should start" paragraph in `ROADMAP.md` to record the tier classification of the corpus it recommends. |
| C3 | The ROADMAP's own tier-1 example (`deno eval`) is unusable: `deno eval` has implicit access to all permissions and accepts no permission flag, so it evaluates untrusted document text unsandboxed.                                                                           | Use `deno run --no-prompt --ext=ts -` over stdin, which denies I/O and needs no temp file.                                                                                                                                                          | Correct the "a one-line `deno eval`" phrase in the M77 tier list in `ROADMAP.md`.                                                    |
| C4 | `.roo/**` is scanned by no documentation gate — `collectMarkdown` skips every dot-prefixed directory (`check-docs.ts:1656`) and `.roo` is absent from `SCAN_ROOTS`. That is the exact file where PR #179's four consecutive wrong sentences shipped.                          | The new gate scans `.roo/**` explicitly. Extending `check-docs.ts`'s structural checks to `.roo` is deliberately not done here — it surfaces a pre-existing backlog unrelated to this gate.                                                         | Record the `.roo` coverage hole and its narrow closure in the M77 ROADMAP section.                                                   |

## 3. Design decisions

### 3.1 The corpus the gate must serve — measured before choosing a mechanism

- **Decision:** Build for tier-1 claims that are **enumerable as expressions**, and treat the
  existing 32 markers as out of the gate's reach except where they already are that.
- **Why:** The 14 `packages/*/src` markers classify as: 11 tier 3 (npm/Bun/Deno/`protoc`/workerd
  toolchain and platform behaviour), 1 tier 2 (`redis-queue.ts:322`, Redis TTL across `HSET`), and 2
  tier 1 (`database-service.ts:190`, a detached class method reading a `#private` field;
  `storage-plugin/src/interfaces/index.ts:63`, a type-level claim about an excess key in an `'s3'`
  literal). The `ROADMAP.md` markers are almost entirely the section idiom "**The gap, verified from
  source.**", which asserts no mechanical fact at all, and two of the 32 are substring false
  positives (`coverage-measured` in `CLAUDE.md:1289`; the plan-template section name in
  `.roo/rules/02-milestone-architect-mode.md:22`). Meanwhile the document where tier-1 claims
  actually drifted four times in one afternoon carries **zero** markers. So the existing convention
  and the gateable corpus barely intersect.
- **Test home:** `test/prose-assertion-gate.test.ts` — the seeded inventory assertion (§6).

### 3.2 The annotation — a new marker, not the existing parentheticals

- **Decision:** A new marker, the literal token `assert:js`, spelled without comment syntax so one
  token works in Markdown (`<!-- assert:js -->`), YAML (`# assert:js`), and TypeScript
  (`// assert:js`). It marks the block that follows it. This is the `HISTORY_MARKER` shape at
  `check-docs.ts:1504` reused rather than reinvented.
- **Why:** Two reasons, and each alone is sufficient. The existing parentheticals carry **no
  expected value** — "(measured)" states that someone checked, never what the answer was — so there
  is nothing to compare a result against. And per §3.1 they are 79% tier 3, so a gate reading them
  would report "cannot evaluate" for most of its input, which is the shape of gate that gets a
  blanket exemption instead of a fix (`check-docs.ts:1510` records that reasoning for the version
  check).
- **Test home:** `test/prose-assertion-gate.test.ts` — marker recognition across the three comment
  syntaxes.

### 3.3 The claim grammar — a rendered table, so the prose and the check are one artefact

- **Decision:** A marked claim is a **visible Markdown table** with two columns, `Expression` and
  `Value`, each cell a single inline-code span. The gate evaluates the table's own left cell and
  compares against the table's own right cell, parsed as a JSON literal. A pipe inside an expression
  is escaped `\|` and unescaped by the extractor.
- **Why:** The obvious shape — a hidden companion assertion such as
  `<!-- assert: Infinity > 0 === true -->` beside a prose sentence — reintroduces the defect the
  milestone exists to close: two sources of truth, where the sentence drifts and the hidden
  assertion stays green. Putting the claim in **rendered** content means the reader reads exactly
  what the gate evaluates, so there is no second copy to drift. The table shape specifically,
  because `deno fmt` pads table cells and never wraps a row (verified, §1) while it freely reflows
  prose — which is the property that forced `check-docs.ts` to go block-scoped at `:1540`. A table
  row is a stable unit under formatting; a sentence is not.
- **Test home:** `test/prose-assertion-gate.test.ts` — table parsing, `\|` round-trip, and a
  malformed-row rejection.

### 3.4 The evaluator — a permission-denied subprocess reading stdin

- **Decision:** One subprocess per scanned document:
  `new Deno.Command('deno', { args: ['run', '--no-prompt', '--ext=ts', '-'], stdin: 'piped' })`, fed
  a generated program that wraps each expression in its own `try`/`catch` and prints one JSON line
  per claim.
- **Why:** In-process evaluation is unavailable — AI_GUIDELINES §13.5 (`AI_GUIDELINES.md:787-790`)
  forbids `eval()` and `new Function()`, and `CLAUDE.md` records that `deno lint`'s `no-eval` does
  not catch `new Function()`, so the gate must not reach for it. `deno eval` is unavailable for a
  second, independent reason found by probing rather than assuming: its own help says "This command
  has implicit access to all permissions", it accepts no permission flag, and a bare `deno eval`
  read `/etc/hostname` in this repository. Document text is untrusted input to this gate, so it runs
  where `Deno.readTextFileSync` answers `NotCapable` (verified, §1). Stdin rather than a temp file
  keeps the gate at `--allow-read --allow-run` and adds no write permission to `check:docs`.
- **Test home:** `test/prose-assertion-gate.test.ts` — a claim whose expression attempts a file read
  must be reported as failing, not as passing.

### 3.5 Batch failure is reported as failure, never as absence

- **Decision:** The per-document subprocess carries a timeout. A batch that times out, exits
  non-zero, or emits fewer result lines than the document has claims marks **every** claim in that
  document unverified, and unverified fails the gate.
- **Why:** Per-claim isolation inside one process is not achievable against an expression that loops
  forever or calls `Deno.exit()`. Failing closed is the only honest treatment: `check-apps.ts`
  reserves exit 77 for a reported skip precisely so an unavailable prerequisite can never read as a
  pass, and the same principle applies here one level down.
- **Test home:** `test/prose-assertion-gate.test.ts` — a claim calling `Deno.exit(0)` fails the
  document rather than silently passing the claims after it.

### 3.6 Scanned documents — Markdown only, including `.roo`

- **Decision:** Scan Markdown under `['.', 'docs', 'packages', 'apps', 'compat', '.roo']`, the
  `check-docs.ts` set plus `.roo`, with the same one-level-deep rule at the repository root and the
  same `SKIP_DIRS`. TypeScript and YAML are not scanned in this milestone even though the marker is
  spelled to work there.
- **Why:** `.roo` is where PR #179's four wrong sentences shipped and is scanned by nothing today
  (C4). Markdown-only, because the grammar is a rendered table and a JSDoc block has no rendered
  table; extending into `packages/*/src` is annotation-in-source, which the ROADMAP's own scope note
  says is a different milestone. Keeping the marker's spelling language-neutral costs nothing now
  and leaves that door open.
- **Test home:** `test/prose-assertion-gate.test.ts` — the scan set is asserted to include `.roo`,
  with a control confirming the pre-existing `check-docs.ts` walker does not reach it.

### 3.7 Tier-2 routing — deliberately not shipped, with the reason recorded

- **Decision:** No routing marker for tier-2 claims. A live-backend claim stays prose and stays
  guarded by the existing real-backend suites and their CI service containers.
- **Why:** A routing marker checks only that a named path exists, which is a structural check
  wearing a semantic name, and this repository's dead-surface rule asks what real code path reads a
  symbol. There is also no evidence to build on: every documented drift this milestone can cite —
  all four PR #179 corrections — is tier 1, and no tier-2 claim in the tree has been found wrong.
  What would change the answer is a tier-2 claim shipping wrong and a suite existing that would have
  caught it; that is the milestone that should add the marker, with its failing case in hand.
- **Test home:** None (a deliberate non-deliverable). Recorded in §9 and in the ROADMAP amendment.

### 3.8 Seeding — the milestone's own evidence, and nothing else

- **Decision:** Seed exactly one document, `.roo/rules-code-review/01-review-only.md`, by restating
  the numeric-input sentence's enumeration as a marked claim table beside the prose. The summary
  sentence stays. The claim count is pinned in the test, the way the fence gates pin per-file fence
  counts (`test/package-readme-fence-compiler.test.ts:52-56`).
- **Why:** A gate with an empty corpus checks nothing and passes forever, which is the vacuity this
  repository has shipped before. One document is the demonstration, not the sweep that §9 defers.
  This document is the right one because it is the milestone's own evidence and because its twelve
  sub-claims are exactly the tier-1 shape.
- **Test home:** `test/prose-assertion-gate.test.ts` — inventory count, plus the negative control in
  §6.

### 3.9 Wiring — `check:docs`, so CI runs it

- **Decision:** Append the gate to the `check:docs` task in `deno.json:54`, and add
  `scripts/check-prose-assertions.ts` to `SCRIPT_TARGETS` in `scripts/script-coverage.ts:47`.
- **Why:** `check:docs` is what CI runs (`ci.yml:128`), and `test/docs-gate.test.ts` exists because
  "a checker nothing runs would be the same failure one level up". The coverage entry is mandatory
  rather than optional: `script-coverage.ts`'s own module doc states that adding a documentation
  script means adding it there, and that a stale run omitting it must fail rather than pass on the
  scripts it still measured.
- **Test home:** `test/prose-assertion-gate.test.ts` — asserts the task string contains the script
  and that `SCRIPT_TARGETS` contains it.

## 4. Exported surface — every symbol names its consumer

No package `src/index.ts` changes — this milestone ships no package source (§0). The table below is
the script's exported surface, which exists so the decidable logic is unit-testable and therefore
coverage-gated, following the `check-docs.ts` / `docs-gate.test.ts` split.

| Exported symbol                       | Kind     | Consumer / real code path that READS it                                                                                                       |
| ------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `MARKER`                              | const    | `findClaimBlocks` matches against it; the test asserts the three comment spellings resolve to it.                                             |
| `findClaimBlocks(source)`             | fn       | `checkDocument` calls it per file; it is the block-scoping rule of §3.2.                                                                      |
| `parseClaimTable(block)`              | fn       | `checkDocument` calls it on each found block to produce `Claim[]`; owns the `\|` unescape of §3.3.                                            |
| `buildProgram(claims)`                | fn       | `evaluateClaims` pipes its output to the subprocess stdin; kept pure so the generated program is assertable without spawning.                 |
| `parseResults(stdout, expected)`      | fn       | `evaluateClaims` calls it; owns the short-batch rule of §3.5.                                                                                 |
| `compareClaim(claim, result)`         | fn       | `checkDocument` calls it per claim to produce a `Finding`; owns value comparison.                                                             |
| `evaluateClaims(claims)`              | async fn | The thin evaluator I/O seam — spawns the subprocess. Called by `checkDocument`.                                                               |
| `collectMarkdown(root)` / `run(args)` | async fn | `run` is the command-line orchestration seam and calls the walker when no paths are supplied; tests drive both without calling `Deno.exit()`. |
| `SCAN_ROOTS`                          | const    | The gate's own walker reads it; the test asserts `.roo` is a member (§3.6).                                                                   |
| `Claim`, `ClaimResult`, `Finding`     | types    | Parameter and return types of the functions above; read by the test's own annotations.                                                        |

### 4.1 Options — every option names its consumer

| Option                    | Consumer         | Behavior (per implementation)                                                                                                                                  |
| ------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Positional file arguments | `main`           | When present, scans exactly those files instead of `SCAN_ROOTS`; the `check-docs.ts:1692` convention, used by the test to point the gate at fixture documents. |
| `--timeout=<ms>`          | `evaluateClaims` | Per-document subprocess budget of §3.5. Defaults to 10000. The test sets it low to drive the timeout branch deterministically.                                 |

No other option is added. A `--fix` mode is deliberately absent: a wrong claim needs a human to
decide whether the sentence or the code is wrong, and rewriting the sentence to match the runtime
would hide precisely the defect the gate exists to surface.

## 5. Implementation files

| File                                       | Purpose                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/check-prose-assertions.ts`        | The gate. Exports the pure core of §4 plus a thin `main`; prints findings with `file:line` and exits 1 on any failing or unverified claim. |
| `deno.json`                                | `check:docs` task gains the third script (§3.9). No new permission — the task already carries `--allow-read --allow-run`.                  |
| `scripts/script-coverage.ts`               | `SCRIPT_TARGETS` gains `scripts/check-prose-assertions.ts` (§3.9).                                                                         |
| `.roo/rules-code-review/01-review-only.md` | Seeded with the marked claim table for the numeric-input sentence (§3.8).                                                                  |
| `ROADMAP.md`                               | The four C-row corrections, plus the M77 Progress Tracking row flipped to ✅.                                                              |
| `CLAUDE.md`                                | Current-status entry for M77; "Next milestone" repointed.                                                                                  |
| `CHANGELOG.md`                             | Entry under `Unreleased` — tooling only, no package surface changes.                                                                       |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

One test file, mirroring `test/docs-gate.test.ts`: it imports the pure functions (which is what
gives the script coverage rows, without which `script-coverage.ts` fails on a missing target row),
pins the wiring, and carries the negative controls.

| Test file                           | src covered                         | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/prose-assertion-gate.test.ts` | `scripts/check-prose-assertions.ts` | **Marker** — `findClaimBlocks(source: string): ClaimBlock[]` finds the marker in Markdown, YAML, and TypeScript comment spellings, and does not treat an unmarked table as a claim block. **Grammar** — `parseClaimTable(block: ClaimBlock): Claim[]` reads a two-column table, unescapes `\|`, and rejects a row whose cell is not a single inline-code span. **Program** — `buildProgram(claims: readonly Claim[]): string` wraps each expression in its own `try`/`catch` so one throwing claim does not suppress the rest. **Evaluation** — `evaluateClaims(claims, timeoutMs)` returns `false` for `NaN > 1` and `true` for `NaN !== 1`. **Sandbox (§3.4)** — a claim whose expression is `Deno.readTextFileSync('/etc/hostname')` is reported failing with `NotCapable`, never passing. **Fail-closed (§3.5)** — a claim calling `Deno.exit(0)` marks the whole document unverified; a document exceeding `--timeout` does the same. **Inventory (§3.8)** — the seeded document carries exactly the pinned number of claims, so a claim added later cannot slip past unclassified. **Wiring (§3.9)** — the `check:docs` task string in `deno.json` names the script, and `SCRIPT_TARGETS` contains it. **Scan set (§3.6)** — `SCAN_ROOTS` includes `.roo`, with a control asserting `check-docs.ts`'s own walker does not reach it. |

### 6.1 Negative controls — each observed failing, then reverted

The gate's whole claim is that it discriminates, so each control is run and its failure recorded in
the PR, not asserted in the abstract.

1. **The three prior PR #179 sentences.** Restore version 1's claim (`Infinity > 0` is `false`) into
   the seeded table; the gate must fail naming that row. Repeat for version 2 (`NaN != 1` is
   `false`) and version 3 (`-Infinity > -Infinity` is `true`). The current text must pass — verified
   for this plan: all twelve of its sub-claims evaluate as written.
2. **Marker removal.** Delete the marker above the seeded table; the gate must report zero claims
   for that document, and the inventory assertion must fail rather than the gate passing vacuously.
3. **Sandbox removal.** Replace the evaluator's argument list with `['eval', ...]`; the sandbox test
   must flip from a `NotCapable` failure to a passing read.
4. **Coverage-target removal.** Drop the script from `SCRIPT_TARGETS`; `check:script-coverage` must
   fail on an unknown row rather than silently measuring the four it still knows.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m77-executable-prose-assertions, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task check:docs        # the new gate runs here
deno task check:script-coverage
```

Both publish gates are run on the committed tree even though no package changes, because `deno.json`
is edited:

```bash
deno task publish:check
deno task release:verify 0.1.0-alpha.10
```

## 8. Risks & mitigations

- **A gate whose corpus is one document reads as ceremony.** Mitigation: the inventory count is
  pinned and the negative controls are run and recorded, so the gate is demonstrably discriminating
  rather than merely present. Growth is left to the milestones that add claims.
- **Evaluating document text is executing document text.** Mitigation: §3.4's permission-denied
  subprocess, verified to answer `NotCapable`, plus the §3.5 timeout. The gate is not a security
  boundary against a hostile committer — it is protection against an author's expression doing
  something unintended.
- **The table grammar could be read as heavier than a sentence.** Mitigation: it is confined to the
  enumerated claims a sentence summarises; the summary sentence stays, and a claim not worth
  enumerating simply carries no marker.
- **`deno fmt` behaviour could change and start wrapping table rows.** Mitigation: the stability
  property is asserted by the parser itself — a row it cannot parse is a reported finding, not a
  silent skip — so a future formatting change surfaces as a gate failure rather than as claims
  quietly dropping out of the corpus.
- **A claim can be made trivially true.** `1 === 1` passes and asserts nothing. Mitigation: none
  mechanical, and stated rather than papered over — this is the same exposure the fence gates carry,
  where a fence can compile and mean nothing. Review is the control.

## 9. Out of scope

- **Retro-annotating the existing 32 markers.** A sweep rather than a mechanism, and §3.1 shows most
  of them are not tier 1, so most would gain a marker that cannot be evaluated. Unowned.
- **Annotation inside `packages/*/src` JSDoc.** The ROADMAP's own scope note says a `packages/*/src`
  change means the design has drifted into annotation-in-source, which is a different milestone. The
  marker's spelling is language-neutral so that milestone need not redesign it.
- **Tier-2 routing markers.** Decided against in §3.7, with the evidence that would reopen it named.
- **Tier-3 claims** (workerd, browsers, `wrangler dev`). Not mechanizable in this repository; M52d
  and M37c already record these as manually verified, which the ROADMAP calls the right treatment.
- **Compiling `PUBLIC_API.md`'s fences** — 232 fenced blocks, 202 TypeScript, 109 importing
  `@setu-ts/`, measured by M76 with the repository's own `scanFences`. A fence gate, not a prose
  gate; it belongs with the unowned documentation-accuracy items recorded beside M77. Unowned.
- **Extending `check-docs.ts`'s structural checks to `.roo`.** C4 closes the prose-gate hole only;
  the link and heading checks would surface a pre-existing backlog unrelated to this milestone.
  Unowned.
