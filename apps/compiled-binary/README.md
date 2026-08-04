# Compiled binary example

Build the kernel application as a standalone executable.

```bash
cd apps/compiled-binary
deno task compile
./hono-example
deno task smoke
```

The smoke task compiles an executable, starts it, and requests `/health`.
