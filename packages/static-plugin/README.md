# @setu-ts/static-plugin

Static file serving plugin for the Setu-TS framework.

## Overview

Provides configurable static file serving with support for:

- Conditional requests (ETag, If-None-Match, If-Modified-Since)
- Range requests (partial content)
- Precompressed sidecar negotiation (.br, .gz)
- Directory index resolution
- SPA fallback
- Streaming for large files

## Installation

```bash
deno add jsr:@setu-ts/static-plugin
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { StaticPlugin } from '@setu-ts/static-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    StaticPlugin({
      root: './public',
      urlPrefix: '/assets',
    }),
  ],
});

await app.start({ port: 3000 });
```

## Options

| Option           | Type                                 | Default        | Description                                                           |
| ---------------- | ------------------------------------ | -------------- | --------------------------------------------------------------------- |
| `root`           | `string`                             | (required)     | The filesystem directory to serve files from                          |
| `urlPrefix`      | `string`                             | `'/`'`         | URL prefix for static routes                                          |
| `index`          | `string`                             | `'index.html'` | Index file to serve for directories. Set to `''` to disable           |
| `fallback`       | `string`                             | `undefined`    | Fallback file for SPA routing (served when Accept includes text/html) |
| `cacheControl`   | `string \| (path: string) => string` | auto           | Cache-Control header configuration                                    |
| `etag`           | `boolean`                            | `true`         | Enable ETag generation                                                |
| `ranges`         | `boolean`                            | `true`         | Enable Range request handling                                         |
| `compressed`     | `boolean`                            | `true`         | Enable precompressed sidecar negotiation                              |
| `maxBufferBytes` | `number`                             | `1048576`      | Maximum file size to read fully into memory (1MB)                     |

## Cache-Control Behavior

By default, the plugin uses content-hashed filenames (e.g., `index-a1b2c3d4.js`) to serve immutable
assets with `Cache-Control: public, max-age=31536000, immutable`. Non-hashed assets use
`Cache-Control: public, max-age=0, must-revalidate`.

You can override this with a string or function:

```typescript
StaticPlugin({
  root: './public',
  cacheControl: 'no-cache',
});

// Or per-path:
StaticPlugin({
  root: './public',
  cacheControl: (path) => path.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000',
});
```

## SPA Fallback

Enable SPA fallback by setting the `fallback` option:

```typescript
StaticPlugin({
  root: './public',
  fallback: 'index.html',
});
```

When a requested path doesn't exist and the request's `Accept` header includes `text/html`, the
plugin serves the fallback file instead of returning 404.

## Precompressed Sidecars

The plugin automatically negotiates precompressed variants. Given a request for `/app.js`, it checks
for:

1. `/app.js.br` (Brotli) — preferred
2. `/app.js.gz` (Gzip) — fallback

The `Content-Encoding` and `Vary: Accept-Encoding` headers are set appropriately.

## Health Indicator

The plugin registers a health indicator named `static-files`:

- `up` when the root directory exists
- `down` when the root is not a directory or stat fails
- `degraded` when no filesystem is available (e.g., Cloudflare Workers)

## Exports

| Export                | Type      | Description              |
| --------------------- | --------- | ------------------------ |
| `StaticPlugin`        | function  | Plugin factory           |
| `StaticFilesService`  | class     | Service implementation   |
| `createStaticHandler` | function  | Standalone route handler |
| `IStaticFiles`        | interface | Service interface type   |
| `StaticPluginOptions` | type      | Plugin options type      |

## Example Application

See [`apps/static-site/`](../../apps/static-site/) for a complete example.
