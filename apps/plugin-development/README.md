# Plugin development example

Shows a small but complete plugin: a custom capability token, an internal service, a route that
resolves the service, and a test using `@setu-ts/testing`.

```bash
pnpm --dir apps/plugin-development run start
pnpm --dir apps/plugin-development run smoke
pnpm --dir apps/plugin-development run test
```

`src/plugins/greeting.plugin.ts` remains the plugin implementation and its test exercises that
factory directly. The CLI-owned `src/plugins/index.ts` exports `GENERATED_PLUGINS`, which
`setu.config.ts` spreads into the host plugin list beside `RuntimePlugin`.

Read the [example deep dive](../../docs/examples.md#plugin-development) for the concept and source
walkthrough.
