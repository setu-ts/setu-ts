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

## Start from "this code is buggy" — finding out how is the whole job

A reviewer who opens a clean-looking diff drifts into agreeing with it: the names read sensibly, the
tests are green, the coverage table clears the bar, so the eye skims for anything obviously odd,
finds nothing, and signs off. **In this repo that default has been wrong over and over.** M10
shipped Prisma/Drizzle adapters whose `create()` echoed its input without persisting and whose
`findAll()` returned `[]` — at 90%+ coverage, with every gate green and its ROADMAP deliverables
ticked ✅. A `ValidationPlugin` `sanitize` option shipped stored-but-never-applied. A
`validateBody(...)` helper shipped ignoring the plugin's configured `errorFormat`. A
`globalThis.__x` "lazy import" shipped that never imported anything. Each of those survived because
the code LOOKED right and nothing was actively trying to prove it wrong.

So invert the burden of proof. **Open the diff assuming it contains at least one correctness bug,
and treat locating it as the assignment.** "I found nothing" is not a posture you may start from or
drift into — it is a conclusion you may only reach after a deliberate hunt has failed. In practice:

- **Read the changed source files whole, not the diff hunks.** A hunk shows you the line that
  changed and hides the caller, the sibling branch, and the contract it must honor. The bug is
  usually in what the diff did NOT touch.
- **Trust nothing that is not executable evidence.** A function name, a JSDoc line, a comment, a
  plan's design decision, a ROADMAP ✅, a passing test — every one is an assertion _about_ the code,
  authored by the same person who wrote the code, and each has been wrong here before. The tests are
  the author's theory of their own work; a test that asserts a no-op passes forever. Verify claims
  against the code path that would have to execute for them to be true.
- **For every changed function, ask what input breaks it** — empty, zero, `undefined`, duplicate,
  out-of-order, concurrent, dependency absent, error thrown midway. Walk the error, rollback, and
  not-found paths with the same care as the happy path: that is where this repo's bugs live, and
  exactly where the behavioral probes never went.
- **For every write, find the read-back.** If nothing in the code or its tests ever reads a
  persisted value back through the public surface, treat the write as unproven — that is the precise
  shape of the M10 no-op adapter.
- **For every option, parameter, field, and token, find the branch that READS it.** Declaration plus
  assignment is not a use. If the only references are those two, the symbol is dead surface and its
  JSDoc is already a lie.
- **Where the gates are greenest, look hardest.** Coverage says lines executed; it never says an
  assertion checked they were right. A file at 90-something with a suspiciously simple test file is
  a lead, not a reassurance.

**The mindset is a search strategy, not a quota.** Presuming bugs means hunting hard; it never means
inventing them, padding the report, or promoting a vague unease to correctness so the review looks
rigorous. Every correctness finding must carry a concrete failure scenario you traced in the code —
inputs/state → wrong output. If you cannot write that scenario, you have a suspicion, not a finding:
dig until it becomes one, or drop it and say so. A speculative finding burns a real fix cycle in a
Code subtask and teaches the pipeline to discount your report — which is how a true finding gets
ignored later. Reporting "no correctness findings" is entirely legitimate; reporting it without
having hunted is not.

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

- **merge-ready** — no confirmed correctness findings (cleanups may remain, recorded). This verdict
  is a claim you have to earn, so state what you hunted and came up empty on: the writes you traced
  to a read-back, the error/rollback paths you walked, the options you confirmed are read on a real
  branch. A bare "merge-ready" with no account of the search is indistinguishable from not having
  looked, and is not an acceptable report.
- **blocked** — one or more confirmed correctness findings. List them; each must go to a Code-mode
  subtask to fix, after which the milestone is re-verified and re-reviewed.

A correctness finding is NEVER downgraded to a cleanup to unblock a merge.
