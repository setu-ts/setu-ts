# @setu-ts/config-plugin

Configuration management plugin for Setu-TS with strict `.env` parsing, variable expansion, and
structurally compatible schema validation.

## Installation

```bash
deno add jsr:@setu-ts/config-plugin
```

## Quick Start

```typescript
import { createApplication } from '@setu-ts/kernel';
import { ConfigPlugin } from '@setu-ts/config-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IConfig } from '@setu-ts/common';

const app = createApplication();

app.register(RuntimePlugin());
app.register(
  ConfigPlugin({
    envFilePath: ['.env.local', '.env'],
  }),
);

await app.start();

// Access configuration
const config = app.services.get<IConfig>(CAPABILITIES.CONFIG);
const port = config.get('PORT', { default: '3000' });
```

## Options

| Option             | Type                                | Default     | Description                                                    |
| ------------------ | ----------------------------------- | ----------- | -------------------------------------------------------------- |
| `envFilePath`      | `string \| readonly string[]`       | `undefined` | Path(s) to `.env` files. No file loading when absent.          |
| `validationSchema` | `StructuralSchema<T>`               | `undefined` | Zod-compatible whole-snapshot schema for startup validation.   |
| `sections`         | `readonly ConfigSection<unknown>[]` | `undefined` | Typed, declared-key sections to validate and cache at startup. |
| `expandVariables`  | `boolean`                           | `true`      | Expand `${NAME}` references in values.                         |

## Configuration Precedence

Values are merged in the following order (highest precedence first):

1. **Environment variables** (`runtime.env`)
2. **Earlier file paths** (`.env.local` overrides `.env`)
3. **Later file paths**

`undefined` entries in `runtime.env` are filtered out.

## Dotenv Parsing

Configured files are parsed strictly at startup. Blank lines and comments are ignored; `export`
prefixes, quoted values, common double-quoted escapes, empty values, and whitespace-delimited inline
comments are supported. Malformed entries, invalid keys, and unterminated quotes fail startup with a
line number. Error messages never include the rejected value.

## Variable Expansion

When `expandVariables` is `true` (default), `${NAME}` references in values are resolved against the
final merged configuration:

```env
# .env
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_URL=postgresql://${DATABASE_HOST}:${DATABASE_PORT}/mydb
```

- Supports recursive references.
- Resolves references once, after every file and `runtime.env` have been merged.
- Detects cycles spanning any combination of sources and throws with a clear error.
- Fails for missing variable references.
- Never uses `eval` or `Function`.

## Validation with Zod

Pass a Zod schema to `validationSchema` for type coercion and validation at startup:

```typescript
import { z } from 'zod';

const AppConfigSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  DEBUG: z.coerce.boolean().default(false),
});

app.register(
  ConfigPlugin({
    envFilePath: ['.env.local', '.env'],
    validationSchema: AppConfigSchema,
  }),
);
```

- Coercions and defaults are preserved in the stored configuration.
- The schema's parsed output must be a non-null, non-array object.
- Validation errors do not disclose secret values.

## Typed Configuration Sections

Use a section when related settings should be returned with the type that its schema validated.
Sections are validated and cached during startup; `getConfigSection` never parses or asserts a value
at read time.

```typescript
import { CAPABILITIES, type IConfig } from '@setu-ts/common';
import { ConfigPlugin, defineConfigSection, getConfigSection } from '@setu-ts/config-plugin';
import { z } from 'npm:zod@^3.24.0';

const database = defineConfigSection({
  prefix: 'DATABASE_',
  keys: ['URL', 'POOL_SIZE'],
  schema: z.object({
    URL: z.string().url(),
    POOL_SIZE: z.coerce.number().int().positive(),
  }),
});

app.register(ConfigPlugin({ sections: [database] }));

const config = app.services.get<IConfig>(CAPABILITIES.CONFIG);
const settings = getConfigSection(config, database);
// settings.POOL_SIZE is a number, validated before the application started.
```

`keys` contains prefix-stripped names: `prefix: 'DATABASE_'` plus `keys: ['URL']` reads the flat
`DATABASE_URL` key and supplies `{ URL }` to the schema. The list is explicit because `IConfig`
supports named reads but deliberately has no key-enumeration method; this also lets sections
validate an arbitrary `instance` snapshot. A missing key is omitted, so the schema decides whether
it is optional. A section schema is not interchangeable with `validationSchema`: the latter receives
the whole flat snapshot, while the former receives only its declared, prefix-stripped keys.

## Hot Reload

**Deferred.** The current runtime contract has no file-watching abstraction. Configuration is an
immutable application-startup snapshot.

## Edge Runtimes

On edge platforms (Cloudflare Workers, etc.) where `runtime.fs` is `undefined`, `envFilePath` must
not be set. Attempting to do so throws a clear startup error:

> ConfigPlugin: envFilePath requires a runtime with filesystem support.

## API Reference

### `ConfigPlugin(options?)`

Creates the configuration plugin. Consumes `CAPABILITIES.RUNTIME`, provides `CAPABILITIES.CONFIG`.

### `ConfigPluginOptions`

```typescript
import type { IConfig } from '@setu-ts/common';
import type { ConfigSection, StructuralSchema } from '@setu-ts/config-plugin';

interface ConfigPluginOptions {
  readonly envFilePath?: string | readonly string[];
  readonly envFileOptional?: boolean;
  readonly validationSchema?: StructuralSchema<unknown>;
  readonly sections?: readonly ConfigSection<unknown>[];
  readonly expandVariables?: boolean;
  readonly instance?: IConfig;
}
```

### `StructuralSchema<T>`

Minimal schema interface compatible with Zod's `parse(unknown)` API.

### `ConfigSection<T>`

The typed section declaration returned by `defineConfigSection`. It carries `prefix`,
prefix-stripped `keys`, and a `StructuralSchema<T>`. Pass it in `ConfigPluginOptions.sections`, then
retrieve its validated output with `getConfigSection(config, section)`.

### `IConfig` (from `@setu-ts/common`)

```typescript
interface IConfig {
  get<T>(key: string): T | undefined;
  get<T>(key: string, options: { readonly default: T }): T;
  getOrThrow<T>(key: string): T;
  has(key: string): boolean;
}
```

## Without Schema

When `validationSchema` is not provided, all values remain as strings from the environment and
`.env` files.

## Dependencies

- `@setu-ts/common` (workspace)
- Consumer-supplied structural schema such as Zod (optional; not a package dependency)

## Exports

| Export | Kind |
| --- | --- |
| `ConfigPlugin` | function |
| `defineConfigSection` | function |
| `getConfigSection` | function |
| `loadConfig` | function |
| `ConfigPluginOptions` | interface |
| `ConfigSection` | interface |
| `StructuralSchema` | interface |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#configplugin-setu-tsconfig-plugin).
