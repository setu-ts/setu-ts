# Database example

This app uses `DatabasePlugin({ type: 'memory' })`, so it has no database service prerequisite. Its
routes create, read, and update a note through the public repository interface. The smoke check also
opens a transaction, writes a row, throws, and confirms that the rollback leaves the row count
unchanged.

```bash
pnpm --dir apps/database run start
pnpm --dir apps/database run smoke
```

Read the [example deep dive](../../docs/examples.md#database) for the concept and source
walkthrough.
