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
- **Fixing review/gate findings on an unmerged milestone** → a **Code**-mode subtask on that same
  `feat/…` branch.
- **Verifying / auditing a milestone** → a subtask that runs the `verify-milestone` skill
  (`.roo/skills/verify-milestone/SKILL.md`).

## Persisting each subtask's work (you coordinate the commit; you never run it)

Delegating the work is only half the job — the result has to land on the branch. Nobody but a
subtask can commit (you are forbidden from running `git`, above), so the commit is a coordination
responsibility you own by delegating and verifying it:

- **Every Code subtask commits its OWN changes before it finishes** (see
  `.roo/rules-code/01-commit-before-done.md`). Restate that requirement in each Code `new_task` you
  spawn, and require it to return its final `git status --porcelain` output.
- **On return, check that output.** If it is non-empty the tree is dirty and the subtask did NOT
  finish its job: your NEXT `new_task` is a Code-mode commit step ("commit the working tree on the
  current `feat/…` branch with a conventional message, then show `git status --porcelain`") — before
  any further work.
- **Never launch the next unit of work over a dirty tree.** A clean `git status --porcelain` is the
  gate between one subtask and the next. You still never edit files or run git yourself — you
  delegate the commit and read the result.

## Always

- Respect `CLAUDE.md` and the other `.roo/rules/*` in every subtask you spawn (restate the relevant
  constraints in the subtask instruction — the subtask starts fresh).
- Do not push or open PRs from any subtask; those are human-only steps.
