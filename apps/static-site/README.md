# static-site

Static files from public/ with an SPA fallback and a health route; the smoke check covers cache
validation and byte ranges.

Run from the repository root after installing dependencies:

```bash
pnpm --dir apps/static-site run start 3400
pnpm --dir apps/static-site run smoke
```

Read the [example deep dive](../../docs/examples.md#static-site) for the concept and source
walkthrough.
