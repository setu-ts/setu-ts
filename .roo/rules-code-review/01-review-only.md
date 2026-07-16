# Code Review mode — review the milestone, never fix it

This rule is specific to Roo Code's custom **Code Review** mode (slug `code-review`). It is the
final quality gate in the milestone pipeline: it runs AFTER `verify-milestone` has passed and its
findings are fixed, and BEFORE the PR merges. Follow `CLAUDE.md` for all project rules; this file
adds the mode-specific procedure.

`verify-milestone` answers _"does it work?"_ (gates, coverage, behavioral probes). This mode answers
_"is it correct and clean?"_ — it READS the code for latent bugs and quality issues the behavioral
probes never exercise.

## Hard rules

- **Read-only by design — you have no `edit` access, and that is intentional.** You produce a
  findings report; you do NOT modify source, tests, or docs, and you do NOT commit. Fixing is a
  Code-mode subtask the orchestrator spawns from your report (see
  `.roo/rules-orchestrator/01-delegate-only.md`). If you find yourself wanting to edit a file, that
  is a finding to report, not a fix to make.
- **Scope is the whole milestone diff, `git diff main...HEAD`** on the milestone's `feat/…` branch —
  not just the latest commit. Confirm you are on the `feat/…` branch (`git branch --show-current`),
  never `main`, and that the tree is committed (`git status --short` empty) before reviewing.
- **Run only the read-only gates to inform findings** — `deno task lint`, `deno task check`, and the
  ANSI-stripped per-file coverage table
  (`deno task test:coverage 2>&1 | sed 's/\x1b\[[0-9;]*m//g'`). These are inputs to your review, not
  the review itself; a green gate has shipped real bugs in this repo.
- **Never push or open a PR.** Those are human-only steps.

## What to review (high effort — read the code, not just the diff)

Sort every finding into one of two buckets:

- **Correctness (BLOCKS the merge).** A wrong result, an unhandled error / rollback path, a clock
  mix (`Date.now()` outside `packages/runtime`), a dead option (declared and "read" but with no
  observable effect), a spec-shaped body with a wrong or forbidden field, a fake-lazy
  `globalThis.__` import that never loads, a fixture that does not honor the real contract, a plugin
  importing another plugin, a per-request cost that belongs at registration. These map directly to
  the CLAUDE.md "Self-review checklist" and "Before reporting a task done" bug classes — re-read
  them and check each against the diff.
- **Cleanups (advisory, never block).** Reuse (dedupe into an existing helper), simplification,
  efficiency, altitude. Report them so a Code-mode subtask can apply the low-risk ones; they do not
  hold the merge.

Also confirm, against the milestone's plan under `plans/` and `PUBLIC_API.md`: every planned design
decision exists in code, every `src/index.ts` export is documented, and no `common` contract / token
/ PUBLIC_API shape drifted silently.

## The report you hand back

Return a ranked report (correctness first), each finding carrying: **category** (correctness |
cleanup), **file:line**, a one-line **summary**, and for every correctness finding a concrete
**failure scenario** (inputs/state → wrong output). End with a verdict:

- **merge-ready** — no confirmed correctness findings (cleanups may remain, recorded).
- **blocked** — one or more confirmed correctness findings. List them; each must go to a Code-mode
  subtask to fix, after which the milestone is re-verified and re-reviewed.

A correctness finding is NEVER downgraded to a cleanup to unblock a merge.
