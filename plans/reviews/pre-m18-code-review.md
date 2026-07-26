# Retro code review — the pre-M18 backlog

Code review became a pipeline stage at **Milestone 18** (`packages/scheduler-plugin`, PR #40): from
that milestone on, every `feat/…` branch ran `review-milestone` → `code-review` at high effort
before merge, and the fix commits are in `main`'s history
(`fix(scheduler-plugin): address code-review
findings …`, `fix(metrics): …`,
`fix(openapi-plugin): …`, and so on).

Everything merged **before** M18 never had that pass. This document is the plan for paying that debt
down in bounded parts, one at a time.

It is **not** a milestone plan: it adds no package, no export, and no contract. It therefore lives
at `plans/reviews/` rather than `plans/` root, so `deno task check:plan` (which lints only the one
canonical milestone plan at `plans/` root) is unaffected.

## Objective & scope

Bring every pre-M18 package to the same review bar as M18+ code: read it for latent defects the
behavioral gates never exercise, fix confirmed correctness findings, and leave the package's
contracts, docs, and coverage honest.

Measured at `92c4101` (`main`), the unreviewed surface is **17 packages / 212 `src` files / 28,952
`src` lines**:

| Package                | src files | src lines | test files | prior review commits |
| ---------------------- | --------: | --------: | ---------: | -------------------: |
| `common`               |        36 |     5,243 |          9 |                    1 |
| `runtime`              |        24 |     3,382 |         31 |                    3 |
| `messaging-plugin`     |        14 |     2,758 |         17 |                    0 |
| `database-plugin`      |        14 |     2,481 |         21 |                    0 |
| `decorator-plugin`     |        15 |     2,233 |         21 |                    0 |
| `auth-plugin`          |        20 |     2,092 |         25 |                    0 |
| `queue-plugin`         |        11 |     2,036 |         14 |                    0 |
| `kernel`               |        11 |     1,887 |         12 |                    4 |
| `cache-plugin`         |        11 |     1,225 |         10 |                    1 |
| `logger-plugin`        |         6 |       929 |          6 |                    0 |
| `validation-plugin`    |         8 |       906 |         10 |                    0 |
| `http-security-plugin` |         7 |       847 |          9 |                    0 |
| `di-plugin`            |         7 |       770 |          7 |                    0 |
| `exceptions`           |         6 |       744 |          6 |                    0 |
| `config-plugin`        |         7 |       550 |          6 |                    0 |
| `events-plugin`        |         7 |       448 |          8 |                    0 |
| `cqrs-plugin`          |         8 |       421 |          7 |                    0 |

"prior review commits" counts commits touching that package whose subject mentions a code review —
all of them arrive from a **later, reviewed** milestone that happened to edit the package (M22
kernel routing, M23 runtime serve, M42 streaming, M11 cache). Those specific diffs were reviewed;
the package as a whole was not. `kernel`, `runtime`, `common`, and `cache-plugin` are therefore
partially-covered, not covered.

**Out of scope:**

- `packages/testing` — pre-M18 scaffolding (M0, `e988568`), but it is the subject of the in-flight
  M33, whose own `review-milestone` pass covers it. Reviewing it here would collide with that
  branch.
- Every M18+ package (`scheduler-plugin` onward) — already reviewed at merge.
- `packages/cli`, `packages/sdk`, `packages/starters` — stubs (10 lines / 0 lines).
- Docs-only files, `.github/`, `docker/`, `kubernetes/`, `.claude/` — not code under review, except
  where a finding forces a `PUBLIC_API.md` / `ARCHITECTURE.md` correction (which ships with the
  fix).
- Refactors for taste. A retro review is not a rewrite: see "Restraint" below.

## The parts (dependency order — run one at a time)

Six parts, not the four or five first considered: forcing five puts `messaging`+`queue`+`auth`+`di`+
`decorator` into one ~10k-line unit, which is too large for the read to be real. Each part below is
2.7k–5.3k `src` lines and ≤ 49 files.

| Part | Theme                      | Packages                                                                                    | src files / lines | Why this grouping                                                                                                        |
| ---: | -------------------------- | ------------------------------------------------------------------------------------------- | ----------------: | ------------------------------------------------------------------------------------------------------------------------ |
|    1 | Foundation contracts       | `common`                                                                                    |        36 / 5,243 | Every other part is judged against these contracts; a finding here can change a later part's scope, so it goes first.    |
|    2 | Kernel & runtime           | `kernel`, `runtime`                                                                         |        35 / 5,269 | The request path and the only sanctioned home for runtime-specific APIs. Partially covered by M22/M23/M42 reviews.       |
|    3 | Request-path cross-cutting | `exceptions`, `config-plugin`, `logger-plugin`, `validation-plugin`, `http-security-plugin` |        34 / 3,976 | Five small packages that all sit on the ingress path and share one review lens (spec-shaped output, header/body safety). |
|    4 | Data & domain              | `database-plugin`, `cache-plugin`, `events-plugin`, `cqrs-plugin`                           |        40 / 4,575 | Persistence, caching, and the domain-event/CQRS layer built on top of them.                                              |
|    5 | Async transport            | `messaging-plugin`, `queue-plugin`                                                          |        25 / 4,794 | Brokers and job queues: the same failure classes (ack/nack, retry, delayed delivery, leaked subscriptions).              |
|    6 | Identity & metaprogramming | `di-plugin`, `decorator-plugin`, `auth-plugin`                                              |        42 / 5,095 | The metadata/reflection layer and the guards that consume it — reviewed together because the coupling is the risk.       |

**One at a time.** Part N+1 does not start until Part N's PR is merged, so a `common` or `kernel`
fix never has to be duplicated across open branches.

## Branch & worktree convention

This is a defect in **already-merged `main`**, so CLAUDE.md's rule applies: `fix/…` branches, never
`feat/…`, and never a commit on `main`.

Per part:

```bash
git worktree add .claude/worktrees/review-p<N>-<slug> -b fix/review-p<N>-<slug> main
```

- Part 1 is `fix/review-p1-common` at `.claude/worktrees/review-p1-common`, branched from `92c4101`.
- Each part branches from `main` **after** the previous part merged.
- One PR per part. This plan file ships in Part 1's PR; later parts update only its status table.

## Review mechanism (and why it differs from `review-milestone`)

`review-milestone` and the `code-review` skill are both **diff-scoped**: `code-review` is instructed
to "report only defects that are introduced by the review scope" and to "not report pre-existing
defects outside the changed behavior as blocking findings". Here there is no meaningful diff base —
the target _is_ the pre-existing code. Pointing the skill at `main..HEAD` on a fresh branch would
review an empty diff and return clean, which is exactly the silent no-op the review gate exists to
prevent.

So each part runs a **two-stage** mechanism, and the report must name it:

1. **Stage 1 — inline full-file audit (the retro review proper).** Read every `src` file in the
   part's packages, plus the tests that claim to cover them, hunting the `review-milestone` Step 2
   dimensions and the `code-review` project dimensions explicitly rather than skimming:
   - **Correctness** — wrong results; unhandled error / rollback / not-found paths; clock mixing
     (`Date.now()` or wall-clock vs `hrtime()` outside `packages/runtime`); boundary conditions; a
     missing `await`; a `catch` that swallows cause; leaked timer / socket / subscription with no
     `onClose`.
   - **Contract honesty** — every JSDoc and `PUBLIC_API.md` claim matches what the code does;
     spec-shaped output (RFC 7807, Prometheus, OpenAPI) carries required fields and omits forbidden
     ones.
   - **Dead surface** — every option, parameter, field, export, and token is read on a real path.
   - **Test integrity** — each double honors the real contract; guarded tests genuinely skip rather
     than fail; every assertion traces to a documented behavior.
   - **Fail-fast** — injected seams validated where injected, not per request.
   - **Plugin/kernel integration** — name, `provides`, token grammar, dependencies, lifecycle,
     health, middleware priority all agree.
   - **Runtime portability** — no runtime-specific API outside `packages/runtime`; lazy optional
     deps have an injectable seam and a guarded real-import test.

   Then **adversarially verify each candidate before reporting it** — a probe or a failing test, not
   reasoning. An unverified suspicion is not a finding.

2. **Stage 2 — `/code-review main` on the fix branch.** Once the fixes are committed, the branch has
   a real diff and the skill is used as designed: it reviews the fixes themselves.

Report
`mechanism: stage 1 inline full-file audit + stage 2 code-review skill @ high effort on the
fix diff`
— and if the skill is unavailable, say so loudly in the report.

## Restraint — what a finding is, and what it is not

The backlog is old code that ships and is covered by tests. The risk of this campaign is not missing
a bug; it is churning 29k lines of working code.

- **Fix:** confirmed correctness defects, contract/doc lies, dead surface, a security or isolation
  hole, a test double that hides the bug it stands in for, a coverage gap that can hide one.
- **Record, do not fix:** stylistic preference, a design one would choose differently today, a
  cleanup that touches a public shape without cause. Advisory items go in the report; they never
  block, and they are not silently applied across a whole package.
- **A `common` contract change is a public-API change** — deliberate, flagged, with its
  `PUBLIC_API.md` edit in the same commit, and every consumer package updated in the same PR. Prefer
  the smallest honest change; a widening that ripples through 17 packages is its own milestone, not
  a review fix.

## Definition of done, per part

1. Stage 1 audit complete — every `src` file in the part's packages read, findings adversarially
   verified.
2. Every confirmed correctness finding fixed on the part's `fix/…` branch, each with a test that
   **fails without the fix**.
3. Stage 2 `/code-review main` run on the fix diff; its findings triaged the same way.
4. Four gates green, run from the worktree: `deno task fmt:check`, `deno task lint`,
   `deno task check`, `deno task test`.
5. **Per-file coverage ≥ 90% on branch, function, AND line** for every `src` file in the part's
   packages — read ANSI-stripped from `deno task test:coverage`, not from its exit code. A fix that
   drops an unrelated file below the bar is a regression to repair, not to note.
6. Evidence pasted in the report: findings, gate results, per-file coverage table, grep sweep.
7. Report written to `.verify/review-p<N>-<slug>.md` (git-ignored scratch, never `git add`-ed).
8. This file's status table updated in the part's own PR.
9. Committed as `fix(<pkg>): address retro code-review findings — <summary>` (or, when a part finds
   nothing, no commit and an explicit "no findings" verdict).

Verdict per part, same rule as `review-milestone`: **merge-ready** or **blocked**. A correctness
finding is never downgraded to a nit to unblock a merge.

## Seeded suspects (verified at `92c4101` before the campaign started)

Cheap sweeps already run, so no part wastes time re-deriving them:

- **`Deno.test` (banned) — one file left in the backlog set:**
  `packages/common/test/unit/metrics.test.ts`. Part 1 converts it to `describe`/`it` + `expect`.
  (The M32 review converted 15 such files in `multi-tenancy-plugin`; this is the last stray.)
- **`as any` / `@ts-ignore` / `new Function` / `eval` / `globalThis.__` in `src`** — no live
  occurrences; every grep hit is prose in a comment. Not a finding class for this campaign, but
  re-run the sweep per part after fixing.
- **`Date.now()` outside `packages/runtime`** — no live occurrences either; all hits are JSDoc lines
  warning against it. Clock mixing therefore has to be hunted by reading, not by grep.
- **M10's stub adapters are no longer stubs.** CLAUDE.md cites the M10 Prisma/Drizzle adapters as
  the worked example of a no-op implementation that shipped green. At `92c4101`, `prisma-adapter.ts`
  has a real `createPrismaDataSourceInner` delegating `findAll`/`create` to a client. Part 4 still
  has to prove the write-then-read-back path with an injected recording fake — the point of the
  original defect — but it starts from real code, not stubs.
- **`validation-plugin`'s `sanitize`** — CLAUDE.md cites a `sanitize` option stored on the service
  but never applied. At `92c4101` it is a free `sanitize()`/`createSanitizer()` pair exported from
  the barrel. Part 3 must confirm which entry points actually route through it (the "one capability,
  one implementation" rule) rather than assume the old defect is gone.

## Status

| Part | Branch                 | Verdict     | PR |
| ---: | ---------------------- | ----------- | -- |
|    1 | `fix/review-p1-common` | in progress | —  |
|    2 | —                      | not started | —  |
|    3 | —                      | not started | —  |
|    4 | —                      | not started | —  |
|    5 | —                      | not started | —  |
|    6 | —                      | not started | —  |

## Risks

- **Ripple from Part 1.** A `common` fix can force edits in every dependent package. Mitigated by
  ordering `common` first, by the smallest-honest-change rule, and by running parts sequentially.
- **Coverage regressions from deletions.** Deleting dead surface removes branches and can move an
  unrelated file's numbers. Re-read the per-file table after every deletion, not just after
  additions.
- **Interaction with in-flight M33.** M33 lives on `feat/33-testing-package` and owns
  `packages/testing`. No part touches that package; if a Part-1 `common` fix changes a contract M33
  consumes, note it in the PR so M33 rebases deliberately.
- **Review fatigue producing rubber-stamps.** The verdict rule is the guard: no pasted evidence →
  the part is not reviewed. A part that finds nothing must still paste the gates, the coverage
  table, and the list of files actually read.
