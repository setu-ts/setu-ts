# Milestone 90j — The Operator's Diagnostic Survives to the Operator (`@setu-ts/common`, `@setu-ts/database-plugin`, `@setu-ts/messaging-plugin`)

> **Status:** Implementation complete; verification pending. Branch:
> `feat/m90j-operator-diagnostics-survive`. `main` is protected — all work (implementation + fixes)
> stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Distinct from M90f, and the distinction is the whole point. M90f is about what the **caller** is
told; this is about what is left for the **operator** after masking has correctly done its job.
X12-3/M70b deliberately masks an internal error for the client **while the logger receives the real
one**. In these three rows the real one never reaches any logger, so the diagnostic is gone for
everyone.

Three shapes, measured rather than sampled. **X35-3:** `} catch {` with no binding, then
`throw new Error('Drizzle transaction failed to start')` with no `cause`, so node-postgres's own
`timeout exceeded when trying to connect` is destroyed — and it is a package-wide convention, not
one line. The original audit counted seven catch-then-throw sites; re-measurement established that
two transaction bridges rethrow their original rejection, leaving **five** wrappers that actually
drop their caught diagnostic. **X38-2:** `SerializedError` is exactly
`{ name, message, stack?, cause? }` and `readMember` is typed to those four keys, so pg's
`code: '40001'`, `severity` and `constraint`, MongoDB's `codeName` and the AWS SDK's `$metadata` are
all dropped — log-based classification, such as alerting on a `40001` rate, is impossible.
**X28-7:** `"Service Bus receiver error: AggregateError"` is the entire record, because an
`AggregateError` carries an empty `message` and its `errors` array is never read, while the publish
path in the same file logs a full cause chain.

**The fix is not "log everything."** `serializeError`'s guarded-read design is deliberate and
correct — its own JSDoc explains that a `Proxy` `get` trap can throw and that each member is
therefore read independently — and a pg error carries the failing query text and its bound
parameters, which is exactly the disclosure X12-3 exists to contain. The right shape is a small
**allowlist** of standard classifier fields, `code` first, read through the same guard, plus
`catch (cause) { throw new Error('…', { cause }); }` at the five remaining sites. Both are
mechanical, and `serializeError` already walks a cause chain when one exists.

- **In scope:** X38-2 (`SerializedError.classifiers?` from a documented scalar allowlist, and
  `errors?` for an `AggregateError`), X35-3 (the five remaining sites, plus the package-wide
  convention that keeps them fixed), X28-7 (the Service Bus receiver record, and the two sibling
  interpolation sites in the same file), and the doc deliverables C1–C3.
- **NOT this milestone:** X38-1, X35-2 and every other status question — **M90f**. Widening any
  broker's `logger` option from a string sink to a structured one (§3.5). Redaction policy —
  `logger-plugin`'s key-based redaction is unchanged and X20 records that no key-based redactor can
  remove a secret embedded in a free-text message. The `$metadata` object (§3.2, declined with
  reason).

## 1. Contracts verified from SOURCE (not names)

| Reference                                | Source (file:line)                                                                                 | Verified surface / fact                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the serialized shape                     | `common/src/errors/serialize-error.ts:24-33`                                                       | `SerializedError = { name, message, stack?, cause? }` — exactly four members, each `readonly`.                                                                                                                                                                                            |
| the guarded reader                       | `common/src/errors/serialize-error.ts:168-175`                                                     | `readMember(source: Error, key: 'name' \| 'message' \| 'stack' \| 'cause'): unknown` inside a `try`. **The key union is what has to widen**, and the guard is what must be reused rather than replaced.                                                                                   |
| why the guard exists                     | `common/src/errors/serialize-error.ts:124-130` (comment)                                           | "a `Proxy` whose target is a real `Error` and whose `get` trap throws satisfies `instanceof` and then rejects `name`, `message`, `stack` and `cause` alike … Proxy-wrapped entities are ordinary in ORMs". So each new field is read independently too.                                   |
| the cause chain is already followed      | `common/src/errors/serialize-error.ts:151-157`                                                     | `if (depth > 0 && cause !== undefined)` recurses to `MAX_CAUSE_DEPTH`, and a non-`Error` cause becomes `{ name: 'Error', message: safeString(cause) }`. **So X35-3's fix needs no serializer change** — attaching a cause is enough for it to be reported.                                |
| the five cause-dropping sites            | **re-measured on this tree**                                                                       | `drizzle-adapter.ts:295`; `mongo-adapter.ts:189`; `cosmos-partition-key.ts:127`; `cosmos-adapter.ts:171`; `dynamo-client.ts:152`. The former Drizzle and Prisma transaction bridges already rethrow their original rejection and therefore preserve its diagnostic; they are not changed. |
| the convention, re-measured on this tree | `catch` wrapping a fresh error without `{ cause }`                                                 | The five wrappers span every adapter family that still constructs a replacement error, which is why §3.3 ships a gate rather than five edits.                                                                                                                                             |
| the exemplar site                        | `database-plugin/src/adapters/drizzle/drizzle-adapter.ts:295-302`                                  | The lazy Drizzle operator load wraps an npm resolution failure with an actionable installation message but previously discarded the original resolution error.                                                                                                                            |
| the Service Bus record                   | `messaging-plugin/src/brokers/service-bus-broker.ts:374`                                           | `options.logger?.error(\`Service Bus receiver error: ${args.error}\`)`— template interpolation, so an`AggregateError`with an empty`message` renders as the bare class name.                                                                                                               |
| two more of the same in one file         | `messaging-plugin/src/brokers/service-bus-broker.ts:537,712`                                       | `\`Service Bus reply deserialization error: ${err}\``and`\`Service Bus handler error: ${handlerError}\``. The same loss, so the fix is a helper rather than one edit.                                                                                                                     |
| the sink is a **string**                 | `messaging-plugin/src/interfaces/index.ts:602,620,640,680` and `service-bus-broker.ts:204,296,465` | Every broker's `logger?` is `{ error: (msg: string) => void }`. So the record cannot carry structured metadata, which decides §3.4's shape.                                                                                                                                               |
| the publish path is already better       | `smoke/X28-FINDINGS.md` (X28-7)                                                                    | "The publish path is better — it logs a full `cause` with a stack — which shows the shape is available and this call site simply discards it."                                                                                                                                            |
| what masking is actually for             | X12-3 / M70b, `exceptions/src/middleware/error-handler.ts`                                         | The UNMASKED error is logged before masking, "regardless of masking". This milestone restores the half that path was always meant to have; it changes nothing about the response.                                                                                                         |
| the disclosure hazard to respect         | `smoke/X38-FINDINGS.md` (X38-2)                                                                    | "A pg error can also carry the failing query text and parameters, which is exactly what X12-3 exists to keep out of logs." Hence an allowlist rather than a spread.                                                                                                                       |
| ES2022 `cause` is available              | `AI_GUIDELINES.md` §12 and the package's existing target                                           | `new Error(msg, { cause })` compiles; the package already relies on ES2022 elsewhere.                                                                                                                                                                                                     |
| §2.2 dependency direction                | `AI_GUIDELINES.md` §2.2                                                                            | `database-plugin` and `messaging-plugin` both import `common` and neither imports the other. The serializer's home is `common`, which both already read.                                                                                                                                  |
| §9.4 released-behaviour rule             | `AI_GUIDELINES.md` §9.4                                                                            | `SerializedError` is published, so the additions must be optional and additive; a consumer reading the four existing members is unaffected.                                                                                                                                               |
| §10.2 / §16.1 approval                   | `AI_GUIDELINES.md` §10.2, §16.1                                                                    | The `common` widening needs a `PUBLIC_API.md` row in the same PR.                                                                                                                                                                                                                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                       | Resolution (picked side)                                                                                                                                                    | Doc deliverable (same PR)                                                                                                           |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md` documents `serializeError` as producing "a plain, serializable representation" of an error, which a reader takes to mean the error — while every driver classifier is dropped. | The behaviour changes, so the sentence becomes closer to true; and the docs state exactly which fields are carried, because an allowlist is only useful if it is published. | `PUBLIC_API.md` and `common/README.md` list the allowlisted keys, the scalar-only rule, and the `AggregateError` behaviour.         |
| C2 | The `database-plugin` sources contain replacement-error wrappers and no stated convention, while `serialize-error.ts`'s own design assumes a cause chain exists to walk.                       | State the convention where an author will meet it, and enforce it, rather than fixing five sites and trusting the next author to notice.                                    | A `CONTRIBUTING`-style note in `database-plugin/README.md`'s development section, plus the §3.3 gate that makes it checkable.       |
| C3 | `messaging-plugin`'s README documents the per-broker `logger` option as receiving errors, without saying it is a **string** sink — so a reader reasonably expects structured metadata.         | Keep the string sink (§3.5) and say so, naming what the framework renders into it.                                                                                          | README options table and `PUBLIC_API.md` state the sink's shape and that the framework renders a full cause chain into the message. |

## 3. Design decisions

### 3.1 `SerializedError` gains two optional members, read through the existing guard

- **Decision:** `SerializedError` gains
  `classifiers?: Readonly<Record<string, string | number | boolean>>` and
  `errors?: readonly SerializedError[]`, plus `omittedErrorCount?: number` — the width cap's
  counterpart. `readMember`'s key union widens to include the allowlist and `errors`; every new read
  goes through the same `try`. A serialization shares one 64-node budget across its cause tree and
  every nested aggregate; when it is exhausted the current aggregate reports its remaining direct
  entries through `omittedErrorCount` rather than recursing further.

  The count is a **typed member rather than a convention**, because §3.2's width cap is otherwise
  satisfiable by silently dropping entries: an implementation that truncates without saying so meets
  the budget and loses the fact that anything was lost, which is the class of defect this milestone
  exists to close. It is absent when nothing was omitted, so a bounded aggregate looks exactly as it
  does today, and `describeError` (§3.4) renders it into the string sink.
- **Why:** both members are additive and optional, so a consumer reading the existing four is
  unaffected (§9.4). Reusing `readMember` rather than adding a second reader is the point — the
  guarded-read design is documented as deliberate, and a spread or an `Object.entries` walk would
  defeat it in exactly the case the comment describes (a Proxy-wrapped ORM error). `errors` is a
  first-class member rather than an allowlisted key because it holds `SerializedError` values and
  must recurse under the same depth bound, which a scalar allowlist cannot express. Its **traversal
  is guarded too, not only its read**: `readMember` catches a throwing `errors` getter, and nothing
  else would catch a throwing ITERATOR on the array it returns — an `AggregateError` subclass or a
  Proxy can supply one, and `serializeError` is documented never to throw. Traversal is therefore
  indexed rather than iterated, inside its own `try`, falling back to reporting the member absent.
- **Test home:** `common/test/unit/serialize-error.test.ts` (extended) — a pg-shaped error, a Proxy
  whose `code` getter throws, an `AggregateError`, and a nested `AggregateError` at the depth bound.

### 3.2 The allowlist is scalar-only, published, and `$metadata` is declined with reason

- **Decision:** the allowlist is `code`, `errno`, `syscall`, `severity`, `constraint`, `codeName`,
  `statusCode` — `code` first. A value is carried only when it is a `string`, `number` or `boolean`;
  anything else is dropped. `$metadata` is **not** included. Four explicit budgets bound the output:
  a string classifier is at most 512 Unicode code points and appends `… [truncated]` when shortened;
  an `AggregateError.errors` member serializes at most 8 direct entries (carrying the count
  omitted); the existing `MAX_CAUSE_DEPTH` bounds cause nesting; and a whole `serializeError` call
  serializes at most 64 error nodes across both cause and aggregate edges. The global cap prevents
  nested aggregates from multiplying the otherwise bounded per-array width into an unbounded log
  record.
- **Why:** X38-2's own argument is that a pg error carries the failing query and its parameters, so
  an allowlist is what separates a classifier from a payload — and restricting to scalars enforces
  that structurally rather than by naming every dangerous key, which is a list that can only ever be
  incomplete. But scalar-only bounds the SHAPE and not the SIZE, which is why the four budgets are
  separate rather than implied: a `string` classifier has no length limit and
  `AggregateError.errors` has no width limit, so a driver returning a multi-megabyte `code` or a
  thousand-member aggregate would push that volume through a log transport **on the error path** —
  the moment a system can least afford it. `MAX_CAUSE_DEPTH` bounds depth and nothing else.
  `$metadata` is an **object**, so carrying it means the spread the finding rejects or a second
  nested allowlist; and the AWS SDK sets `name` to the exception type
  (`TransactionConflictException`, `ProvisionedThroughputExceededException`), which is what an alert
  actually keys on and which `SerializedError` already carries. Declining it is recorded in §9
  rather than left as an omission.
- **Test home:** `common/test/unit/serialize-error.test.ts` — an error carrying an object-valued
  `code` drops it; one carrying `query` and `parameters` carries neither; each allowlisted key is
  asserted by name so the published list and the code cannot drift.

### 3.3 The five sites are fixed, and a gate keeps the convention

- **Decision:** all five become `catch (cause) { throw new Error('…', { cause }); }` (or the
  package's own error class with `{ cause }`). Beyond that, a repository gate — a case in
  `database-plugin/test/unit/` — scans the package's own sources for a `catch` that rethrows without
  forwarding the caught value, and fails naming the file and line.
- **Why:** the remaining wrappers are a convention rather than five isolated mistakes, and five
  edits leave the next author with nothing to notice. A source-scanning gate is the shape this
  repository already uses for exactly this class — M70e's `npm-specifier-audit` refuses a computed
  `import()` specifier, and M71's state-key gate refuses an unnamespaced key — and both carry an
  escape marker for a deliberate exception, which this one needs too: a catch that genuinely must
  not propagate a cause (a rollback whose failure is swallowed on purpose) carries a
  `drops-cause: <reason>` marker.
- **Test home:** `database-plugin/test/unit/cause-chain-audit.test.ts`, plus one behavioural case
  per fixed site asserting the cause reaches `serializeError`'s output.

### 3.4 The broker records render a full chain into the string sink

- **Decision:** an internal `describeError(value): string` in `messaging-plugin` renders
  `serializeError`'s output — the message, the `classifiers`, the `cause` chain and an
  `AggregateError`'s `errors` — into one line. All three interpolation sites in
  `service-bus-broker.ts` (`:374`, `:537`, `:712`) use it, and the other brokers' `${err}` sites are
  swept in the same change.
- **Why:** every broker's `logger` is `{ error: (msg: string) => void }`
  (`interfaces/index.ts:602,620,640,680`), so a structured record has nowhere to go — the record
  must be a string, and the question is only whether it is a lossy one. A shared helper rather than
  three edits, because the file already demonstrates the failure mode three times and the publish
  path demonstrates the correct one, so the divergence is between call sites rather than between
  packages. `describeError` stays internal: it has no second-package consumer today, and §11.1 bites
  on the second copy rather than the first — if a second package needs it, it is promoted then.
- **Test home:** `messaging-plugin/test/unit/describe-error.test.ts` and
  `messaging-plugin/test/unit/service-bus-broker.test.ts` (extended) — an `AggregateError` with two
  members and an empty `message` renders both members; a plain `Error` with a cause renders the
  chain.

### 3.5 The `logger` option stays a string sink

- **Decision:** no broker's `logger?: { error: (msg: string) => void }` is widened.
- **Why:** widening it to accept structured metadata is a breaking change for every application that
  passes a bare `{ error: console.error }`-shaped object, and it buys nothing this milestone needs —
  the loss in X28-7 is that the value is **never read**, not that it cannot be carried. Recording
  the decision matters because "make it structured" is the obvious next suggestion and it would
  trade a complete fix for an incomplete migration. C3 documents the shape instead.
- **Test home:** `messaging-plugin/test/unit/barrel-exports.test.ts` (extended) pins that the option
  types are unchanged.

### 3.6 Nothing about the response changes

- **Decision:** no status, no body, no masking behaviour moves. `maskInternalErrors` keeps its
  `true` default.
- **Why:** this is the letter's defining boundary — M90f owns what the caller is told and this owns
  what the operator is left with. Mixing them is what would make both halves hard to review, and the
  ROADMAP separates them for that reason. Restoring the cause chain also **increases** what a log
  carries, so it is worth stating explicitly that it changes nothing about what a client can see.
- **Test home:** `database-plugin/test/integration/refusal-status.test.ts` (unchanged) and
  `exceptions`' existing masking suite, both re-run as regression checks.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                           | Kind   | Consumer / real code path that READS it                                                                                                                                                |
| ----------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SerializedError.classifiers?` (`common`) | member | Written by `serializeError`; **read by `logger-plugin`'s formatters** (which serialize the whole record) and by an operator's log backend, which is the consumer the field exists for. |
| `SerializedError.errors?` (`common`)      | member | Written by `serializeError` for an `AggregateError`; read by the same formatters and by `messaging-plugin`'s `describeError`.                                                          |

`database-plugin` and `messaging-plugin` export **nothing new** — `describeError` is internal and
the cause-chain audit is a test. Each changed barrel gets a `barrel-exports.test.ts` case (the M56
defect class).

### 4.1 Options — every option names its consumer

| Option         | Consumer | Behavior (per implementation)                                                                                                                                                                                             |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None (checked) | —        | An opt-out for the allowlist was considered and declined: the fields are scalars chosen for classification, and an application that wants fewer can filter in its own transport, which is where log policy already lives. |

## 5. Implementation files

| File                                                                                | Purpose                                                                                |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `common/src/errors/serialize-error.ts`                                              | `classifiers?`, `errors?`, the widened `readMember` key union, the allowlist constant. |
| `database-plugin/src/adapters/drizzle/drizzle-adapter.ts`                           | The lazy operator-load wrapper forwards its cause.                                     |
| `database-plugin/src/adapters/mongo/mongo-adapter.ts`                               | The transaction-unavailable wrapper forwards its cause.                                |
| `database-plugin/src/adapters/cosmos/{cosmos-adapter,cosmos-partition-key}.ts`      | Sites `:163` and `:127`.                                                               |
| `database-plugin/src/adapters/dynamo/dynamo-client.ts`                              | Site `:152`.                                                                           |
| `database-plugin/src/errors.ts`                                                     | The two exported replacement-error constructors accept native `ErrorOptions`.          |
| `messaging-plugin/src/brokers/describe-error.ts`                                    | `describeError`.                                                                       |
| `messaging-plugin/src/brokers/service-bus-broker.ts`                                | Three interpolation sites use it.                                                      |
| `messaging-plugin/src/brokers/{nats,kafka,pubsub,rabbitmq,redis-streams}-broker.ts` | The same sweep for their `${err}` sites.                                               |
| `README.md` × 2, `PUBLIC_API.md`, `CHANGELOG.md`                                    | C1–C3 and the feature entries.                                                         |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                | src covered                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/serialize-error.test.ts` (extended)                                                    | `errors/serialize-error.ts`        | A pg-shaped error yields `classifiers.code === '40001'` and `severity`; an object-valued `code` is dropped; `query`/`parameters` appear nowhere; a `Proxy` whose `code` getter throws costs that field only and the rest of the record survives; an `AggregateError` yields `errors` with both members; a nested `AggregateError` stops at `MAX_CAUSE_DEPTH`; **an over-long classifier value is truncated with its marker, and an over-wide `errors` array is capped with a count of the omitted entries** (§3.2). |
| `common/test/unit/serialized-error-contract.test.ts` (new)                                               | `errors/serialize-error.ts`        | Type-level: a consumer reading only `{ name, message }` still compiles, so the additions are provably non-breaking (the M55 `runtime-contracts` precedent).                                                                                                                                                                                                                                                                                                                                                         |
| `database-plugin/test/unit/cause-chain-audit.test.ts` (new)                                              | the five replacement wrappers      | Scans `packages/database-plugin/src` for a `catch` that rethrows without forwarding the caught value; fails naming file and line; honours a `drops-cause: <reason>` marker. It also covers the Drizzle lazy-import wrapper, whose literal import has no portable failure-injection seam. Verified to fail by reverting one site.                                                                                                                                                                                    |
| `database-plugin/test/unit/{mongo,cosmos}-adapter.test.ts` and `cosmos-partition-key.test.ts` (extended) | three injectable wrappers          | Each replacement error carries the injected driver failure as `cause`, and `serializeError` reports it at depth 1 (including a classifier where the fake driver provides one).                                                                                                                                                                                                                                                                                                                                      |
| `database-plugin/test/unit/dynamo-client-seam.test.ts` (extended)                                        | `adapters/dynamo/dynamo-client.ts` | The fifth site differs in kind and is asserted differently: `:152` catches a **`new URL()` failure**, a native `TypeError` carrying no driver classifier, so the assertion is that the native cause SURVIVES serialization. Requiring a `code` there would mean fabricating metadata the platform never produced.                                                                                                                                                                                                   |
| `messaging-plugin/test/unit/describe-error.test.ts` (new)                                                | `brokers/describe-error.ts`        | An `AggregateError` with two members and an empty `message` renders both; a two-deep cause chain renders both levels; a thrown non-`Error` renders its stringification; a hostile `Proxy` renders something rather than throwing.                                                                                                                                                                                                                                                                                   |
| `messaging-plugin/test/unit/service-bus-broker.test.ts` (extended)                                       | `brokers/service-bus-broker.ts`    | The receiver record for an `AggregateError` names its members; the two sibling sites do the same. The X28-7 regression guard.                                                                                                                                                                                                                                                                                                                                                                                       |
| `messaging-plugin/test/unit/raw-error-interpolation-audit.test.ts` (new)                                 | every broker under `src/brokers/`  | A source-level audit rejecting `${err}`-shaped interpolation of a caught value into a logger call anywhere in `src/brokers/`, with a `raw-interpolation: <reason>` escape marker. §5 sweeps five brokers and only Service Bus has a behavioural test, so a missed one would still emit the bare class name while every listed test passed — the M70e `npm-specifier-audit` shape, and cheaper than five near-identical fixtures.                                                                                    |
| `logger-plugin/test/unit/normalize-metadata.test.ts` (extended)                                          | `loggers/normalize-metadata.ts`    | A `SerializedError` carrying `classifiers` and `errors` survives normalization and redaction intact — the additions are useless if the logger drops them, and nothing today asserts it does not.                                                                                                                                                                                                                                                                                                                    |
| `*/test/unit/barrel-exports.test.ts` (extended, three packages)                                          | each `src/index.ts`                | `common` gained the two members; neither plugin's surface moved, and no `logger` option type changed (§3.5).                                                                                                                                                                                                                                                                                                                                                                                                        |

**Negative controls to run and revert before hand-off**, each observed failing:

1. Revert the Drizzle wrapper's `{ cause: error }` → the audit gate fails naming that line. The
   literal lazy import has no injectable failure seam, so the source gate is the portable regression
   proof for that wrapper.
2. Replace the allowlist with a spread of the error's own enumerable keys → the `query`/`parameters`
   assertion fails, which is §3.2's argument made observable.
3. Restore the `${args.error}` interpolation → the Service Bus record collapses to `AggregateError`,
   which is X28-7 verbatim.
4. Drop the `errors` recursion depth bound → the nested-`AggregateError` case fails or does not
   terminate, so the bound is measured rather than assumed.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m90j-operator-diagnostics-survive, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.4.0
```

Plus, with PostgreSQL and the Service Bus emulator up so the two guarded rows run:

```bash
DATABASE_URL=postgres://… SERVICE_BUS_CONNECTION_STRING=… deno task test
```

## 8. Risks & mitigations

- **An allowlist that carries a payload field would turn a diagnostic fix into a disclosure
  defect**, which is the one outcome worse than the current loss. Mitigation: scalars only, enforced
  structurally rather than by naming dangerous keys, with an explicit test that `query` and
  `parameters` appear nowhere.
- **A larger log record on the error path costs bytes at exactly the moment a system is under
  stress.** Mitigation: four budgets rather than one (§3.2) — seven scalar keys, a per-value string
  cap, a width cap on `errors`, and `MAX_CAUSE_DEPTH` on nesting. Depth alone was this plan's first
  answer and bounds neither width nor length, which is what makes the other two necessary.
- **A source-scanning gate can be wrong about intent** and block a `catch` that deliberately
  swallows. Mitigation: the `drops-cause: <reason>` marker, following `npm-specifier-audit`'s
  `computed-specifier:` precedent — and M50's lesson that a raw control character in source made a
  mandated grep silently skip a file, so the marker is plain ASCII and the gate reports the files it
  scanned as well as the ones it rejected.
- **The `logger-plugin` normalization step could drop the new members**, making the whole milestone
  invisible in a real application. Mitigation: that is its own test row, and it is the one assertion
  that connects the `common` change to something an operator can read.
- **Five adapter edits touch code covered by fakes**, so a wrong `cause` argument can pass.
  Mitigation: each injectable wrapper has a behavioural case asserting the cause reaches
  `serializeError`'s output, while the source audit protects the literal Drizzle-import wrapper.

## 9. Out of scope

- **Every status question** — X38-1, X35-2, X37-1, X20-2, X32-7 are **M90f**. This milestone changes
  nothing a client can see (§3.6).
- **`$metadata`** — §3.2: it is an object, so carrying it means the spread the finding rejects or a
  second nested allowlist, and the AWS SDK's exception type already reaches the record through
  `name`.
- **Widening any broker's `logger` option to a structured sink** — §3.5, a breaking change that buys
  nothing this milestone needs.
- **Redaction policy** — unchanged. X20 records that no key-based redactor can remove a secret
  embedded in a free-text message, and that a `SecretsService` redacting its own issued values is a
  real option that does not exist today; neither is this milestone's.
- **The other 155 `throw new` sites** that do not sit in a `catch` — they have no cause to forward.
  The audit gate targets the catch-then-throw shape specifically, which is the one that destroys
  information.
