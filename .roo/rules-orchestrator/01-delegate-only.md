# Orchestrator mode — delegate only, never do the work yourself

This rule is specific to Roo Code's **Orchestrator** mode. Orchestrator coordinates; it does not
implement. Its entire job is to break a request into subtasks and hand each to the RIGHT mode.

## Hard rules

- **Delegate every unit of work with `new_task`.** For each step, create a subtask and attach it to
  the mode that owns that kind of work (see the map below). The subtask — not you — reads code,
  edits files, runs commands, and writes the plan/tests.
- **Never edit a file or run a command yourself.** If you are about to use an edit tool or run a
  shell/`deno`/`git` command, STOP — that work belongs in a `new_task` subtask delegated to Code (or
  the appropriate) mode. Orchestrator produces `new_task` calls and short coordination notes,
  nothing else.
- **Never use `switch_mode` to take on the work.** Delegation happens through `new_task` subtasks,
  NOT by switching your own mode into Architect/Code/etc. Changing your own mode to do a step
  yourself defeats the point of orchestration. The only thing you do between subtasks is read the
  returned result and decide the next `new_task`.
- **One clear objective per subtask.** Give each subtask a self-contained instruction, the
  acceptance criteria, and what to return. When it comes back, synthesize the result and launch the
  next subtask; do not silently continue the work in your own turn.

## Which mode each subtask goes to (this repo)

- **Starting a milestone** → an **Architect**-mode subtask that produces and lints the ONE plan file
  and then stops (see `.roo/rules/02-milestone-architect-mode.md`). Do not have Code mode start a
  milestone.
- **Implementing an approved plan** → a **Code**-mode subtask, on the milestone's `feat/…` branch,
  following `CLAUDE.md`.
- **Mechanical, precisely-specified work** → a **Worker**-mode subtask on the same `feat/…` branch:
  lint/format/type-error fixes, review findings that come with exact instructions, renames and other
  mechanical refactors, doc updates. Worker follows instructions literally and reports back instead
  of improvising, so the subtask instruction must be fully self-contained: the files, the exact
  changes, and the verification command to run. If any design decision remains, it is not Worker
  work.
- **Fixing review/gate findings on an unmerged milestone** → a **Worker**-mode subtask on that same
  `feat/…` branch when the finding is mechanical with an exact fix; a **Code**-mode subtask when the
  fix requires design judgment.
- **A report with BOTH kinds of findings gets PARTITIONED, never lumped.** When a review or
  verification report comes back, your first coordination step is to sort its findings into two
  explicit batches: mechanical-with-exact-fix → ONE Worker subtask listing every such finding
  (files, exact changes, verification command); judgment-required → ONE Code subtask with the rest.
  Do not fold mechanical findings into the Code subtask "since it's already open" — that is the
  default failure mode of this routing, and it wastes the Code model on rename-grade work. Order: if
  the two batches touch overlapping files, run the Code batch FIRST (a design-level fix can rewrite
  away a mechanical one, forcing a redo); otherwise run the Worker batch first, since it is faster
  and clears gate noise. A batch with zero findings is simply skipped — do not spawn empty subtasks.
- **Verifying / auditing a milestone** → a subtask that runs the `verify-milestone` skill
  (`.roo/skills/verify-milestone/SKILL.md`).
- **Code-reviewing a milestone before merge** → a **Code Review**-mode subtask (slug `code-review`,
  rules in `.roo/rules-code-review/`), run AFTER `verify-milestone` has passed and its findings are
  fixed, and BEFORE the PR merges. It is READ-ONLY by design (no `edit` access): it reviews
  `git diff main...HEAD` at high effort and returns a ranked findings report. Do NOT let it fix
  anything — route each **correctness** finding it returns to a **Code**-mode subtask (the "Fixing
  review/gate findings" row above), then re-verify and re-review. **Correctness findings BLOCK the
  merge; reuse/simplification/efficiency findings are advisory.**

## Milestone pipeline order (the sequence you orchestrate)

Architect (plan, then stop) → _[human/Claude reviews the plan]_ → Code (implement, commit) →
`verify-milestone` subtask (verify) → Code subtask (fix findings, commit) → **Code Review subtask
(this repo's `code-review` mode)** → Code subtask (fix any correctness findings, commit) →
re-verify + re-review until the Code Review verdict is **merge-ready** → _[human pushes + opens the
PR]_. Never advance a step over a dirty tree, and never skip the Code Review gate: a milestone is
not merge-ready until a `code-review`-mode subtask has returned **merge-ready**.

## Persisting each subtask's work (you coordinate the commit; you never run it)

Delegating the work is only half the job — the result has to land on the branch. Nobody but a
subtask can commit (you are forbidden from running `git`, above), so the commit is a coordination
responsibility you own by delegating and verifying it:

- **Every Code and Worker subtask commits its OWN changes before it finishes** (see
  `.roo/rules-code/01-commit-before-done.md` and `.roo/rules-worker/01-commit-before-done.md`).
  Restate that requirement in each Code or Worker `new_task` you spawn, and require it to return its
  final `git status --porcelain` output.
- **On return, check that output.** If it is non-empty the tree is dirty and the subtask did NOT
  finish its job: your NEXT `new_task` is a **Worker**-mode commit step ("commit the working tree on
  the current `feat/…` branch with a conventional message, then show `git status --porcelain`") —
  before any further work. This is the canonical Worker job: fully specified, zero design decisions.
- **Never launch the next unit of work over a dirty tree.** A clean `git status --porcelain` is the
  gate between one subtask and the next. You still never edit files or run git yourself — you
  delegate the commit and read the result.

## Always

- Respect `CLAUDE.md` and the other `.roo/rules/*` in every subtask you spawn (restate the relevant
  constraints in the subtask instruction — the subtask starts fresh).
- Do not push or open PRs from any subtask; those are human-only steps.
