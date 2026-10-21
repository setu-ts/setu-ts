# @setu-ts/config-plugin — validated environment configuration

`setu add config` adds the dependency; every scaffold already registers `ConfigPlugin` in
`setu.config.ts` with a dotenv file. It provides `CAPABILITIES.CONFIG`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IConfig } from '@setu-ts/common';
import { ConfigPlugin } from '@setu-ts/config-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export function createConfiguredApp() {
  const app = createApplication({
    plugins: [RuntimePlugin(), ConfigPlugin({ envFilePath: '.env', envFileOptional: true })],
  });
  app.router.get('/port', (ctx) => {
    const config = ctx.services.get<IConfig>(CAPABILITIES.CONFIG);
    return ctx.response.json({ port: config.get<number>('PORT', { default: 3000 }) });
  });
  return app;
}
```

Resolve configuration before constructing plugins, then reuse the same snapshot:

```ts
import { ConfigPlugin, loadConfig } from '@setu-ts/config-plugin';
import { createRuntimeServices } from '@setu-ts/runtime';

export async function preloadConfig() {
  const config = await loadConfig(createRuntimeServices());
  return { config, plugin: ConfigPlugin({ instance: config }) };
}
```

- `ConfigPluginOptions.envFilePath` names one path or several; loading needs `fs`, which edge
  runtimes lack. `envFileOptional` skips an absent file but still throws when a present file cannot
  be read. The scaffold emits both options.
- `instance` uses a pre-loaded snapshot verbatim and ignores `envFilePath`, `envFileOptional`,
  `validationSchema` and `expandVariables`; declared `sections` still validate.
- `validationSchema` is a `StructuralSchema` (Zod-compatible). Its parse runs once after merging and
  expansion, and the parsed output becomes the snapshot, preserving coercions and defaults.
- `sections` holds `ConfigSection` values from `defineConfigSection`; read one later with
  `getConfigSection`. `expandVariables` defaults to true and expands `${NAME}` references.
- Read values only through `CAPABILITIES.CONFIG`: `config.get<T>(key)`,
  `config.get<T>(key, { default })`, `config.getOrThrow<T>(key)` and `config.has(key)`. Never read
  `process.env` directly.
- `diagnostics` is opt-in: pass the literal `enabled: true` plus key and file alias allowlists to
  record value-free provenance. Omit it and no metadata is built.
