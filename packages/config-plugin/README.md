# @hono-enterprise/config-plugin

Configuration management plugin for Hono Enterprise with strict `.env` parsing, variable expansion,
and structurally compatible schema validation.

## Installation

```bash
deno add jsr:@hono-enterprise/config-plugin
```

## Quick Start

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { ConfigPlugin } from '@hono-enterprise/config-plugin';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IConfig } from '@hono-enterprise/common';

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

| Option             | Type                          | Default     | Description                                           |
| ------------------ | ----------------------------- | ----------- | ----------------------------------------------------- |
| `envFilePath`      | `string \| readonly string[]` | `undefined` | Path(s) to `.env` files. No file loading when absent. |
| `validationSchema` | `StructuralSchema<T>`         | `undefined` | Zod-compatible schema for startup validation.         |
| `expandVariables`  | `boolean`                     | `true`      | Expand `${NAME}` references in values.                |

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
interface ConfigPluginOptions {
  readonly envFilePath?: string | readonly string[];
  readonly validationSchema?: StructuralSchema<unknown>;
  readonly expandVariables?: boolean;
}
```

### `StructuralSchema<T>`

Minimal schema interface compatible with Zod's `parse(unknown)` API.

### `IConfig` (from `@hono-enterprise/common`)

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

- `@hono-enterprise/common` (workspace)
- Consumer-supplied structural schema such as Zod (optional; not a package dependency)
