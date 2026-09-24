---
name: security-audit
description: Security-audit a milestone's COMMITTED tree against its plan's design security review — drive the plan's audit obligations as probes with positive controls, sweep this framework's recurring security defect classes, prove each new control with a negative control, and produce the audit record the plan requires in the PR. Use when a plan names a committed-tree security audit, when a change crosses a trust boundary (network input, credentials, authorization, tenancy, diagnostics, anything leaving the process), or when asked to security-review or audit a milestone.
---

# Security Audit

Audit whether a milestone's committed code holds against the threat model its plan committed to.
This is the third gate beside two that already exist, and it answers a different question:

| Gate               | Question                                          | Reads                    |
| ------------------ | ------------------------------------------------- | ------------------------ |
| `verify-milestone` | Does it work?                                     | the deliverable list     |
| `code-review`      | Is it correct and clean?                          | the diff, whole files    |
| `security-audit`   | Does it hold against someone trying to misuse it? | the plan's design review |

The other two gates assume a cooperative caller. This one assumes the caller is the attacker the
plan names — a process on the same host, a browser tab, a tenant reaching for another tenant's data,
a slow or hostile dependency — and asks what that caller can make the code do.

The canonical project policy lives in `CLAUDE.md` and `AI_GUIDELINES.md` §13 (Security Rules). Read
both first; this file is the procedure.

**Verdict rule: every probe produces pasted evidence. No evidence → the probe did not run → the
milestone is NOT audited.**

## What this audit is not

- **It is not the design review.** A plan that crosses a trust boundary carries a _design security
  review_ written BEFORE implementation (the M98 plans carry it as a numbered section: reviewed
  flow, assets and attackers, approved budgets, a findings table, and the obligations the
  implementation audit must meet). The audit checks the code against that review. It does not write
  the threat model after the fact — a threat model reverse-engineered from the code only describes
  what the code already does. **Whenever this audit applies — the plan names one, or the diff
  crosses a trust boundary — a missing design review is a blocking finding.** There is no exception:
  a plan that asks for an audit without saying what it must hold against has not finished its own
  design. Run the Step 4 sweep anyway, so the fix pass has the findings, and say the audit ran
  without one.
- **It is not a penetration test of anything but a local instance.** Every probe targets an
  application this run started on `127.0.0.1`, or an in-process `createApplication`. Never aim a
  probe at a remote host, a shared environment, or a real credential.
- **It is not the implementer grading themselves.** See "Independence" below.

## Independence

An audit by whoever wrote or fixed the code tends to confirm the author's assumptions — the probes
get written against the design the author already believes, and the attack the author did not
imagine is the one nobody drives. So:

- **The auditor runs in a context that did not implement or fix the milestone.** In Roo that is a
  fresh `new_task` subtask in Security Audit mode, never a `switch_mode` from the implementing
  conversation (`.roo/rules-orchestrator/01-switch-modes.md`, "The Security Audit runs in a fresh
  subtask"); for Claude it is a freshly spawned agent. The handoff is the milestone, the branch, the
  commit, the plan path, and the existing `.verify/` report paths — never a summary of the
  implementation or an argument for why it is safe. **An audit run in the implementing context does
  not satisfy the gate**: its verdict is `failed` with "not independent" as the reason, whatever its
  probes found.
- **The auditor records who implemented and who audited** (agent and mode or session), so a reader
  can check the rule above.
- **The auditor does not fix.** A finding is reported with its failure scenario and routed to a fix
  pass on the milestone's own `feat/…` branch; the audit then re-runs over the fix range (Step 7).
  An auditor who patches a finding and re-runs its own probe has proven only that its patch passes
  its probe.

## Instructions

# Step 1 — Orient on the committed tree

```bash
git branch --show-current      # the milestone's feat/… branch, never main
git status --short             # MUST be empty — a dirty tree voids the audit
git rev-parse HEAD             # the revision audited; the record names it
git log --oneline main..HEAD   # the milestone's commits
git diff --stat main...HEAD    # the audit scope: three dots diffs against the merge base, so
                               # commits that reached main after the branch point are excluded
```

"Committed-tree" means the exact commit the PR will merge. An audit of an earlier commit covers that
commit only; if code changes after the audit, the record is stale until Step 7 re-runs.

Then read:

1. **The plan's design security review** — write out, verbatim, its reviewed flow, its assets and
   attackers, its approved budgets, and every obligation it places on the implementation audit (for
   example: "plant canaries in successful data, thrown errors, names and paths; prove their absence
   from …; exercise wrong/replayed/expired/revoked and cross-instance credentials"). That list is
   Step 3's probe list.
2. **The plan's design-review findings table** — each row pairs a threat with a resolution. Each
   resolution is a claim about the code; Step 3 checks it.
3. **`AI_GUIDELINES.md` §13** — the repo's security rules (validation, sanitization, no secrets in
   code, secure defaults, no `eval`/`new Function`).
4. **The verification and code-review reports** for this milestone, if they exist under `.verify/`.
   Do not re-run their work; do read their findings, since a correctness defect on a trust boundary
   is usually a security one too.

# Step 2 — Inventory the attack surface

Build two tables from the diff and paste them into the report. Read the whole changed files, not the
hunks: an input source is often in a function the diff did not touch.

**Inputs** — everything a party outside the process can influence:

| Input | Who controls it | Where it is validated (file:line) | What it can reach |
| ----- | --------------- | --------------------------------- | ----------------- |

Look for: routes and handlers, `ctx.request` (headers, query, params, body, `formData`), protocol
upgrades, listeners and sockets, plugin options that are commonly fed from the environment
(`Number(env.X)` yields `NaN` for an unset variable), configuration and secrets, broker and queue
payloads, dependency responses (a database, a health indicator, a remote API), and anything read
back from storage another party wrote.

**Outputs** — everything that leaves the process or the trust domain:

| Output | Reader | What could leak into it | Minimization point (file:line) |
| ------ | ------ | ----------------------- | ------------------------------ |

Look for: response bodies and headers, error messages and Problem Details `detail`, log records,
metrics labels, health and diagnostics payloads, OpenAPI documents, trace attributes, broker
messages, and files written.

An input with no validation point, or an output with no minimization point, is a lead for Step 3 and
Step 4 — not yet a finding.

# Step 3 — Drive the plan's obligations, each with a positive control

For each obligation from Step 1 and each resolution in the design-review findings table, write one
probe in a scratch driver under `.verify-<milestone>/` (a plain top-level-`await` script, NOT a test
file, run with `deno run -A`), at the real surface — a kernel application, the real connector, the
real socket.

Every probe has two halves, and both are mandatory:

- **The negative half** — the thing the attacker wants does not happen: the canary is absent, the
  forged credential is refused, the second tenant reads nothing, the flood is bounded.
- **The positive control** — the legitimate thing still happens through the same path: the approved
  status still arrives, the valid credential is accepted, the owning tenant reads its row, the
  request under the bound is served. **A negative half without a positive control proves nothing** —
  a path that returns nothing at all passes every "canary absent" assertion.

**Canaries.** Plant a unique, greppable string (`canary-<layer>-<random>`) in every place the design
review says must not cross a boundary: successful payloads, thrown error messages, error `cause`
chains, names, paths, headers, credentials. Then search for it at EVERY layer the review names —
in-memory state if reachable, the wire frame, the client's parsed result, the error the caller sees,
and the captured log output — not only the final response. Search the raw bytes, not a parsed
object: a field the parser drops can still be on the wire.

Paste each probe's source and its raw stdout. Summaries are not evidence.

# Step 4 — Sweep this framework's recurring security defect classes

Each class below has shipped in this repository at least once with every gate green. For each one,
record **applies** (with the probe you ran and its result) or **N/A** (with the reason it cannot
arise in this diff). A class left unaddressed is an incomplete audit.

1. **Limit options that fail open.** For every numeric bound the diff adds or touches — size, count,
   rate, timeout, depth, interval, window — drive `NaN`, `Infinity`, `-Infinity`, `0`, a negative, a
   non-integer, and a numeric string. `NaN` makes every relational comparison false, so a bound
   silently accepts everything; `Infinity` cannot be exceeded; `0` and negatives often disable or
   invert. Expected: refused at construction with a message that does not echo the value.
   (`maxBodyBytes`, `maxNodes`, `proxyHops` in M90a; `dataPlaneEvidenceMs` in M95b.)
2. **Refusal paths that leak a resource.** For every limiter, admission check, or refusal, set the
   cap to K, drive more than K refusals, then send one legitimate request. Expected: served. Slots,
   file descriptors, timers, abort listeners, and in-flight gates are the usual leaks. (An oversized
   upgrade body starved `maxConnections` for the life of the process in M90a; a HEAD leaked a
   descriptor per request in M55; each retry added an `abort` listener in M50.)
3. **Growth from attacker-chosen keys.** For every map, registry, cache, or per-key structure a
   request can key, send 1,000 distinct keys and assert the size stays bounded, or that the bound is
   documented. (A read-only presence endpoint allocated one room per polled name in M74.)
4. **Values written into a header, a status line, a log line, or a wire field.** Drive CR, LF, NUL,
   and a value that `Headers.set` rejects. A value `Headers.set` rejects inside a handler becomes a
   `500` on every request; a value it accepts but that splits a log line forges a record.
   (`@Redirect` with a newline answered `500` forever in M97b.)
5. **Disclosure through errors, logs, and observability.** Errors, Problem Details bodies, log
   metadata, metrics labels, health data, diagnostics, and traces must not carry secrets, driver
   diagnostics, SQL, file paths, or the caller's own input echoed back. Use canaries. (Unhandled
   500s returned the failing SQL in X12-3; `http.url` shipped query strings to trace exporters
   before M96; policy failures named the missing role before M90c.)
6. **Order of authentication, authorization, and cost.** A guard must run before validation (a `400`
   listing field paths tells an unauthenticated caller the schema — M70n), before any expensive
   work, and before any admission slot is claimed. And every request path must enter the pipeline at
   all: protocol upgrades and RPC once bypassed every middleware (M70a).
7. **Client-controlled identity.** Anything the client sends that the code treats as who the client
   is — `X-Forwarded-For` (leftmost is attacker-controlled behind an appending proxy — M90a X32-3),
   an unverified JWT claim used to pick a tenant (M89a X18-4), a session presented under a different
   tenant (M70b X4-3), a cache key that omits the tenant (M70b X4-1). Probe with two identities and
   assert neither sees the other's data.
8. **Fail-open when a dependency is absent.** A missing capability, a missing policy, or an
   unreachable dependency must fail closed for anything that authorizes. Restricted routes with no
   authorization provider answer `501`, never serve (M89a). Distinguish this from health, where
   "unknown" is a reporting state rather than an access decision.
9. **Credentials and cryptography.** Web Crypto only (`runtime.subtle`); MACs verified over the
   exact received bytes BEFORE parsing; constant-time comparison where a secret is compared; replay
   refused by a sequence or nonce; expiry on the monotonic clock, never `Date.now()`; revocation
   that actually revokes (the whole refresh family and the paired access tokens — M90c); and no
   token type confusion (a refresh token must not authenticate as an access token — M90c). Drive
   wrong, replayed, expired, revoked, and cross-instance credentials, each with a valid credential
   as the positive control.
10. **Brands are not authorization.** A `Symbol.for` brand (status hints, security and validation
    metadata) is global by design: any code in the process can forge it. Confirm no brand is read as
    an access decision. Conversely, a locally created `Symbol()` misses entirely when two copies of
    a package share a process (M57, M64).
11. **Crash and hang paths.** A `Promise`-typed function that throws synchronously bypasses a
    caller's `.catch` (M52b, M52c, M70j); a rejection nothing observes, or a throw from a runtime
    callback such as `onmessage`, can kill the process (a `DataCloneError` did — M45b X8-2). A
    dependency that never settles must not hold a request, a slot, or a shutdown hostage. Drive a
    hung dependency and a synchronously throwing one.
12. **Hostile values in parsed records.** Keys `__proto__`, `constructor`, and `prototype`; a getter
    or `toString` that throws; a revoked `Proxy`; own-versus-inherited checks (`Object.hasOwn`, not
    `in`). Drive them through every record the diff parses from outside the process.
13. **Bounds applied before the cost.** A size or complexity bound must be checked before the work
    it limits is done: body bytes before buffering (M90a X32-4), document nodes before execution
    (M90a X32-6), and no attacker-controlled input into a backtracking regular expression.
14. **Secure defaults.** Every new security-relevant option defaults to the most secure value
    (`AI_GUIDELINES.md` §13.4). A changed default is a breaking change and needs a `CHANGELOG.md`
    entry with migration text naming what restores the old behavior.
15. **Deployment surface.** A listener binds loopback unless the design says otherwise (M98b binds
    `127.0.0.1` only); Deno permissions in `deno.json` tasks are scoped to exact hosts, variables,
    and paths rather than blanket grants; a new npm dependency passes `deno task audit:ci`; and
    every lazy import is a literal specifier (`scripts/npm-specifier-audit.ts`, M70e).

**Wire-level probes must use a raw socket.** The Fetch spec forbids a caller from setting `Host`,
`Content-Length`, `Connection`, `Transfer-Encoding`, `Upgrade` and similar headers, and `fetch()`
cannot send a duplicate header line at all — it silently drops or coalesces them and sends its own.
A `fetch`-based probe of a refusal on framing, authority, or a duplicate header therefore tests
something other than what it claims. It has cut both ways here: on M98b a `fetch` probe reported a
wrong-`Host` request served `200` when the raw-socket probe got `400`, and only the raw-socket
rewrite found that a forwarding header the plan said to refuse was being served. Write those
requests as bytes on a `Deno.connect` socket with `Connection: close` and read the raw response;
keep `fetch` for the happy path and for a client library's own code path.

# Step 5 — Negative controls for every new control

For each security control the milestone ADDS (a check, a bound, a refusal, a minimization step),
revert that control in the working tree, re-run the probe that is supposed to cover it, observe the
probe FAIL, then restore the file and confirm `git status --short` is empty again.

**The probe must run the reverted code, not code loaded before the revert.** A driver that imports
the package fresh on each `deno run` picks the revert up. An application already running — a server
a socket probe connects to, a started connector, a container built from the tree — still executes
what it loaded, so a probe against it passes with the control gone on disk. Stop every such target,
start it again from the reverted tree, and only then run the probe. After restoring the file,
restart the target once more before any later probe, so nothing downstream runs against the reverted
build.

A probe that still passes with its control removed was never testing it. Record each control, the
revert applied, the observed failure, and the restore. This step is the only one that edits tracked
files, and the edits never survive it: restore with `git checkout -- <file>`, never commit, and
never leave a control reverted when the run ends.

# Step 6 — Write the report and the PR audit record

Write the full report to `.verify/milestone-<N>-security-audit.md` (git-ignored scratch) and print
its path. Structure: revision audited + clean-tree confirmation → implementer and auditor → design
review reference → attack-surface tables (Step 2) → obligation probes with source and raw stdout
(Step 3) → defect-class sweep, all fifteen, applies or N/A (Step 4) → negative controls (Step 5) →
findings → support limits → verdict.

**Severity**, judged by what an attacker the plan names can actually do:

- **Critical** — read or change another party's data, bypass authentication or authorization, or
  execute code.
- **High** — leak a secret or credential, take the service down with requests the plan's attacker
  can send, or disable a security control through a plausible configuration.
- **Medium** — leak internal detail (topology, paths, versions, schema), or exhaust a resource that
  recovers without restart.
- **Low** — defense in depth, or a documentation claim that overstates a guarantee.

Each finding carries: severity, file:line, the attacker and the concrete failure scenario (inputs →
observed effect), the probe that demonstrates it, and a **disposition**: `fixed in <commit>`,
`accepted by the maintainer`, or `deferred to <milestone>`, each with its reason. A Critical or High
finding cannot be accepted or deferred without an explicit maintainer decision, and the entry names
who decided and when. That decision comes through the pipeline's one scoped handoff
(`.roo/rules-orchestrator/01-switch-modes.md`, "Do not escalate to the human mid-pipeline"); the
auditor never assumes it, and an audit that finds a Critical or High issue with no recorded decision
reports it as open.

Then write the **PR audit record** — the block the plan requires in the PR description:

```markdown
### Security audit

- **Revision audited:** `<full commit hash>` (clean tree)
- **Design review:** `plans/milestone-<N>-<desc>.md` §<section>
- **Implementer / auditor:** <who> / <who>
- **Probes:** <n> obligation probes, 15 defect classes (<a> applied, <b> N/A)
- **Negative controls:** <n> controls reverted, each observed failing, all restored
- **Findings:** <none | one line per finding: severity — summary — disposition>
- **Support limits:** <what was not verified, and why — e.g. no live backend, one runtime only>
- **Verdict:** passed | passed with accepted risks | failed
```

**Verdict:**

- **passed** — every obligation probe ran with its positive control, every defect class is
  addressed, every new control has an observed negative control, and no finding is open.
- **passed with accepted risks** — as above, except for findings a maintainer accepted or deferred
  to a named milestone, each listed with its reason.
- **failed** — any open finding, any obligation without a probe, any probe without pasted output,
  any class left unaddressed, a missing design review, or an audit run in the implementing context.

Before committing to a verdict, re-read your own evidence as the attacker would: does each probe's
raw output actually show the attack refused AND the legitimate call served? A canary search over an
empty response passes. If the evidence does not prove it, the verdict is `failed`.

# Step 7 — Re-audit after fixes

Fixes land on the milestone's `feat/…` branch, outside this audit. Afterwards, re-run from Step 1 on
the new HEAD with the fix range as new code:

```bash
git log --oneline <revision audited>..HEAD
git diff <revision audited>..HEAD
```

Re-run every probe (the fix may have broken one it did not target), re-run the negative control for
every control the fix changed, and hunt the fix range with the Step 4 classes — a fix that adds a
refusal gets class 2, a fix that adds a bound gets classes 1 and 13. The record's "Revision audited"
moves to the new hash, and the report says which range was re-audited.
