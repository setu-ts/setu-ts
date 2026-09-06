# Milestone 90h — Documentation That Survives Contact (docs, `@setu-ts/auth-plugin`, `@setu-ts/database-plugin`, `@setu-ts/session-plugin`, `@setu-ts/secrets-plugin`)

> **Status:** Planning. Branch: `feat/m90h-documentation-that-survives-contact`. `main` is protected
> — all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Five rows where a published claim does not survive being followed. **No package's `src/` changes** —
this is the one letter in M90 that is genuinely documentation, and the ROADMAP is right that it can
ride alongside any of the others. What it is not is a batch of wording tweaks: three of the five
cost a developer real time in the exercises that found them (a 17-error compile after a correct
migration, a `403` on the documented login example, a bootstrap that works on two secret providers
and fails on two), and two of the five are **invisible to every gate this repository has** — a
comment cannot be type-checked, and two documented sections that each compile can still refuse to
compose at runtime. So the deliverable is the correction plus, for each row, the cheapest thing that
would have caught it, which is a test in three cases and a new guide in one.

- **In scope:** X22-4 (the auth README's `// per IP` annotation on an example that is not per IP),
  X26-1 (the decorator migration omits removing `experimentalDecorators` from the reader's own
  project), X26-2 (`IRepository` gained a **required** `findPage` announced nowhere), X33-2 (the
  documented login example cannot run with the documented CSRF option), and X20-3's consequence
  (`ISecretManager.set()` means four different things across five providers and nothing says so).
  Plus a new `docs/upgrading.md` as the durable home for the class of guidance X26-1 needed.
- **NOT this milestone:** X20-3 itself — making `set()` mean one thing is a contract question,
  deliberately ungrouped in the ROADMAP register, and this milestone documents the divergence rather
  than removing it. X32-1's rate-limit behaviour — **M90a**, which is what makes X22-4's corrected
  sentence true. X22-6's session concurrency paragraph — **M90g**, which owns that row. Any change
  to `csrfFormMiddleware`'s verification, which X33-2 explicitly says is the right design (§3.4).

## 1. Contracts verified from SOURCE (not names)

| Reference                                  | Source (file:line)                                                                 | Verified surface / fact                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the false annotation                       | `auth-plugin/README.md:338`                                                        | `app.middleware.add(rateLimitMiddleware({ windowMs: 60_000, max: 100 })); // per IP` — the comment is the only claim; the code carries no key function.                                                                                                                                            |
| what the default key actually resolves to  | `smoke/X32-FINDINGS.md` (X32-1) and `defaultRateLimitKey`'s JSDoc                  | The literal `'anonymous'` for every unauthenticated caller unless `ipSecurityMiddleware` is registered **with `trustProxy`**. The JSDoc says "one GLOBAL counter"; the README says "per IP", three words apart in meaning.                                                                         |
| the required member                        | `database-plugin/src/interfaces/index.ts:157`                                      | `findPage(options: PageOptions): Promise<Page<Entity>>` on `IRepository` — **no `?`**, `@since 0.2.0`, with `@throws {UnsupportedQueryFeatureError}` at `:154`. Any hand-written implementor must supply it.                                                                                       |
| what the CHANGELOG says instead            | `CHANGELOG.md`, M79 entry                                                          | Announces `IDataSource.findPage?(query)` as **optional** — accurate about a different type, and the entry a reader searching `findPage` will find. The sibling `IRepository.findOne` addition **is** announced twice.                                                                              |
| the migration entry that omits the step    | `CHANGELOG.md:1140`                                                                | "**No compiler option is required any more, anywhere.** `experimentalDecorators` is removed from all eight declaration sites …". Every clause names a **framework** site; nothing addresses the reader's own manifest.                                                                             |
| the measured cost of the omission          | `smoke/X26-FINDINGS.md` (X26-1)                                                    | A correctly migrated controller still failed with `TS1238`/`TS1241`; removing one key from the application's own `deno.json` took it from **17 errors to 3**. The errors point at the decorators, not the option.                                                                                  |
| the two sections that do not compose       | `session-plugin/README.md:126` (`## Session fixation`) and `:143` (`## Form CSRF`) | The fixation example is `app.router.post('/login', …)` calling `session.set()`/`session.regenerate()`; composed with `csrf: {}` from the same README it answers `403`.                                                                                                                             |
| the token accessor the fix must name       | `session-plugin/README.md:168`                                                     | `const token = getCsrfToken(ctx); // minted on first call, then stable` — already documented, and already exported (`README.md:252`). The missing piece is the **sequence**, not the API.                                                                                                          |
| why the behaviour must not change          | `smoke/X33-FINDINGS.md` (X33-2)                                                    | "`csrfFormMiddleware` verifies on every method outside `ignoreMethods`, with no notion of an endpoint that establishes the session. That is the right design — an exemption for `/login` would be a hole".                                                                                         |
| `set()`'s four meanings                    | `smoke/X20-FINDINGS.md` (X20-3), probed against real backends                      | Vault (KV v2) and Azure create on write; `AwsKmsProvider.set()` issues `PutSecretValueCommand`, which requires the secret to exist, and there is **no `CreateSecretCommand` anywhere in the provider**; GCP's `addSecretVersion` needs the container to pre-exist; `EnvProvider` throws by design. |
| the fence gate already covers two of these | `test/package-readme-fence-compiler.test.ts:69,71`                                 | `auth-plugin/README.md` (7 fences) and `session-plugin/README.md` (10 fences) are **already** compiled. So both defects here survived a gate that was already watching those files — which is why §3.1 and §3.4 add runtime checks rather than more compilation.                                   |
| what a fence compiler cannot see           | same file, header                                                                  | It compiles fences. X22-4 is a **comment** and X33-2 is a **composition of two fences that each compile**; neither is expressible as a compile error.                                                                                                                                              |
| there is no upgrade guide                  | `ls docs/`                                                                         | Nineteen files, none of them an upgrade or migration-between-versions guide (`migration-nestjs.md` and `migration-fastify.md` are migrations **from another framework**). X26-1's guidance has no home today.                                                                                      |
| the doc gates that will cover a new guide  | `scripts/check-docs.ts`, `deno task check:docs`                                    | Structural package-catalog validation, generated-API-link and cross-file-anchor validation, plus M38's snippet gate and M77's `assert:js` rendered-claim gate.                                                                                                                                     |
| §16.1 doc rule                             | `AI_GUIDELINES.md` §16.1                                                           | A published-surface claim correction ships in the same PR as whatever makes it true.                                                                                                                                                                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

Every row in this milestone **is** a committed-doc conflict, so this table is the milestone rather
than a preamble to it.

| #  | Conflict                                                                                                                                                                           | Resolution (picked side)                                                                                                                                                                        | Doc deliverable (same PR)                                                                                                                      |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `auth-plugin/README.md:338` says `// per IP`; `defaultRateLimitKey`'s JSDoc says one global counter. Both are committed, and they contradict.                                      | The JSDoc is right about behaviour. The README comment is replaced with the real key **and** the remedy, so the surface a developer copies carries the warning the symbol they never open does. | README comment rewritten; a cross-reference added from the README to `ipSecurityMiddleware`'s `trustProxy`.                                    |
| C2 | The CHANGELOG announces `findPage` as **optional** (on `IDataSource`) while `IRepository.findPage` is **required**, and a reader searching the name finds only the first.          | Both are true of different types. Announce the required one the way its own sibling `findOne` was announced, in the release that introduced it.                                                 | A `Changed` note added to the 0.2.0 section naming the required `IRepository.findPage` and the migration, cross-referenced from the M79 entry. |
| C3 | `CHANGELOG.md:1140` states no compiler option is required "anywhere" — true of the framework, false of the reader's own project, and the sentence reads as reassurance.            | The claim is scoped to the framework and should say so, and the reader's action belongs in an upgrade guide rather than buried in a feature entry.                                              | One imperative sentence added to that entry, pointing at the new `docs/upgrading.md`, which carries the full step.                             |
| C4 | `session-plugin/README.md`'s `## Session fixation` and `## Form CSRF` sections are each correct and produce a `403` when composed, which is what a reader following both builds.   | The behaviour is right (an exemption for `/login` would be a hole), so the documentation shows the two-step sequence and the fixation example gains a cross-reference.                          | `## Form CSRF` gains the safe-request-then-mutation sequence; `## Session fixation` gains a line about needing a token when `csrf` is enabled. |
| C5 | `secrets-plugin`'s README and `PUBLIC_API.md` document `set()` as one portable method while it means four different things across five providers, and the error names _not found_. | Document the divergence per provider now; unifying it is X20-3's own question and deliberately ungrouped.                                                                                       | A per-provider `set()`/`rotate()` semantics table in the README and `PUBLIC_API.md`, naming create-on-write, write-only and throws.            |

## 3. Design decisions

### 3.1 The rate-limit comment is replaced by a claim a test pins

- **Decision:** the README line becomes
  `// keyed by authenticated user; every anonymous caller shares ONE bucket unless
  ipSecurityMiddleware is registered with trustProxy`,
  and a new test registers the composition the README **shows** — `rateLimitMiddleware(...)` alone,
  with **no** `ipSecurityMiddleware` — and asserts the resolved key is the literal `'anonymous'` for
  two different client addresses. That is what `defaultRateLimitKey` yields there: with no
  authenticated principal, no `CLIENT_IP_STATE_KEY` (only `ipSecurityMiddleware` publishes one) and
  no `ctx.request.ip` (no first-party adapter can populate it — M23), preference 4 is all that is
  left. The remedy the comment names is deliberately **not** registered; a case that did register it
  would assert per-address keys and would be testing the remedy rather than the claim.
- **Why:** the fence compiler already compiles this README (`fence-compiler:69`) and cannot see a
  comment, so a corrected comment can rot exactly as the original did. The claim underneath it is
  mechanically checkable, and pinning it means the next person to change `defaultRateLimitKey` finds
  a failing test rather than a stale adverb. This is the M77 executable-prose principle applied to a
  behavioural claim rather than an arithmetic one.
- **Test home:** `auth-plugin/test/integration/documented-rate-limit-key.test.ts`.

### 3.2 The required-member class of change gets a permanent in-repo tripwire

- **Decision:** beyond the C2 CHANGELOG note, commit a hand-written `IRepository` implementation —
  one that does **not** extend `BaseRepository` — as a compile-time fixture in
  `database-plugin/test/`, with a comment saying what it is for.
- **Why:** X26-2's own argument is that the project knows this class of change needs an entry, wrote
  one for `findOne`, and did not write one for `findPage`. A convention that depends on remembering
  fails the way this did; a fixture turns "a required member was added to a public interface" into a
  **compile error inside the repository**, at the moment it is added, which no reviewer has to
  notice. The fixture is the only thing here that prevents recurrence rather than describing it.
- **Test home:** `database-plugin/test/unit/repository-implementor-contract.test.ts`.

### 3.3 `docs/upgrading.md` is created, and the CHANGELOG points at it

- **Decision:** a new guide whose scope is "what you must change in **your** project", version by
  version, starting with the `experimentalDecorators` removal and the two required-member additions.
  The CHANGELOG keeps its role — what changed — and gains one imperative sentence per entry that
  demands reader action, linking here.
- **Why:** X26-1's finding is precisely that a CHANGELOG entry written about the framework's own
  sites cannot tell a reader what to do in theirs, and that the phrasing read as reassurance. The
  two documents answer different questions and this repository has only ever had the first, so every
  such step has had to fit inside a feature entry. It also gives M90f's and M90g's status and
  contract changes a home when they land, which is why it is created here rather than when a fourth
  entry needs it.
- **Test home:** `deno task check:docs` (link and anchor validation), plus `docs/README.md` gains
  the entry so the guide is reachable rather than orphaned.

### 3.4 The CSRF fix is a documented sequence, not an exemption

- **Decision:** `## Form CSRF` gains the two-step sequence — a safe request that mints the session
  and its token via `getCsrfToken(ctx)`, then the mutation carrying it in `x-csrf-token` — and a
  runnable integration test drives exactly that sequence against `SessionPlugin({ csrf: {} })`, plus
  the documented `## Session fixation` login in the same application.
- **Why:** the finding is explicit that verifying every unsafe method is the right design and that
  an exemption for `/login` would be a hole. A README sentence alone would leave the same failure
  mode: two sections that each compile and do not compose. The test is what turns "these two
  documented features work together" from a claim into a checked fact — and X33-2 records that this
  exact composition produced a **vacuous pass** in the exercise's own harness, where every attack
  was refused because the victim had never managed to log in. So the test asserts a live session and
  a successful legitimate mutation before asserting anything about refusal.
- **Test home:** `session-plugin/test/integration/documented-csrf-sequence.test.ts`.

### 3.5 The secrets table documents divergence and claims only what was verified

- **Decision:** the table has three columns — provider, `set()` on an existing secret, `set()` on a
  name that does not exist — and each cell is marked verified-against-a-real-backend or not. AWS and
  Vault are verified (LocalStack and a real Vault, per X20); GCP and Azure are **not**, and say so.
- **Why:** the register's own standard: M30b's FCM and M52's Cloudflare rows are labelled unverified
  rather than claimed, and doing otherwise here would replace one wrong claim with another. The
  create-path divergence is the whole finding, so the table's second column is the deliverable and
  the first is context.
- **Test home:** none for the cloud rows — no CI backend exists. `EnvProvider`'s throw is already
  covered and the row cites that test, so the one mechanically checkable cell is checked.

### 3.6 No `src` file changes, and that is asserted

- **Decision:** the PR touches `*.md` files and `test/` files only. A verification step runs
  `git diff --name-only main...HEAD -- 'packages/*/src'` and requires it to be empty.
- **Why:** M90h is the letter that can ride with any other, and it can only do that if it carries no
  behaviour. Stating the invariant as a command makes it checkable at hand-off instead of assumed —
  and if a row turns out to need a `src` change, that is a finding about the row's classification
  and belongs in the plan as a correction, not as a quiet commit.
- **Test home:** §7.

## 4. Exported surface — every symbol names its consumer

**None added, and none changed.** No package's `src/index.ts` is touched. `barrel-exports.test.ts`
in the four affected packages already pins their surfaces and is re-run unchanged (the M56 defect
class).

| Exported symbol | Kind | Consumer / real code path that READS it |
| --------------- | ---- | --------------------------------------- |
| None (checked)  | —    | This milestone adds no code.            |

### 4.1 Options — every option names its consumer

| Option         | Consumer | Behavior (per implementation)                                                                          |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| None (checked) | —        | No option is added, removed or re-defaulted; every row is a claim about behaviour that already exists. |

## 5. Implementation files

| File                                                 | Purpose                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/auth-plugin/README.md`                     | C1 — the comment, and the `trustProxy` cross-reference.                                           |
| `CHANGELOG.md`                                       | C2 — the required `IRepository.findPage` note in the 0.2.0 section; C3 — the imperative sentence. |
| `docs/upgrading.md` (new)                            | C3's durable home; the two required-member additions and the `experimentalDecorators` step.       |
| `docs/README.md`                                     | Indexes the new guide.                                                                            |
| `packages/session-plugin/README.md`                  | C4 — the two-step CSRF sequence and the fixation cross-reference.                                 |
| `packages/secrets-plugin/README.md`, `PUBLIC_API.md` | C5 — the per-provider `set()`/`rotate()` semantics table.                                         |
| `PUBLIC_API.md`                                      | C1, C2 and C4's statements where the corresponding sections live.                                 |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

No `src/` file changes, so the per-file bar is unmoved and every existing suite is re-run as the
regression check. The four new tests exist to keep the corrected claims true rather than to cover
new code.

| Test file                                                                 | src covered             | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-plugin/test/integration/documented-rate-limit-key.test.ts` (new)    | none (claim guard)      | The README's composition — `rateLimitMiddleware` alone, **no** `ipSecurityMiddleware`: two requests from different client addresses share one bucket and the resolved key is `'anonymous'`, so the corrected comment is checked rather than merely written.                   |
| `database-plugin/test/unit/repository-implementor-contract.test.ts` (new) | none (compile tripwire) | A hand-written `IRepository<Row, string>` that does not extend `BaseRepository` and implements every required member; adding a required member to the interface breaks this file at `deno check`.                                                                             |
| `session-plugin/test/integration/documented-csrf-sequence.test.ts` (new)  | none (claim guard)      | With `SessionPlugin({ csrf: {} })`: a bare `POST /login` answers `403`; the documented safe-request-then-mutation sequence answers `200`; the `## Session fixation` example works inside it. Asserts the successful path **first**, so the file cannot pass vacuously (§3.4). |
| `test/package-readme-fence-compiler.test.ts` (unchanged)                  | the two READMEs         | Already covers `auth-plugin` (7 fences) and `session-plugin` (10). Fence counts are updated if an edit adds or removes one — the gate fails loudly on a count change, which is by design.                                                                                     |
| `test/apps-gate.test.ts` (extended)                                       | doc reachability        | `docs/upgrading.md` is indexed in `docs/README.md`, so the new guide cannot be orphaned.                                                                                                                                                                                      |

**Negative controls to run and revert before hand-off**, each observed failing:

1. Restore `// per IP` **and** change the test to expect a per-address key → the new test fails,
   which proves it measures the key rather than restating the comment.
2. Delete `findPage` from the committed hand-written implementor → `deno check` fails naming the
   member, which is the tripwire firing in the direction it exists for.
3. Reorder the CSRF test to attack before establishing a session → the vacuous-pass shape X33-2
   describes reappears, and the added assertions fail.
4. Remove `docs/upgrading.md` from `docs/README.md` → `check:docs` and the apps-gate case fail.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m90h-documentation-that-survives-contact, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # unchanged: no src file moved, so no per-file number should move
deno task check:docs        # link, anchor, catalog and rendered-claim validation
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.4.0

# §3.6's invariant, asserted rather than assumed:
git diff --name-only main...HEAD -- 'packages/*/src' | tee /dev/stderr | wc -l   # MUST be 0
```

## 8. Risks & mitigations

- **Editing an already-published CHANGELOG section (C2, C3) is unusual and could be mistaken for
  rewriting history.** Mitigation: both additions are clarifications to entries that describe
  changes which already shipped, and the v0.3.0 precedent — entries misfiled into a published
  section were moved rather than left — establishes that a published section is corrected when it is
  wrong. Each addition is a marked note rather than a rewrite of the original text.
- **A new guide can go stale faster than a CHANGELOG**, because nothing forces it to be updated.
  Mitigation: `docs/releasing.md` gains a step — a release carrying a reader action adds an
  `upgrading.md` entry — so the guide is maintained by the same runbook that maintains the version
  bump, which is the one process this repository reliably follows.
- **The fence-compiler fence counts are exact numbers**, so a README edit that adds or removes a
  fence fails the gate. Mitigation: that is the gate working; the count is updated in the same
  commit and the change is visible in review, which is why the counts are pinned in the first place.
- **The three claim guards are tests that cover no `src` line**, so they contribute nothing to
  coverage and could be deleted later as dead weight. Mitigation: each file's header states the
  finding it guards and the claim it pins, which is the convention the repository's other guard
  suites already follow.
- **C5 documents a divergence rather than removing it**, so a reader can still write a bootstrap
  that fails on two providers. Mitigation: that is X20-3's own question and is named in §0 and §9 as
  ungrouped, with the table making the failure predictable instead of surprising.

## 9. Out of scope

- **X20-3 itself** — making `ISecretManager.set()` mean one thing across five providers (a create
  path on AWS and GCP, or a separate `create()`), and **X20-4** and **X20-5**: all three are
  deliberately ungrouped in the ROADMAP register.
- **X32-1's rate-limit exclusions and key resolution** — **M90a**, which is what makes C1's
  corrected sentence true; this milestone only stops the README contradicting it.
- **X22-6's session concurrency paragraph** — **M90g**, which owns that row and ships the paragraph
  alongside its own test.
- **Any change to `csrfFormMiddleware`** — X33-2 says the current verification is correct and an
  exemption would be a hole.
- **A generated per-release upgrade note** — `docs/upgrading.md` is hand-written; deriving it from
  the CHANGELOG needs a stable machine-readable entry format, which the prose format does not carry
  (the same blocker the release-notes automation has).
