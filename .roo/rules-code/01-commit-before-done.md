# Code mode — your work is not finished until it is committed

This rule is specific to Roo Code's **Code** mode. Follow `CLAUDE.md` for the branch and commit
conventions (one `feat/…` branch per milestone; conventional commit messages; never work on or
commit to `main`; push and PRs are human-only). This file adds the mode-specific gate a delegated
subtask must not skip: leaving the tree dirty for someone else to commit is the single most common
way delegated work gets lost.

## Hard rules

- **You are not done until your changes are committed.** Before `attempt_completion`, commit the
  work you produced on the current `feat/…` branch with a conventional message (`feat(scope): …`,
  `fix(scope): …`, `docs: …`). Never hand a dirty working tree back to the orchestrator — it is
  delegate-only and CANNOT commit for you.
- **Report the tree state as your last action.** Run `git status --porcelain` at the very end and
  include its output verbatim in your result. Empty output is the signal that you actually finished;
  a non-empty tree is the signal for the orchestrator to send the work back.
- **Commit only — never push or open a PR.** Those are human-only steps (see
  `.roo/rules-orchestrator/01-delegate-only.md`).

## Notes

- Subtasks run serially, so committing your own work cannot race another subtask — there is no
  reason to defer the commit to "later".
- If you genuinely changed nothing (e.g. a read-only audit), say so explicitly in your result
  instead of committing; an empty `git status --porcelain` still confirms it.
