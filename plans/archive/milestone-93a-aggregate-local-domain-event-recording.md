# Milestone 93a — Aggregate-Local Domain Event Recording (`@setu-ts/events-plugin`)

> **Status:** Planning. Branch: `feat/m93a-aggregate-domain-events`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Give a domain aggregate an explicit, framework-independent recorder for facts it raises before the
application layer chooses to dispatch or durably persist them. The public `IDomainEvents` interface
and `createDomainEvents()` factory live in `@setu-ts/events-plugin`; the recorder depends only on
the existing `IDomainEvent` contract, retains no plugin context or capability, and returns ordered
read-only snapshots isolated from its mutable backing collection.

- **In scope:** Public `IDomainEvents` and `createDomainEvents()`; a private array-backed
  implementation; barrel export; unit and barrel coverage; package README, `PUBLIC_API.md`, and
  `ARCHITECTURE.md` documentation that shows save → inspect pending facts → application-selected
  dispatch/persist → remove/clear after that policy succeeds.
- **NOT this milestone:** Capability tokens, plugin registration, automatic publication, aggregate
  base classes, repository or transaction hooks, event sourcing/history replay, and an outbox.
  Milestone 93b owns typed integration-event contracts; a later reliability milestone owns
  transactional outbox and consumer inbox design.

## 1. Contracts verified from SOURCE (not names)

| Reference                    | Source (file:line)                                                                                      | Verified surface / fact                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDomainEvent<T>`            | `packages/common/src/services/events.ts:17-30`                                                          | The committed domain-fact contract has readonly `type`, `id`, `occurredOn`, `data`, and optional `aggregateId`/`version`; it contains no recording or dispatch lifecycle.                                     |
| `IEventBus`                  | `packages/common/src/services/events.ts:60-91`                                                          | The bus only exposes async `publish`, ordered `publishBatch`, and `subscribe`; it has no aggregate acknowledgement or pending-event surface.                                                                  |
| Existing event construction  | `packages/events-plugin/src/events/domain-event.ts:27-130`                                              | `DomainEvent` is runtime-backed for IDs/timestamps, while `defineDomainEvent` returns runtime-bound bases. The recorder accepts their shared `IDomainEvent` interface and creates neither timestamps nor IDs. |
| Events package boundary      | `packages/events-plugin/src/index.ts:9-18`; `packages/events-plugin/src/plugin/events-plugin.ts:70-178` | The barrel owns the package's public surface; `EventsPlugin` is the separate path that registers `CAPABILITIES.EVENTS`. The recorder will not register or resolve anything.                                   |
| Existing documentation claim | `PUBLIC_API.md:2734-2860`; `ARCHITECTURE.md:1290-1301`; `packages/events-plugin/README.md:1-75`         | Current documentation describes in-process publish/subscribe and lists its exports; none claims that aggregate-local recording already exists.                                                                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                        | Resolution (picked side)                                                                                              | Doc deliverable (same PR)                                                                                                                                                                                                 |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | None found after checking `ROADMAP.md:9413-9471`, `PUBLIC_API.md:2734-2860`, `ARCHITECTURE.md:1290-1301`, and `packages/events-plugin/README.md:1-75`. The roadmap's new recorder is absent from the older package API lists, which is expected pre-implementation rather than a contradiction. | Ship the roadmap-defined recorder as an additive events-plugin public API; it does not change the event-bus contract. | Add `IDomainEvents` and `createDomainEvents` to the EventsPlugin public API and exports lists, and document the application boundary in README and `PUBLIC_API.md`; add the recorder to the architecture package API row. |

## 3. Design decisions

### 3.1 Public contract and implementation hiding

- **Decision:** Define `IDomainEvents` in new `packages/events-plugin/src/events/domain-events.ts`
  with `record<T>(event: IDomainEvent<T>): void`, `pending(): readonly IDomainEvent[]`,
  `remove(event: IDomainEvent): boolean`, and `clear(): void`. `createDomainEvents(): IDomainEvents`
  constructs a private array-backed implementation in that same module; only the interface and
  factory are barrel-exported.
- **Why:** The factory gives an aggregate a composable field without exposing mutable implementation
  state or prescribing an entity hierarchy. `IDomainEvent` already expresses the heterogeneous event
  facts the recorder stores, so a `common` widening and an aggregate base class are both
  unnecessary.
- **Test home:** `packages/events-plugin/test/unit/domain-events.test.ts` declares aggregate-style
  fields typed as `IDomainEvents`, obtains them through `createDomainEvents`, and checks every
  interface method; `barrel-exports.test.ts` confirms both symbols are reachable through
  `@setu-ts/events-plugin`.

### 3.2 Snapshot and mutation semantics

- **Decision:** `record` appends the exact event reference. `pending` returns a new array in
  insertion order, typed `readonly IDomainEvent[]`; callers cannot mutate the backing array through
  it. `remove` locates with reference equality, removes exactly the first matching element, returns
  `true`, and returns `false` without mutation when absent. `clear` removes every pending reference.
- **Why:** An event ID is event data, not collection identity, and duplicate references are
  intentionally valid. A copied array ensures a caller can inspect and transform a snapshot without
  changing aggregate state.
- **Test home:** `domain-events.test.ts` proves insertion order, snapshot isolation, duplicate
  retention, `[A, B, A]` becoming `[B, A]` after `remove(A)`, absent removal's `false` result with
  an unchanged pending list, and `clear()`.

### 3.3 Aggregate/application boundary

- **Decision:** Documentation and the aggregate-focused test model a newly constructed or
  persistence-reconstructed aggregate creating its own recorder, then recording only facts raised
  during its current command. Application code saves first, reads `pending()`, dispatches or
  persists each fact under its own confirmed policy, and then invokes `remove` or `clear`; the
  recorder never calls `IEventBus`.
- **Why:** Publishing while aggregate invariants or durable state are unresolved couples domain
  state to infrastructure and falsely suggests a dual-write guarantee. A reconstructed aggregate
  begins with an empty recorder because historical facts are not pending effects of the current
  command.
- **Test home:** `domain-events.test.ts` instantiates an aggregate with persisted state and asserts
  `pending()` is empty until a command records a new fact; documentation examples use no event-bus
  call inside the aggregate.

## 4. Exported surface — every symbol names its consumer

| Exported symbol      | Kind      | Consumer / real code path that READS it                                                                                                             |
| -------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDomainEvents`      | interface | Application aggregate fields declare the interface and call `record`, `pending`, `remove`, and `clear` while coordinating persistence and dispatch. |
| `createDomainEvents` | function  | An application aggregate calls it when creating its recorder field; it supplies the private implementation behind the public interface.             |

### 4.1 Options — every option names its consumer

None (checked): the recorder has no configuration. Its fixed ordered snapshot and reference-removal
policy are contract behavior, not unused options.

## 5. Implementation files

| File                                                 | Purpose                                                                                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/events-plugin/src/events/domain-events.ts` | Define the public interface and factory plus the private array-backed recorder; depend only on `IDomainEvent`.                               |
| `packages/events-plugin/src/index.ts`                | Barrel-export `IDomainEvents` as a type and `createDomainEvents` as a value.                                                                 |
| `packages/events-plugin/README.md`                   | Add aggregate-local recording usage, lifecycle boundary, and both symbols to the generated exports table.                                    |
| `PUBLIC_API.md`                                      | Add the recorder contract, exact collection semantics, and save/dispatch-after-confirmation example to EventsPlugin.                         |
| `ARCHITECTURE.md`                                    | Extend the events-plugin public API row with the recorder/factory and state that it remains local rather than a distributed-event mechanism. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                 | src covered                                          | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/events-plugin/test/unit/domain-events.test.ts`  | `packages/events-plugin/src/events/domain-events.ts` | `createDomainEvents(): IDomainEvents`; `record<T>(event: IDomainEvent<T>): void`; `pending(): readonly IDomainEvent[]`; `remove(event: IDomainEvent): boolean`; `clear(): void`. Assert order, duplicates, snapshot isolation, first-only reference removal, absent no-op, clear, and an aggregate reconstructed with no pending events. |
| `packages/events-plugin/test/unit/barrel-exports.test.ts` | `packages/events-plugin/src/index.ts`                | Import `createDomainEvents` and type-import `IDomainEvents` from the public specifier; invoke factory through the barrel and record a concrete `IDomainEvent`.                                                                                                                                                                           |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m93a-aggregate-domain-events, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Before completion, also run the forbidden-construct audit for `packages/events-plugin/src`, manually
exercise an aggregate recorder through the public barrel, and on the committed tree run
`deno task publish:check` and `deno task release:verify <version>`.

## 8. Risks & mitigations

- A returned list could expose the mutable backing collection → `pending()` always returns a newly
  copied array, with a test that mutates a prior snapshot and observes unchanged later pending
  facts.
- Equality could accidentally use stable-looking `IDomainEvent.id` values → remove by `===` only and
  prove duplicate references and distinct objects with equal-shaped fields retain the specified
  order.
- A documentation example could imply automatic delivery → keep the application-controlled save,
  dispatch/persist, then remove/clear sequence explicit and omit `IEventBus` from aggregate code.

## 9. Out of scope

- No aggregate base class, `CAPABILITIES` token, plugin registration, automatic bus publication,
  event publisher, `autoCommit`, repository hook, transaction hook, or event sourcing/history
  replay; those would make local state infrastructure-coupled.
- No integration-event definition or versioned wire contract; Milestone 93b owns that
  messaging-plugin surface.
- No transactional outbox, consumer inbox, delivery retry, ordering, or exactly-once guarantee; a
  later reliability milestone must design those durable concerns.
