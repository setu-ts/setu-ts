# Plugin development example

Shows a small but complete plugin: a custom capability token, an internal service, a route that
resolves the service, and a test using `@setu-ts/testing`.

```bash
pnpm --dir apps/plugin-development run start
pnpm --dir apps/plugin-development run smoke
pnpm --dir apps/plugin-development run test
```

Read the [example deep dive](../../docs/examples.md#plugin-development) for the concept and source
walkthrough.
