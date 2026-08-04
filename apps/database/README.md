# Database example

This app uses `DatabasePlugin({ type: 'memory' })`, so it has no database service prerequisite. Its
routes create, read, and update a note through the public repository interface. The smoke check also
opens a transaction, writes a row, throws, and confirms that the rollback leaves the row count
unchanged.

```bash
cd apps/database
deno task start
deno task smoke
```
