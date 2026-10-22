# @setu-ts/config-plugin — validated environment configuration

**Add it:** `setu add config` adds the dependency; register `ConfigPlugin()` in `setu.config.ts`
(the REST scaffold already does). It provides `CAPABILITIES.CONFIG` (`IConfig`).

## Read a setting in a route

```ts
import { CAPABILITIES } from "@setu-ts/common";
import type { IConfig, IRouterApi } from "@setu-ts/common";

export function registerSettingsRoutes(router: IRouterApi): void {
  router.get("/currency", {
    handler: (ctx) => {
      const config = ctx.services.get<IConfig>(CAPABILITIES.CONFIG);
      return ctx.response.json({ currency: config.get("CURRENCY", { default: "INR" }) });
    },
  });
}
```

## Load once before constructing plugins

Pass the runtime used by your composition root, then register the returned plugin:

```ts
import type { IPlugin, IRuntimeServices } from "@setu-ts/common";
import { ConfigPlugin, loadConfig } from "@setu-ts/config-plugin";

export async function preloadConfig(runtime: IRuntimeServices): Promise<IPlugin> {
  const config = await loadConfig(runtime, { envFilePath: ".env", envFileOptional: true });
  return ConfigPlugin({ instance: config });
}
```

## Behaviour the types do not show

- Runtime environment values override dotenv files; in `envFilePath` arrays the first file wins.
- Loading merges, expands references, then validates. `expandVariables` defaults to `true`;
  `validationSchema` output becomes the snapshot, including coercions and defaults.
- Without schema coercion, environment values remain strings: `config.get<T>` does not convert them.
- `get` returns `undefined` when absent, or the supplied default; `getOrThrow` throws and `has`
  returns false for `undefined` values.
- `envFileOptional` tolerates an absent path; a present file that cannot be read still throws. Any
  configured file path requires a runtime filesystem.
- `instance` uses that snapshot directly, ignoring loading, expansion and `validationSchema`;
  declared `sections` still validate.

## Other options

- `defineConfigSection` declares prefixed `keys` and a schema; pass it in `sections` and read with
  `getConfigSection` using the same definition.
- `diagnostics` with `enabled: true` and key/file aliases enables value-free provenance under
  `CAPABILITIES.CONFIG_DIAGNOSTICS` (`IConfigDiagnosticsSource`); omitted, the source is disabled.
