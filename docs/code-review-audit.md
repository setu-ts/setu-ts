# Code-Review Audit — previous milestones (backlog & tracker)

The milestone workflow gained a code-review gate only at Milestone 18. Milestones 1–17 (and the
add-ons 14b / 15b / 16b / 39) merged to `main` WITHOUT one. This document is the single, durable
tracker for retro-fitting that review across many short sessions, so progress survives token resets
and both Roo and Claude read/write the same state.

**This is a process/tooling doc, NOT a milestone plan** — it does not live under `plans/` and is not
bound by the one-plan-per-milestone rule. Keep it on its own `chore/…` branch (or wherever the
review tooling lands), never on a milestone `feat/…` branch.

## Ground rules for this audit

- **Scope = the package's CURRENT `src/` on `main`,** not a historical merge diff. It is what ships
  today and folds in the later add-ons (14b/15b/16b/39 live inside their packages). Review the whole
  `src/` tree of the package, guided by `CLAUDE.md` ("Self-review checklist", "Before reporting a
  task done") and the package's section in `PUBLIC_API.md` and `plans/archive/`.
- **These are DEFECTS IN MERGED `main`, so fixes go on `fix/<pkg>-review` branches** — one per
  package — never a `feat/…` branch and never a direct commit to `main` (`CLAUDE.md` §branches).
  Each `fix/…` branch merges via its own PR (human-only push + PR).
- **Correctness findings BLOCK** (they become a `fix/…` PR); reuse/simplification/efficiency
  findings are **advisory** (apply the low-risk ones in the same `fix/…` PR, record the rest here).
- **One package (or one listed small group) per session. Never "just one more".** Read this tracker,
  take the next `⬜ pending` row, review it, write findings back here, set its status, stop.
- **Coverage bar still applies to every fix**: any fix that adds/changes a branch keeps the touched
  `src` file ≥90% on branch/function/line. A fix without a test that fails without it is not done.

## Who runs what (token split)

- **Roo runs the bulk first-pass** for every package via the `code-review` mode
  (`.roo/rules-code-review/`), on its own API budget. It produces the findings; it does not fix
  (fixes are a Roo Code-mode subtask on the `fix/…` branch).
- **Claude runs the three FOUNDATIONAL packages** (`common`, `kernel`, `runtime`) where depth pays
  off most, and **confirms Roo's `correctness` findings** before a `fix/…` PR is opened (a quick
  adversarial pass to kill false positives). Claude uses the `review-milestone` skill's discipline
  adapted to the merged-`main` scope.

## Session plan (ordered by blast radius + known risk)

Foundational packages first — a bug there infects every plugin — then security-critical, then
historically fragile, then the rest.

| #  | Package(s)                                        | Milestone(s) | Reviewer | Effort | Status     | Findings | Fix branch/PR |
| -- | ------------------------------------------------- | ------------ | -------- | ------ | ---------- | -------- | ------------- |
| 1  | `common`                                          | M1           | Claude   | high   | ⬜ pending | —        | —             |
| 2  | `kernel`                                          | M2           | Claude   | high   | ⬜ pending | —        | —             |
| 3  | `runtime`                                         | M3, M39      | Claude   | high   | ⬜ pending | —        | —             |
| 4  | `database-plugin`                                 | M10          | Roo      | high   | ⬜ pending | —        | —             |
| 5  | `auth-plugin`                                     | M16, M16b    | Roo      | high   | ⬜ pending | —        | —             |
| 6  | `http-security-plugin`                            | M17          | Roo      | high   | ⬜ pending | —        | —             |
| 7  | `decorator-plugin`                                | M9           | Roo      | high   | ⬜ pending | —        | —             |
| 8  | `messaging-plugin`                                | M14, M14b    | Roo      | high   | ⬜ pending | —        | —             |
| 9  | `queue-plugin`                                    | M15, M15b    | Roo      | high   | ⬜ pending | —        | —             |
| 10 | `cache-plugin`                                    | M11          | Roo      | medium | ⬜ pending | —        | —             |
| 11 | `validation-plugin` + `exceptions`                | M6, M7       | Roo      | medium | ⬜ pending | —        | —             |
| 12 | `di-plugin` + `config-plugin`                     | M8, M5       | Roo      | medium | ⬜ pending | —        | —             |
| 13 | `logger-plugin` + `events-plugin` + `cqrs-plugin` | M4, M12, M13 | Roo      | medium | ⬜ pending | —        | —             |

Status legend: ⬜ pending · 🔵 reviewing · 🟡 findings logged (fix pending) · 🟢 fixed & verified.

## Per-session runbook

**Roo (bulk pass), per row:**

1. Orchestrator spawns a **Code Review**-mode subtask: "review the current `src/` of
   `packages/<pkg>` on `main` at the listed effort; return a ranked findings report." (Read-only —
   the mode has no `edit` access.)
2. Append the returned findings to the "Findings log" below under that package; set the row to 🟡
   (or 🟢 if none).
3. For each **correctness** finding: orchestrator spawns a **Code**-mode subtask on a
   `fix/<pkg>-review` branch to fix + test + commit, then a `verify` pass. Set the row 🟢 when the
   fix branch is green. Push + PR are human-only.

**Claude (foundational + confirmation):** take a `common`/`kernel`/`runtime` row, review at high
effort against the contracts and `CLAUDE.md` checklists, log findings here, and open/hand off a
`fix/<pkg>-review` branch. Also confirm any Roo `correctness` finding flagged for a second opinion
before its fix PR opens.

## Findings log

_Append one subsection per package as it is reviewed. Each finding: `category` (correctness |
cleanup) · `file:line` · one-line summary · for correctness, a concrete failure scenario · outcome
(fixed in `fix/…` / recorded)._

<!-- e.g.
### common (M1) — reviewed <hash> by Claude
- **correctness** · `packages/common/src/foo.ts:42` · <summary>. Failure: <inputs → wrong output>. → fixed in `fix/common-review`.
- **cleanup** · `packages/common/src/bar.ts:10` · <summary>. → recorded.
-->

_(none yet)_
