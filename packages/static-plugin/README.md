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
import { StaticPlugin } from '@setu-ts/static-plugin';

app.register(StaticPlugin({
  root: './public',
  urlPrefix: '/assets',
}));
```

## Options

| Option           | Type                           | Default                                        | Description                                                 |
| ---------------- | ------------------------------ | ---------------------------------------------- | ----------------------------------------------------------- |
| `root`           | `string`                       | (required)                                     | The filesystem directory to serve files from                |
| `urlPrefix`      | `string`                       | `'/'`                                          | URL prefix for static routes                                |
| `index`          | `string`                       | `'index.html'`                                 | Index file to serve for directories. Set to `''` to disable |
| `fallback`       | `string`                       | `undefined`                                    | Fallback file for missing paths (SPA support)               |
| `cacheControl`   | `string \| ((path) => string)` | Function returning immutable for hashed assets | Cache-Control header configuration                          |
| `etag`           | `boolean`                      | `true`                                         | Enable ETag generation                                      |
| `ranges`         | `boolean`                      | `true`                                         | Enable Range request handling                               |
| `compressed`     | `boolean`                      | `true`                                         | Enable precompressed sidecar negotiation                    |
| `maxBufferBytes` | `number`                       | `1048576` (1MB)                                | Maximum file size to read fully into memory                 |

## Cloudflare Workers

On Cloudflare Workers, `runtime.fs` is absent. The plugin registers its capability but serves no
routes. Use Workers Assets or R2 via `cloudflare-plugin` for asset serving on the edge.

## Production Use

For production traffic, we recommend placing a CDN in front of your application. This plugin is
designed for:

- Self-hosted deployments
- Development environments
- Single-origin SPA delivery

## API

### StaticPlugin

```typescript
function StaticPlugin(options: StaticPluginOptions): IPlugin;
```

### IStaticFiles

```typescript
interface IStaticFiles {
  serve(ctx: IRequestContext): Promise<HandlerResult>;
}
```

## Examples

See [`apps/static-site`](../../apps/static-site) for a complete example application.
