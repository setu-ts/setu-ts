# Orchestrator mode — switch modes, do not spawn subtasks

This rule is specific to Roo Code's **Orchestrator** mode. Orchestrator carries a piece of work from
start to finish, moving between modes as the work changes shape. It runs the pipeline **in one
conversation**, using `switch_mode`.

**This replaces the previous subtask model.** Orchestration here used to mean a `new_task` per step,
with each subtask starting fresh and the orchestrator re-stating the branch, the constraints and the
return payload every time. That cost the thing the pipeline most depends on — continuity. A subtask
that never saw the plan re-derived it, a fix subtask that never saw the finding re-diagnosed it, and
a blocked return bounced through the orchestrator for a step it could have taken itself. **Do not
use `new_task`.** Switch your own mode instead, and keep the context.

## Hard rules

- **`switch_mode` is the mechanism.** When the work moves from planning to implementing, from
  implementing to verifying, from verifying to fixing — switch into the mode that owns that work and
  keep going in the same conversation.
- **Do NOT use `new_task`.** Not for a step you could take by switching, and not "just for this one
  isolated piece". A subtask loses the plan, the findings, and the reasoning that produced them.
- **Do the work in the right mode, never in Orchestrator.** Orchestrator is a coordinating posture,
  not a capability set. If you are about to edit a file or run a command, first switch into the mode
  that owns it. The mode boundaries below still bind — switching is how you cross one legitimately,
  and doing the work without switching is how you void it.
- **Switch back when the step is done.** After a Code-mode fix, switch to the gate mode that has to
  re-check it. Do not stay in Code because it is convenient; the gates are separate modes precisely
  so that neither can quietly fix what it was sent to find.
- **Announce every switch in one line** — which mode, and why now. That line is the record of the
  pipeline's shape, and on a long run it is the only thing that shows the gates ran in the right
  order.

## The mode boundaries still bind (this is what switching must not void)

Modes are not equally capable, and the restrictions are deliberate:

| Mode             | May edit                                           | May commit |
| ---------------- | -------------------------------------------------- | ---------- |
| Architect        | markdown only (the milestone's ONE plan file)      | no         |
| Code             | `src/`, `test/`, `deno.json`, docs — anything      | **yes**    |
| Verify Milestone | `.verify/` and `.verify-<milestone>/` scratch only | no         |
| Code Review      | nothing — read-only by design                      | no         |
| Security Audit   | `.verify/` and `.verify-<milestone>/` scratch only | no         |

**Switching modes is how you cross a boundary; it is not how you erase one.** The danger the subtask
model handled structurally, and that `switch_mode` hands back to you, is this: a verifier or a
reviewer can now simply switch to Code and fix what it just found. That voids the gate — a verifier
who patches a defect and re-runs its own probe is grading its own homework, and a reviewer who fixes
what it found never reports it, so nothing re-checks the fix.

So the sequencing rule is absolute:

- **A gate pass FINISHES and RECORDS its findings before any switch to Code.** Verify Milestone
  writes its report to `.verify/milestone-<N>-verification.md`; Code Review returns its ranked
  findings with the reviewed commit hash; Security Audit writes
  `.verify/milestone-<N>-security-audit.md` with the audited revision. Only then do you switch to
  Code and fix.
- **After fixing, switch back to the gate mode and re-run it** against the new commit. The fix diff
  is the least-reviewed code in the milestone (see `.roo/rules-code-review/01-review-only.md`), so
  it gets a real second pass, not a rubber stamp.
- **Never fix from inside a gate mode.** Wanting to fix something is a finding to record, then a
  switch — in that order, never the reverse.

## Which mode owns which work (this repo)

- **Starting a milestone** → **Architect**, which produces and lints the ONE plan file and then
  stops for review (see `.roo/rules/02-milestone-architect-mode.md`). Never start a milestone in
  Code mode.
- **Implementing an approved plan** → **Code**, on the milestone's `feat/…` branch, following
  `CLAUDE.md`.
- **Fixing gate or review findings on an unmerged milestone** → **Code**, on that same `feat/…`
  branch. Never a `fix/…` branch: that is only for a defect in already-merged `main`.
- **Verifying a committed milestone** → **Verify Milestone**, following
  `.roo/skills/verify-milestone/SKILL.md` end to end.
- **Reviewing before merge** → **Code Review**, read-only, at high effort, over
  `git diff main...HEAD`.
- **Security-auditing before merge** → **Security Audit**, following
  `.roo/skills/security-audit/SKILL.md`, whenever the plan names a committed-tree security audit or
  the diff crosses a trust boundary.

**Route by the DELIVERABLE, not the topic.** Design-flavoured wording does not make it Architect
work. If the deliverable is anything other than a markdown plan or doc — a scaffold, a `src/` or
`test/` file, a `deno.json`, a commit — switch to Code. Architect owns a milestone's ONE plan file
and nothing else.

## Milestone pipeline order

Architect (plan, then stop) → _[human/Claude reviews the plan]_ → Code (implement, commit the plan
with it) → Verify Milestone (report, then stop) → Code (fix findings, commit) → **Verify Milestone
again** → Code Review (ranked findings, then stop) → Code (fix any correctness findings, commit) →
re-verify and re-review until Code Review returns **merge-ready** → Security Audit (report, then
stop — only when the plan names one or the diff crosses a trust boundary) → Code (fix findings,
commit) → re-verify, re-review, and re-audit the fix range until the audit returns **passed** or
**passed with accepted risks** → _[human pushes and opens the PR]_.

**A gate's verdict covers the commit it read and nothing later**, which is why Verify runs again
after its own findings are fixed rather than handing straight to Code Review. Skipping it sends Code
Review a tree no verification has seen, and the fix commit is the least-exercised code in the
milestone. Never skip a gate: a milestone is not merge-ready until Verify Milestone has returned
**verified** on the current commit AND Code Review has returned **merge-ready** on it AND, where the
audit applies, Security Audit has returned **passed** or **passed with accepted risks** on it.

## Committing between steps

- **Every Code-mode pass commits its own work before switching out of Code** (see
  `.roo/rules-code/01-commit-before-done.md`). Check `git status --porcelain` before you switch.
- **No gate mode may run over a dirty tree.** Verify Milestone, Code Review, and Security Audit all
  refuse, and refusing is correct — an uncommitted change can mask the exact defect they are
  hunting. So if the tree is dirty when a Code pass ends, that pass is not finished: stay in (or
  switch back to) Code, commit, and only then move to a gate.
- **The one transition that legitimately starts dirty is Architect → Code.** Architect writes the
  plan and cannot commit, so the approved plan is uncommitted by construction; Code's first
  implementation pass commits it along with the work, which is where it belongs anyway — CLAUDE.md
  requires the plan to ship in the milestone's own PR. Read the rule above as what it is: a
  constraint on entering a GATE and on leaving Code, not a blanket bar on every switch. Applied
  blindly it would make the pipeline's opening move impossible.

## Do not escalate to the human mid-pipeline

The human's only steps are **reviewing the plan** and **pushing / opening the PR**. Anything else
that feels like it "needs the user" is a mode you have not switched into yet. Do not ask to be
switched, and do not ask permission to continue the pipeline — switch, and say why in one line.

## Always

- Respect `CLAUDE.md` and the other `.roo/rules/*` in every mode you switch into.
- Do not push and do not open PRs from any mode; those are human-only steps.
