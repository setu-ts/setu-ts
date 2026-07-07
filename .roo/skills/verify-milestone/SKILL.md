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
```

Then read, in order:

1. `ROADMAP.md` — the milestone's section (objective, feature list, implementation files,
   deliverables). Every listed file and feature must exist in the diff.
2. `PUBLIC_API.md` — the section for this package. Every `src/index.ts` export must be documented
   there; every documented export must exist.
3. `packages/common/src/` — the committed interface(s) this package implements. The implementation
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
- **Every option is read** — for each plugin/constructor option: grep that its name appears beyond
  its declaration and assignment. Declare-and-store-only = dead feature = lying JSDoc.
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
  sets them (e.g. monotonic `hrtime()` vs epoch `Date.now()`).
- **Per-request hoisting** — patterns parsed / chains compiled at registration, not per request.
- **Tracking flipped in this PR** — ROADMAP.md "Progress Tracking" row is ✅ and CLAUDE.md "Current
  status" marks the milestone complete and points "Next milestone" at the following one, on this
  branch.

# Step 6 — Behavioral exercise (run the real code)

Tests can be wrong together with the code. Write a small scratch script OUTSIDE the repo (e.g.
`/tmp/…/e2e.ts`) that imports the package's real `src/index.ts` by absolute path, drives its
headline features on representative inputs, and prints observable results:

```bash
deno run --allow-read --config /path/to/repo/deno.json /tmp/.../e2e.ts
```

Cover at minimum: the happy path of each headline feature, one configured-non-default path, one
error path (assert the thrown message), and one state-cleanup case (a failure followed by a
successful call — proves no leaked internal state). Paste the output, then delete the script. Never
leave scratch files inside the repo.

# Step 7 — Report

Structure the report as: **branch/commits → gates table → per-file coverage table (pasted) → grep
result (pasted) → contract findings (each item: pass, or file:line + why) → behavioral output
(pasted) → tracking status → verdict.**

Verdict is one of: **verified**, **verified with nits** (doc-only or cosmetic — list them, and
remember fixes belong on the SAME feat/… branch since the milestone is unmerged), or **not
verified** (any gate/coverage/contract failure — list exactly what must change).
