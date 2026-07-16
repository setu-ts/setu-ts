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
- **Code-reviewing a milestone before merge** → a **Code Review**-mode subtask (slug `code-review`,
  rules in `.roo/rules-code-review/`), run AFTER `verify-milestone` has passed and its findings are
  fixed, and BEFORE the PR merges. It is READ-ONLY by design (no `edit` access): it reviews
  `git diff main...HEAD` at high effort and returns a ranked findings report. Do NOT let it fix
  anything — route each **correctness** finding it returns to a **Code**-mode subtask (the "Fixing
  review/gate findings" row above), then re-verify and re-review. **Correctness findings BLOCK the
  merge; reuse/simplification/efficiency findings are advisory.**

## Every `new_task` states its mode boundary (or the subtask stalls on the human)

A subtask starts fresh and knows only what your instruction tells it. Modes are not equally capable
— **Architect can read, run commands, and edit markdown ONLY; Code Review can read and run commands
but cannot edit at all; only Code can touch `src/`, `test/`, `deno.json`, or commit.** When a
subtask meets work outside its own mode's reach and the instruction never said what to do about it,
it has two bad options: ask the user to switch it to Code, or `switch_mode` itself. The first stalls
the pipeline waiting for a human who is not watching; the second silently voids the plan-only and
read-only gates. Both are your bug, not the subtask's — you left the boundary unstated. So, in every
`new_task`:

- **Route by the DELIVERABLE, not the topic.** Design-flavored wording does not make it an Architect
  subtask. If the deliverable is anything other than a markdown plan or doc — a scaffold, a `src/`
  or `test/` file, a `deno.json`, a commit — it is a **Code** subtask from the start. Architect gets
  a milestone's ONE plan file and nothing else.
- **Spell out the allowed actions.** Do not assume the subtask infers them from its mode. For an
  Architect milestone-start subtask, say verbatim: "You may read any file, run read-only commands
  (`git branch --show-current`, `deno task check:plan`), and create or edit ONLY
  `plans/milestone-<N>-<desc>.md`. You may NOT create or edit any `src/`, `test/`, or `deno.json`
  file, and you may NOT commit."
- **Forbid `switch_mode` and forbid asking the user; require a return instead.** Close every subtask
  instruction with: "Do NOT use `switch_mode`, and do NOT ask the user how to proceed. If finishing
  this subtask would need an action outside the list above, STOP and `attempt_completion`
  immediately with what you have plus the exact action that is blocked — the orchestrator will spawn
  the right subtask for it." A subtask's only two endings are a finished result or a blocked
  `attempt_completion`; a question to the human is neither.
- **A blocked return is a normal result, not a failure.** When Architect comes back saying it needed
  a `src/` edit, that is the handshake working. Your next move is a Code `new_task` carrying that
  blocked item — never relay the question to the human, and never widen the Architect subtask's
  scope to unblock it.
- **Name the branch and the return payload.** Give every subtask the `feat/…` branch it runs on
  (never `main`) and state exactly what to return: for Architect, the plan path + the clean
  `deno task check:plan` output + the key design decisions; for Code, the final
  `git status --porcelain`.

The one thing you never do here is escalate to the human mid-pipeline. The human's only steps are
reviewing the plan and pushing/opening the PR (see below) — anything else that "needs the user" is a
subtask you have not spawned yet.

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
