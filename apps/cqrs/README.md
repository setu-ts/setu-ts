# CQRS example

Uses `CqrsPlugin` to put a note through a command handler and read it through a separate query
handler.

```bash
pnpm --dir apps/cqrs run start
pnpm --dir apps/cqrs run smoke
```

The CLI places handlers at `src/cqrs/add-note.command-handler.ts` and
`src/cqrs/read-notes.query-handler.ts`; `--module` is not supported for CQRS handlers. The CLI-owned
`src/cqrs/index.ts` supplies `COMMAND_HANDLERS` and `QUERY_HANDLERS` to `CqrsPlugin`.
`src/modules/notes/notes.service.ts` owns the store token and factory; `setu.config.ts` creates a
fresh store for each application. Both handler factories resolve it from the service registry.
`notes.client.ts` sends the commands and queries used by `main.ts` and `smoke.ts`. Managed module
indexes retain the standard module shape without adding HTTP routes to this run-and-exit example.

Read the [example deep dive](../../docs/examples.md#cqrs) for the concept and source walkthrough.
