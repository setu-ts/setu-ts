# Compiled binary example

Build the kernel application as a standalone executable.

```bash
pnpm --dir apps/compiled-binary run build:sea
./.tmp/compiled-binary/server
pnpm --dir apps/compiled-binary run smoke
```

The smoke task compiles an executable, starts it, and requests `/health`.

Read the [example deep dive](../../docs/examples.md#compiled-binary) for the concept and source
walkthrough.
