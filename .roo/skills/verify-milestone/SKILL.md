---
name: verify-milestone
description: Verify a completed milestone's changes end-to-end — gates, ANSI-stripped per-file coverage, forbidden-construct grep, contract fidelity against common/PUBLIC_API, a real behavioral exercise of the new code, and tracking-table checks. Use when asked to verify, review, or audit a milestone (or its feat/… branch) before the PR merges.
---

# Verify Milestone

Independently verify that a milestone's changes actually do what they claim. Passing gates is
necessary but NOT sufficient — this skill exists because green gates have shipped real bugs. The
canonical policy lives in `/CLAUDE.md` ("Verification", "Common pitfalls", "Self-review checklist",
"Before reporting a task done") — read those sections first and treat them as the source of truth;
this file is the step-by-step procedure.

**Verdict rule: every step below produces evidence. No evidence → the step is not done → the
milestone is NOT verified. Never report "verified" from the gates' exit codes alone.

## Instructions

# Step 1 — Orient

```bash
git branch --show-current      # must be the milestone's feat/… branch, never main
git log --oneline main..HEAD   # the milestone's commits
git diff --stat main..HEAD     # the changed files — this is your review scope
git status --short             # MUST be empty — see the clean-tree rule below
```

**Verify the COMMITTED code, never a dirty working tree.** If `git status --short` is not empty,
someone (a reviewer, a half-finished fix, another agent) has modified the tree, and an uncommitted
change can MASK the very bug you are hunting — a broken default silently patched in the tree passes
every probe, then ships broken because the patch was never committed. Before running anything: paste
`git status --short`; if it is non-empty, `git stash -u`, run the ENTIRE verification against the
clean commit, then `git stash pop`. State in the report which commit hash you verified
(`git rev-parse HEAD`). A verification run against a dirty tree is void.

Then read, in order:

1. `ROADMAP.md` — the milestone's section (objective, feature list, implementation files,
   deliverables). Every listed file and feature must exist in the diff. **Write out the deliverable
   list now** — Step 6 requires a behavioral observation for each entry; a deliverable you cannot
   observe running is not delivered, no matter what the checkbox says.
2. **The milestone's plan under `plans/`** — the design decisions and test-file table are
   commitments, not suggestions. Diff the plan against the implementation: every design decision
   must exist in code (grep for its mechanism, read it), every planned test file must exist, and
   every deviation goes in the report as a finding. M10 shipped "✅" with the plan's data-source
   implementations, transaction-scoped repositories, and two whole test files silently missing — the
   plan was right and nothing checked the code against it.
3. `PUBLIC_API.md` — the section for this package. Every `src/index.ts` export must be documented
   there; every documented export must exist.
4. `packages/common/src/` — the committed interface(s) this package implements. The implementation
   must match the contract exactly (same methods, same throws-behavior, same semantics) — not a
   widened or re-declared version.

# Step 2 — Run the gates

```bash
deno task fmt:check && deno task lint && deno task check && deno task test
```

All four must pass. Record the test count. A failure here ends the review: report it, do not
continue to "partial verification".

# Step 3 — Per-file coverage (the gate will NOT do this for you)

`deno task test:coverage` exits 0 even with a file under the bar, and its output is colorized. Strip
ANSI and read the per-file table yourself:

```bash
deno task test:coverage 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "<package>|File|---"
```

Every file under the package's `src/` must be **≥90% on branch, function, AND line** — all three,
per file, not aggregate. Files under `test/` (fixtures) are excluded from the bar. A file at exactly
90 has no margin — flag it. Paste the table in the report.

# Step 4 — Grep for what the gates can't catch

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/<pkg>/src
```

Must be empty (comments excepted). `Date.now()` outside `packages/runtime` is clock-mixing;
`globalThis.__` is a fake lazy import; the rest are §13.5 / no-`any` violations `deno lint` misses.
Paste the (empty) result.

# Step 5 — Contract & claims review (read the code, not just the diff)

Check each item and note where it holds or fails:

- **Interface fidelity** — the implementation satisfies the `common` contract's documented semantics
  (e.g. "@throws if already registered" actually throws).
- **Token ↔ interface binding** — services registered/resolved via `CAPABILITIES` tokens are typed
  as that token's documented interface; no resolve-one-cast-to-another.
- **Every option has an OBSERVABLE effect, not just a read.** The grep ("name appears beyond
  declaration and assignment") is only the first half — an option can be "read" inside a method that
  unconditionally throws or a branch that never executes (M10's `logQueries` greps as consumed; it
  never logged a single repository operation). The check is behavioral: flip the option in Step 6
  and observe the surface change (a log line appears, an error format switches). No observable
  difference = dead option = FAIL.
- **Both entry points, one implementation** — if a behavior is reachable two ways (service method +
  helper), confirm a test drives BOTH under a NON-default configuration.
- **Spec-shaped output field-by-field** — anything claiming RFC 7807 / NestJS / OpenAPI shape has a
  test asserting required fields PRESENT and forbidden fields ABSENT.
- **Short-circuit tests** — any chain/dispatch mechanism has an explicit test that a stage
  responding without `next()` stops downstream stages.
- **No plugin imports another plugin** — cross-plugin needs go through
  `ctx.services.get<T>(CAPABILITIES.X)`.
- **Docs match behavior** — every JSDoc/PUBLIC_API claim you can point at a code path for, actually
  executes that path ("lazily imported via npm:x" must really `import()`).
- **Fixtures honor the real contract** — cross-check fixture values against how the real producer
  sets them (e.g. monotonic `hrtime()` vs epoch `Date.now()`). For a fixture standing in for an
  external dependency, verify every method/shape the fixture implements EXISTS in the dependency's
  current major version (check its docs or types, not memory): M10's fake Prisma client implemented
  an invented `$use({name, query})` — real `@prisma/client` v6+ has no `$use` at all, so tests
  passed while real apps crashed at startup.
- **Per-request hoisting** — patterns parsed / chains compiled at registration, not per request.
- **Tracking flipped in this PR** — ROADMAP.md "Progress Tracking" row is ✅ and CLAUDE.md "Current
  status" marks the milestone complete and points "Next milestone" at the following one, on this
  branch.

# Step 6 — Behavioral exercise (run the real code at its real surface)

Tests can be wrong together with the code — M10's tests asserted no-op behavior and passed at 90%+
coverage. Write a scratch driver in a hidden dir INSIDE the repo (workspace imports only resolve
from inside it; e.g. `.verify-<milestone>/driver.ts`, deleted afterwards) and drive the package
through its REAL surface — a kernel application, not import-and-call:

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { XxxPlugin } from '@hono-enterprise/xxx-plugin';
const app = createApplication({ plugins: [RuntimePlugin(), XxxPlugin(/* opts */)] });
app.router.post('/probe', async (ctx) => {/* exercise the service via ctx.services */});
await app.start();
const res = await app.inject({ method: 'POST', url: 'http://localhost/probe', body: {...} });
// NOTE: ctx.request has NO .body — use `await ctx.request.json<T>()`.
```

Run with `deno run -A .verify-<milestone>/driver.ts` (it does NOT type-check — cross-check contract
shapes in `packages/common/src/` by reading them). **Paste BOTH the driver source AND its raw stdout
verbatim** into the report — not a hand-written "✓ works" summary. A summarized probe result is
worthless: it cannot be distinguished from a probe that never ran, asserted nothing, or was written
to pass. The raw `res.json()` / `res.body` output must be visible so the failure modes below are
impossible to paper over.

**Production defaults, never the test-only seam.** If a component has an injectable seam that tests
use (a `clock`, a fake client, an in-memory stand-in), your behavioral probe must construct it with
PRODUCTION DEFAULTS so the real default path executes — the exact path the unit tests bypass. The
memory cache's default clock (`?? performance.now`) threw `Illegal invocation` on every write in
production; every unit test injected a fake `clock`, so 100%-covered, all-green code 500'd on the
first real request. If you only ever drive the seam the tests already drive, you re-run the tests by
hand and learn nothing. Drive the default; then, separately, the injected variant.

**Assert exact values through `inject()`, and let the probe FAIL loudly.** The probe's assertions
must compare the response to concrete expected literals and throw on mismatch — a probe that logs
without asserting is the no-op integration test in disguise. Minimum for any request path:
`res.statusCode`, the FULL `res.body` (or `res.json()`), and any headers the feature sets. A `500`,
a `null`/empty body, or a thrown `res.json()` on a DOCUMENTED happy path is a hard FAIL — never a
nit, no matter how green the gates are. (The cache HIT replayed via `send(bytes)`; the kernel
surfaces only string bodies through `inject()`, so every cached response came back `body: null` and
`res.json()` threw — invisible to any probe that checked only the status code or the `X-Cache`
header.)

Mandatory rules for what to drive:

- **One observation per ROADMAP deliverable** — walk the list from Step 1. Exercising only the
  default configuration verifies one deliverable, not the milestone (M10's Prisma and Drizzle
  adapter deliverables were no-op stubs; only the memory adapter was ever driven).
- **Every write is read back through the same public API.** `create` returning a value proves
  nothing — a stub echoing its input looks identical to success. Write, then `findAll`/`findById`
  and confirm the data (with its fields, not just an id) comes back. A variant that cannot be run
  against its real backend (needs codegen, a live database) is driven with an injected fake client
  that RECORDS calls: if a full CRUD sequence reaches the client as `["$connect"]` and nothing else,
  the adapter is decorative — FAIL, whatever the tests say.
- **Flip each option and observe the difference** (this is Step 5's option check, executed):
  `logQueries: true` must visibly log during repository operations, not merely be read somewhere.
- **Middleware / response transforms are verified by reading the transformed response back.** For
  anything that caches, rewrites, compresses, or otherwise alters a response, send the request, then
  send it AGAIN and assert the second response's FULL body equals the first's, plus its
  distinguishing header (`X-Cache: HIT`) AND that the handler ran exactly once (increment a counter
  in the handler and assert it). Any one of those three checks alone passes for a completely broken
  cache — the counter can be 1 while the body is empty; the header can be `HIT` while the status is
  `500`.
- **Transactions get adversarial probes, not just commit/rollback happy paths**: (1) abort a
  transaction and confirm its writes are gone; (2) write OUTSIDE the transaction while it is open,
  abort, and confirm that unrelated write SURVIVES (M10's global-snapshot rollback destroyed it);
  (3) read from outside before commit to check isolation and report dirty reads.
- **One error path** (assert the thrown message matches the documented one) and **one state-cleanup
  case** (a failure followed by a successful call — no leaked internal state; also drive one call
  AFTER `app.stop()` and confirm the closed-state guard).
- **Multi-instance plugins**: register two instances (named + default), confirm isolation and that
  illegal names / duplicate registrations throw at the documented point.

# Step 7 — Report

**Write the report to a Markdown file AND print its path.** Put it at
`.verify/milestone-<N>-verification.md` (the `.verify/` dir is git-ignored and fmt-excluded — this
is scratch, never `git add` it). Print the path so the human can open it. The chat summary is in
addition to, not instead of, the file.

Structure the report as: **commit hash verified + clean-tree confirmation → branch/commits → gates
table → per-file coverage table (pasted) → grep result (pasted) → contract findings (each item:
pass, or file:line + why) → behavioral section (driver source + RAW stdout, pasted verbatim) →
tracking status → verdict.**

Verdict is one of:

- **verified** — every gate green AND every behavioral probe asserted exact values against the
  committed code with pasted raw output.
- **verified with nits** — reserved for **doc-only or cosmetic** issues (a stale `ICache` name, an
  unchecked ROADMAP box). Fixes belong on the SAME feat/… branch since the milestone is unmerged. A
  runtime defect is NEVER a nit.
- **not verified** — any gate/coverage/contract failure, OR any behavioral probe that produced a
  `500`, a `null`/empty body, a thrown accessor, or a missing/incorrect value on a documented happy
  path. List exactly what must change. **If you did not run a behavioral probe with production
  defaults and paste its raw output, the verdict is `not verified` by default** — absence of
  evidence is not verification.

Sanity check before you commit to a verdict: re-read your own pasted behavioral output as an
adversary. Does the raw stdout actually show the expected body value, or only a status code and a
header? Did the probe use a fake where production uses a default? If the raw output does not prove
the feature works end-to-end, downgrade to `not verified` — a confident narrative over thin evidence
is exactly how green-but-broken code ships.
