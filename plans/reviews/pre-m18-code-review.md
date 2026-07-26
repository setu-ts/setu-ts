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

| Part | Branch                         | Verdict     | PR  |
| ---: | ------------------------------ | ----------- | --- |
|    1 | `fix/review-p1-common`         | merge-ready | #72 |
|    2 | `fix/review-p2-kernel-runtime` | merge-ready | #73 |
|    3 | `fix/review-p3-request-path`   | merge-ready | #74 |
|    4 | `fix/review-p4-data`           | merge-ready | #75 |
|    5 | —                              | not started | —   |
|    6 | —                              | not started | —   |

## Follow-ups surfaced by a part but outside its scope

A part reports what it finds elsewhere rather than fixing it, so nothing is lost and no part quietly
expands. Each entry names who should own it.

| #  | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Owner                                                 |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1  | `IPluginContext.options` is documented as "options the application passed to this plugin's factory" but the kernel builds ONE shared context with `options: {}` (`application.ts:215`) and nothing in any package, test, or example reads it. Plugins are factories that close over their options, so there is nothing to populate it from. Recommend removing it from the contract — but AI_GUIDELINES §16.2 ("Any change to the `IPluginContext` interface requires approval") makes that the maintainer's call, so Part 1 left it in place. | maintainer decision, then Part 2 (kernel edit)        |
| 2  | ~~The kernel records env-var declarations as `envSpecs.push({ name: 'environment', spec })`, hardcoding the name, so every validation failure read "(declared by environment)".~~ **Fixed in Part 2** — a registration cursor attributes each declaration to the plugin whose `register()` is running, and `IEnvironmentApi.validate` now documents that a spec declared after registration (e.g. from an `onInit` hook) is never checked.                                                                                                     | done (Part 2)                                         |
| 3  | Nine `metrics-plugin` test files import assertions from `https://deno.land/std@0.224.0/assert/mod.ts` — a hard-pinned remote URL that bypasses the workspace import map and pulls a second `std` into the lockfile. Part 1 fixed the one instance inside `common`; `metrics-plugin` is M19 (post-M18) so it sits outside all six parts.                                                                                                                                                                                                        | separate cleanup PR                                   |
| 4  | `@since` tags carrying milestone numbers as versions (`0.19.0`, `0.20.0`, `0.24.0`, `0.24.1`) — no such release exists; every package is `0.1.0`. Part 1 normalized the ones in `common`; 44 remain in `metrics-plugin`, `health-plugin`, and `telemetry-plugin`.                                                                                                                                                                                                                                                                              | same cleanup PR as #3                                 |
| 5  | `PluginPriority` (a union of the `PLUGIN_PRIORITY` values) has no consumer anywhere in the repo — `IPlugin.priority` is a plain `number` by design, so nothing can use it. It is documented public API in PUBLIC_API.md, so it is plausibly deliberate convenience surface for applications. Recorded, not changed.                                                                                                                                                                                                                            | no action unless the maintainer wants it cut          |
| 6  | ~~`common` JSDoc references `{@linkcode createRequestContext}` (`http.ts`, twice) — a kernel symbol a contracts package cannot resolve.~~ **Fixed in Part 2.**                                                                                                                                                                                                                                                                                                                                                                                 | done (Part 2)                                         |
| 7  | Every HTTP adapter buffers the **entire** request body into memory (`mapWebRequestToFrameworkRequest` awaits `request.arrayBuffer()`) before the pipeline runs, so `http-security-plugin`'s request-size guard can only reject a body that has already been read — a hostile upload exhausts memory before any limit applies. Fixing it means giving up idempotent multi-read body access or adding a size-capped streaming read seam: a design decision, not a review edit.                                                                   | maintainer decision (design), then `runtime` + Part 3 |
| 8  | `onResponse` hooks do NOT run when a request throws — the error path runs `onError` and returns the 500 without them — while `ILifecycleApi.onResponse` documents "after every response is produced" and ARCHITECTURE's hook table says "Every response". Running them in the error path can double-execute when an `onResponse` hook is itself what threw, so the fix needs a decision: guarded re-run, or narrow the contract wording.                                                                                                       | maintainer decision, then a Part 2 follow-up          |
| 9  | `Router.match()` non-null-asserts the `#entryMap` lookup (`router.ts:179`). Reachable only if Hono reported a route path the kernel never registered, which cannot happen today; a guard would add a branch no test can cover. Recorded, not changed.                                                                                                                                                                                                                                                                                          | no action                                             |
| 10 | CSRF passes an unsafe request through when BOTH `Origin` and `Referer` are absent (`csrf-middleware.ts`), documented as "non-browser clients". It is a deliberate, documented fail-open, but it is still a fail-open: a client that strips both headers bypasses the check entirely unless `customHeader` is also configured. A `requireOrigin` option (default off, or on in a future major) would close it without breaking existing apps.                                                                                                   | maintainer decision                                   |
| 11 | CORS `allowedHeaders` defaults to `[]`, so a preflight for a JSON `POST` gets no `Access-Control-Allow-Headers` and the browser blocks it. Documented as-is ("when configured"), and every mainstream CORS implementation instead reflects `Access-Control-Request-Headers` when no list is set. Changing the default is a behavior change beyond a review's remit.                                                                                                                                                                            | maintainer decision                                   |
| 12 | `sanitize`'s `maxLength` truncates AFTER `htmlEncode`, so a cut can land inside an entity (`&am`). Documented order, and moving the truncation would change results for existing callers.                                                                                                                                                                                                                                                                                                                                                      | maintainer decision                                   |
| 13 | `DrizzleAdapter`'s `findAll` reads the **entire table** (`instance.select().from(table)`) and filters/sorts/paginates in memory, and `create()` re-reads the whole table to return the inserted row. Results are correct but every query is O(table) — not viable against a real database. Needs genuine push-down through Drizzle's operators (`eq`/`and`, `orderBy`, `limit`, `offset`), which the adapter already imports for `update`.                                                                                                     | follow-up milestone (`database-plugin`)               |
| 14 | `RequestBus.registerHandler` silently OVERWRITES an existing handler for the same request type. Two handlers for one command is a configuration error, and the kernel registry throws on a duplicate registration without `override`; CQRS registration is undocumented on this point. A fail-fast throw would match the framework, but it changes behavior for anyone re-registering deliberately.                                                                                                                                            | maintainer decision                                   |
| 15 | `MemoryStore` ignores its `prefix` (documented: one Map per instance, so `clear()` is naturally scoped) while `CacheService.clear()`'s JSDoc says the backend "uses the construction-time prefix to scope the deletion" — true for Redis, moot for memory. Harmless today; would matter if two `CacheService` instances ever shared one backend.                                                                                                                                                                                               | no action                                             |

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
