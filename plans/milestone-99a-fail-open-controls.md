# Milestone 99a — a control that reports safe for what it does not cover

> **Status:** Complete. Branch: `feat/m99a-fail-open-controls`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Two controls whose purpose is to answer "is this safe" and "is this alive" answer **yes** for the
case they were introduced to cover. The logger's new default redaction misses the one spelling of
`authorization` that real code produces, and the Service Bus reachability window discards a known
outage on a timer. Both fail OPEN, and both through the same reasoning error: treating "I hold no
current evidence" as "it is fine".

- **In scope:** the casing of the shipped default redaction list and the case-sensitivity of the
  path that carries it; retention of a negative data-plane outcome in `ServiceBusBroker`.
- **NOT this milestone:** any change to the redaction SEAM itself (`createRedactionService`,
  `createFieldMatcher`) — measured correct, see §1; the RabbitMQ round-trip probe (M95b, shipped and
  verified); `queue`/`cache`/`storage`/`mail` indicators (M90b/M70c, verified this run).

## 1. Contracts verified from SOURCE (not names)

| Reference                                  | Source (file:line)                                                                                                                                                                           | Verified surface / fact                                                                                                                                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_SECRET_FIELD_PATTERNS`            | `packages/common/src/redaction/classification.ts:21-28`                                                                                                                                      | six entries; five lowercase, one `'**.Authorization'` capitalised. Exported from the barrel at `packages/common/src/index.ts:228`                                                                                                                               |
| `createRedactionService` case default      | `packages/common/src/redaction/redaction-service.ts:26,28`                                                                                                                                   | `options?.caseSensitive ?? false` — the SEAM is case-INsensitive by default                                                                                                                                                                                     |
| `createFieldMatcher`                       | `packages/common/src/redaction/field-matcher.ts:13,16,22`                                                                                                                                    | takes `caseSensitive: boolean`; lowercases BOTH pattern and path segments when `false`                                                                                                                                                                          |
| `ConsoleLogger` legacy compile             | `packages/logger-plugin/src/loggers/console-logger.ts:92-97`                                                                                                                                 | builds the legacy `redact` list through `createRedactionService(..., { caseSensitive: true })` — hardcoded                                                                                                                                                      |
| `composeLoggerRedaction`                   | `packages/logger-plugin/src/plugin/logger-plugin.ts:281-287`                                                                                                                                 | same hardcoded `{ caseSensitive: true }`, this one wrapping the policy service                                                                                                                                                                                  |
| Where the defaults enter                   | `packages/logger-plugin/src/plugin/logger-plugin.ts:113,250`                                                                                                                                 | `options?.redact ?? DEFAULT_SECRET_FIELD_PATTERNS` — the defaults ride the LEGACY case-sensitive path                                                                                                                                                           |
| `ServiceBusOptions.dataPlaneEvidenceMs`    | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:213-229`                                                                                                                        | default `5000`; refused at construction unless a positive integer; "no disable arm by design"                                                                                                                                                                   |
| Evidence-vs-probe precedence               | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:216-218`                                                                                                                        | documented: below the age the window answers `reachability()`, above it the management probe answers                                                                                                                                                            |
| `classifyProbeFailure`                     | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:291-295`                                                                                                                        | returns `true` / `false` / `undefined`; `undefined` is the unknown arm the indicator maps to `up`                                                                                                                                                               |
| `IRedactionService` is what plugins accept | `packages/common/src/index.ts:233`                                                                                                                                                           | `createRedactionService` is the only constructor exported; the three sinks take a policy or a service                                                                                                                                                           |
| The defaults have THREE application points | `packages/logger-plugin/src/plugin/logger-plugin.ts:110-114,250`; `packages/logger-plugin/src/loggers/console-logger.ts:92-97`; `packages/logger-plugin/src/loggers/pino-logger.ts:43,74-77` | (a) `composeLoggerRedaction` builds ONE service from policy + legacy paths and it is passed as `redaction` to BOTH transports; (b) `ConsoleLogger` ALSO compiles the raw `redact` array itself; (c) `PinoLogger` ALSO passes the raw array to pino's own engine |

**Measured, not inferred.** Under the POLICY path the identical six patterns redact `authorization`,
`Authorization` and `apiKey` in both the logger and the audit sink (Part 12 / X54). So the seam is
correct and only its defaults are wrong — that is what makes this a one-line class of fix rather
than a redesign.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                          | Resolution (picked side)                                                                                             | Doc deliverable (same PR)                                                                                 |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| C1 | `CHANGELOG.md` `0.7.0` presents default redaction as covering "common secret-shaped fields"; the shipped list cannot match the header casing real code emits                      | The CHANGELOG describes the intent; the list is wrong. Fix the list, leave the CHANGELOG's intent sentence standing  | `CHANGELOG.md` gains a `Fixed` entry naming the casing and the behaviour change                           |
| C2 | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:216-218` documents the window as "the two signals age together", which is the behaviour that discards a known outage | The prose is accurate about what the code does and wrong about what it should do. Change the code, rewrite the JSDoc | The `dataPlaneEvidenceMs` JSDoc block, messaging README, and `PUBLIC_API.md` state the new retention rule |

## 3. Design decisions

### 3.1 How the default list stops being case-sensitive

- **Decision:** lowercase the entry to `'**.authorization'` **and** compile the DEFAULT list through
  `createRedactionService` with no `caseSensitive` argument, so it takes the seam's `false`. A
  caller-supplied `redact` array keeps `{ caseSensitive: true }`.
- **Why:** two changes because each alone is insufficient. Lowercasing alone still misses
  `Authorization` and `AUTHORIZATION`, which the exercise measured leaking. Flipping the default
  list's compilation alone leaves the odd-one-out casing in a published constant that readers copy.
  Keeping a user-supplied list case-sensitive preserves released behaviour for anyone who already
  passes `redact`, so this is not a breaking change for them.
- **Test home:** `test/unit/redaction-defaults-casing.test.ts`.

### 3.2 Where the default/user split is made

- **Decision:** `composeLoggerRedaction` takes a new internal `caseSensitive` parameter. The factory
  passes `false` only when it supplied `DEFAULT_SECRET_FIELD_PATTERNS`, then gives that composed
  service to both transports; a caller-supplied list passes `true`. Neither is a public option.
- **Why:** the composed service already runs before ConsoleLogger's legacy list and after metadata
  normalization for Pino, so routing it to ConsoleLogger fixes both implementations without adding a
  second option or changing the direct `ConsoleLogger` API.
- **Why this covers pino, which never uses our matcher for the raw array:** the composed service
  from `composeLoggerRedaction` is handed to BOTH transports as `redaction`, and on pino it runs
  "after metadata normalization and before Pino"
  (`packages/logger-plugin/src/loggers/pino-logger.ts:76-77`). That is why the exercise measured the
  leak identically on both. Pino's own engine ALSO receives the raw array and applies its own
  semantics to it; lowercasing the constant (§3.1) is what fixes that third path, which is the
  second reason both halves of §3.1 are needed.
- **Test home:** `test/unit/redaction-defaults-casing.test.ts` drives both the console and pino
  transports, because the exercise measured the leak identically on both.

### 3.3 What a recorded Service Bus outage does after the window

- **Decision:** a recorded negative data-plane outcome is retained until contradicted — by a
  successful publish, or by a management probe that positively answers reachable. The age bound
  continues to govern a recorded POSITIVE outcome only.
- **Why:** an outage does not heal by elapsed time. The asymmetry is deliberate and is the whole
  fix: a stale "it worked" is harmless because the next probe re-establishes it, while a stale "it
  failed" being discarded is precisely the fail-open.
- **Test home:** `test/unit/service-bus-evidence-retention.test.ts`.

### 3.4 What `dataPlaneEvidenceMs` means after 3.3

- **Decision:** the option keeps its name, its default and its construction-time refusal, and its
  JSDoc is rewritten to say it bounds a positive outcome. No new option.
- **Why:** renaming a published option to describe a narrowed meaning is a breaking change for a
  configuration that is already correct; the behaviour change is what the milestone ships.
- **Test home:** `test/unit/service-bus-evidence-retention.test.ts` asserts the refusal is
  unchanged.

## 4. Exported surface — every symbol names its consumer

No symbol is added to any `src/index.ts`. This milestone changes the VALUE of one exported constant
and the behaviour behind two existing options.

| Exported symbol                 | Kind     | Consumer / real code path that READS it                                                                                                            |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_SECRET_FIELD_PATTERNS` | constant | `packages/logger-plugin/src/plugin/logger-plugin.ts:113` and `:250` — the default when no `redact` is supplied. Value changes; the symbol does not |

A `barrel-exports.test.ts` in both changed packages pins that `src/index.ts` is unchanged (the M56
defect class: a re-export file is fully covered merely by being loaded).

### 4.1 Options — every option names its consumer

| Option                                  | Consumer                                                                                                            | Behavior (per implementation)                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `LoggerPlugin.redact`                   | `packages/logger-plugin/src/plugin/logger-plugin.ts:113`, `packages/logger-plugin/src/loggers/console-logger.ts:92` | unchanged: a caller-supplied list stays case-SENSITIVE. Absent, the defaults now compile case-insensitively |
| `LoggerPlugin.redaction`                | `composeLoggerRedaction`                                                                                            | unchanged — already case-insensitive via the seam                                                           |
| `ServiceBusOptions.dataPlaneEvidenceMs` | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:673`                                                   | bounds a POSITIVE recorded outcome; a negative outcome is retained until contradicted                       |

## 5. Implementation files

| File                                                          | Purpose                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/common/src/index.ts`                                | unchanged (pinned by test)                                                                   |
| `packages/common/src/redaction/classification.ts`             | `'**.Authorization'` becomes `'**.authorization'`                                            |
| `packages/logger-plugin/src/index.ts`                         | unchanged (pinned by test)                                                                   |
| `packages/logger-plugin/src/plugin/logger-plugin.ts`          | `composeLoggerRedaction` selects default/user sensitivity and is supplied to both transports |
| `packages/messaging-plugin/src/index.ts`                      | unchanged (pinned by test)                                                                   |
| `packages/messaging-plugin/src/brokers/service-bus-broker.ts` | negative-outcome retention; `dataPlaneEvidenceMs` JSDoc rewritten                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                    | src covered                                            | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/test/unit/redaction-default-patterns.test.ts`               | `redaction/classification.ts`                          | the default has `**.authorization`, not `**.Authorization`; this targets Fetch's normalized header spelling without changing the intentional `apiKey` field name                                                                                                                           |
| `packages/logger-plugin/test/unit/redaction-defaults-casing.test.ts`         | `loggers/console-logger.ts`, `plugin/logger-plugin.ts` | with stock `LoggerPlugin()`, a record built from `Object.fromEntries(new Headers({Authorization, Cookie}).entries())` has BOTH redacted. Drives `console` and `pino`. A caller-supplied `redact: ['X-Tok']` still misses `x-tok`                                                           |
| `packages/logger-plugin/test/unit/barrel-exports.test.ts`                    | `src/index.ts`                                         | the published surface is unchanged (M56 class)                                                                                                                                                                                                                                             |
| `packages/messaging-plugin/test/unit/service-bus-reachability.test.ts`       | `brokers/service-bus-broker.ts`                        | a recorded failure still resolves `reachability() === false` past `dataPlaneEvidenceMs`; a later successful publish flips it to `true`; a positive management probe also clears it; a positive outcome still ages out; the construction-time refusal of `0`/`NaN`/fractional is unchanged  |
| `packages/messaging-plugin/test/unit/barrel-exports.test.ts`                 | `src/index.ts`                                         | unchanged                                                                                                                                                                                                                                                                                  |
| `packages/messaging-plugin/test/integration/service-bus-outage-real.test.ts` | `brokers/service-bus-broker.ts`                        | **guarded real-emulator**, extends the existing M95b 2×2 gate with a fourth cell: stopped, one failed publish, then wait past the window — the indicator must still report `down`. `ignore:`-guarded on `SERVICEBUS_CONNECTION_STRING`, never an early return (the M70c vacuous-pass trap) |

The two logger files and the classification file are pure, so the per-file bar is met by the unit
tests above. `service-bus-broker.ts` is at **95.5 branch / 100.0 function / 98.9 line** (measured on
`main` with `deno task test:coverage:pkg messaging-plugin`), so the retention arm has roughly five
points of branch headroom and still needs its own cases — the retention test's four cases are those
cases, not spare capacity.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m99a-fail-open-controls, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check
```

Plus the negative controls, each observed failing and reverted:

1. Revert the casing change alone — `redaction-defaults-casing` fails on `authorization` while the
   pattern-table test passes, proving the two halves are independently load-bearing.
2. Revert the `caseSensitive` split alone — the same test fails on `Authorization`/`AUTHORIZATION`.
3. Revert the retention change — the fourth cell of the real-emulator gate reports `up`.

## 8. Risks & mitigations

- A user relying on `authorization` NOT being redacted (e.g. a debug build) sees a behaviour change
  → it is a `Fixed` CHANGELOG entry naming the change, and `redact: []` still disables entirely.
- Retaining a negative outcome could pin a broker `down` after a genuine recovery if no publish
  follows → the management probe's positive answer also clears it, so an idle-but-recovered
  deployment recovers on its next probe rather than needing traffic.
- The real-emulator gate needs the Service Bus container, which is not in the standing set → it is
  `ignore:`-guarded and the guard is asserted, so a dropped container is a visible skip.

## 9. Out of scope

- Unifying the legacy `redact` array with the `redaction` policy syntax — a seam change owned by a
  later redaction milestone; the array-path bracket-notation gap is already documented.
- The RabbitMQ and other M90b/M95b probes: re-verified this run and correct.
- Telemetry and audit redaction defaults: neither ships a default list, so neither has this defect.
