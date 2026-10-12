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
```

The project targets Node by default; pass `--runtime deno`, `--runtime bun` or
`--runtime cloudflare-workers` for another target. See the
[CLI README](https://github.com/setu-ts/setu-ts/tree/main/packages/cli) for every template and flag.

## API

| Export       | Kind     | Purpose                                                   |
| ------------ | -------- | --------------------------------------------------------- |
| `createArgs` | function | Maps `npm create @setu-ts` arguments onto `setu new` ones |
