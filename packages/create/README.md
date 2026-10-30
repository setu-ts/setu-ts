# @setu-ts/create

Scaffolds a new Setu-TS project with `npm create`:

```bash
npm create @setu-ts my-app
```

It runs `setu new` from [`@setu-ts/cli`](https://www.npmjs.com/package/@setu-ts/cli) with the
arguments you pass, so every `setu new` flag works here. npm needs `--` before flags meant for the
scaffolder:

```bash
npm create @setu-ts my-app -- --template rest
npm create @setu-ts demo -- --example rest-api
```

The project targets Node by default; pass `--runtime deno`, `--runtime bun` or
`--runtime cloudflare-workers` for another target. See the
[CLI README](https://github.com/setu-ts/setu-ts/tree/main/packages/cli) for every template and flag.

`--example` downloads a standalone Node example from the GitHub tag matching the CLI version. Run
`cd demo && npm install && npm start`, then `npm run smoke`; see
[the examples](https://setu-ts.dev/docs/examples/) for the offered names and prerequisites.

## Exports

| Export       | Kind     |
| ------------ | -------- |
| `createArgs` | function |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Public API

The full surface is in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#setu-tscreate).
