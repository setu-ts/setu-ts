# Upgrading Setu-TS

The CHANGELOG answers "what changed in the framework"; this guide answers "what must I change in
**my** project". A release that demands reader action adds an entry here, version by version — that
is a release step ([releasing.md](./releasing.md)), not a memory exercise.

Each heading names the release that **shipped** the change, so an upgrade spanning several releases
is the union of every section between the version you are on and the one you are moving to.

<!-- version:history -->

## 0.2.0

### Add `findPage` to a hand-written `IRepository`

<!-- version:history -->

`IRepository` gained a **required** `findPage(options: PageOptions): Promise<Page<Entity>>` member
in 0.2.0 (keyset cursor pagination). The `IDataSource.findPage?` the CHANGELOG's Added entry
describes is optional — a different type. If you implement `IRepository` by hand rather than
extending `BaseRepository` — the commonest case being a test double — you must now supply it:

<!-- version:history -->

```typescript
// Before — compiles until 0.2.0, then:
// TS2741 Property 'findPage' is missing in type '…' but required in type 'IRepository<UserRow, string>'.
class UserRepo implements IRepository<UserRow, string> {
  // …findById, findAll, findOne, create, update, delete, exists, count…
}

// After — the member is required on the interface.
class UserRepo implements IRepository<UserRow, string> {
  // …
  async findPage(options: PageOptions): Promise<Page<UserRow>> {
    // A cursor position, if present, continues from the last row the caller saw.
  }
}
```

The in-repo reference implementation is
[`repository-implementor.ts`](../packages/database-plugin/test/fixtures/repository-implementor.ts),
a hand-written `IRepository` that doubles as a compile-time tripwire: adding a required member to
the interface without updating it fails `deno check`.

<!-- version:history -->

## 0.1.0-alpha.10

### Remove `experimentalDecorators` from your own manifest

The decorator surface moved to TC39 standard decorators and the legacy form was removed. The
framework removed the option from all of **its own** declaration sites — that part is done for you.
What the release entry does not do for you: a project scaffolded by an earlier CLI still carries
`"compilerOptions": { "experimentalDecorators": true }` in its own `deno.json` (or the equivalent in
a generated Node `tsconfig.json`), and a migrated project that keeps it compiles its decorators
under the **legacy** semantics and fails `deno check` with `TS1238`/`TS1241` on every decorated
member.

The errors point at the decorators, not the option, which is exactly why this step needs to be
written down:

```text
TS1238  Unable to resolve signature of class decorator when called as an expression.
        The runtime will invoke the decorator with 1 arguments, but the decorator expects 2.
TS1241  Unable to resolve signature of method decorator when called as an expression.
```

Remove the key from your project's manifest and declare no compiler options at all if nothing else
needs them — declaring **any** compiler option replaces Deno's entire default set, so a project
needing none should declare none.

<!-- version:history -->

## 0.1.0-alpha.8

### Add `findOne` to a hand-written `IRepository`

The same class of change as `findPage` above, two releases earlier: `IRepository` gained a required
`findOne` member. A class implementing `IRepository` without extending `BaseRepository` must now
implement `findOne`.
