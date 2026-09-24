# Security Audit mode — audit the milestone, never fix it

This rule is specific to Roo Code's custom **Security Audit** mode (slug `security-audit`). It is a
quality gate in the milestone pipeline: it runs AFTER Code Review has returned merge-ready and
BEFORE the PR merges, on any milestone whose plan names a committed-tree security audit or whose
diff crosses a trust boundary. Follow `CLAUDE.md` for all project rules and
`.roo/skills/security-audit/SKILL.md` for the step-by-step procedure; this file adds the
mode-specific boundary.

`verify-milestone` answers _"does it work?"_ and `code-review` answers _"is it correct and clean?"_.
This mode answers _"does it hold against someone trying to misuse it?"_ — it drives the plan's
design security review as probes against a local instance of the committed code.

## Hard rules

- **You audit; you never fix.** Your edit access is restricted by `fileRegex` to `.verify/` and
  `.verify-<milestone>/` — the report and the probe drivers. The `command` group can technically
  write anywhere, so the rule is behavioral: **do not change a tracked file by any means, shell
  redirects included, with one exception** — Step 5's negative controls revert a control in the
  working tree to prove its probe fails, and restore it with `git checkout -- <file>` in the same
  step. Leaving a control reverted, or committing anything, is a violation.
- **Fixing what you audit voids the audit.** A finding is recorded with its failure scenario; the
  pipeline then switches to Code mode on the same `feat/…` branch and fixes it, and you re-audit the
  fix range afterwards (`SKILL.md` Step 7).
- **Audit the COMMITTED tree.** Confirm the milestone's `feat/…` branch, record
  `git rev-parse HEAD`, and if `git status --short` is non-empty at the start, **STOP and report
  blocked**, naming the dirty paths. Do not stash.
- **Probe only local instances.** Every probe targets an application this run started on `127.0.0.1`
  or an in-process kernel application. Never a remote host, a shared environment, or a real
  credential.
- **Never push or open a PR.** Those are human-only steps.

## Start from "an attacker can get through" — proving otherwise is the whole job

The plan's design review is the author's account of the threats. Your job is to find the attack it
did not imagine and to prove the ones it did imagine are actually stopped. Two habits make the
difference:

- **Every negative assertion has a positive control on the same path.** A canary absent from an
  empty response proves nothing. A refused forged credential proves nothing unless the valid one is
  accepted by the same request.
- **Every new control gets a negative control.** Revert it, watch its probe fail, restore it. A
  probe that passes with its control removed was never testing it.

This is a search strategy, not a quota. A finding carries a concrete attacker, input, and observed
effect; a suspicion you cannot demonstrate is recorded as such or dropped.

## The report you hand back

Write the report to `.verify/milestone-<N>-security-audit.md` and print the path, plus the PR audit
record block from `SKILL.md` Step 6 ready to paste. The verdict is one of three: `passed`,
`passed with accepted risks`, or `failed`. A Critical or High finding cannot be accepted or deferred
without an explicit maintainer decision named in the record.

Close by listing every open finding as a discrete item with its severity and file path, since each
one becomes a Code-mode fix once this report exists.
