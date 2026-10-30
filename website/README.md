# Setu-TS website

The public website, rendered from the repository's canonical documentation.

## Isolation boundary (read before editing)

- This directory is **outside the pnpm workspace**: it is not listed in the root
  `pnpm-workspace.yaml`, and no published package depends on anything here. It is a standalone pnpm
  project with its own `pnpm-workspace.yaml` and `pnpm-lock.yaml`, so its Astro dependency graph
  never enters the framework lockfile. Astro, Pagefind and the tests run on Node.
- The repository root Prettier and ESLint configs cover this directory (generated `dist/` and
  `.astro/` output excepted); the site adds its own gates (build-time dead-link check, Lighthouse
  assertions).
- Guides in `../docs/`, published package READMEs and agent cards, app READMEs, `CHANGELOG.md`,
  `ARCHITECTURE.md` and `PUBLIC_API.md` are read-only inputs. The content loader in
  `src/content.config.ts` renders them in place. Example pages also read the guide's ordered source
  listings from tracked app files; nothing is copied into the website source tree.
  `src/lib/docs-links.ts` rewrites repository links to these routes at render time.
- `../assets/` is the single brand-asset source. `astro.config.mjs` points `publicDir` at it, so the
  logos and favicon are copied into the build output without a second copy existing in the
  repository.

## Commands (run from this directory)

```bash
pnpm install --frozen-lockfile  # site dependencies (run the root install first)
pnpm run dev                     # local dev server
pnpm run build                   # fresh API docs + Astro (dead-link check) + graft + Pagefind
pnpm run test                    # unit tests for the link-rewriting pipeline (Vitest)
pnpm run preview                 # serve dist/
```

The API reference at `/api/` is **generated, not committed**: it is grafted from `../docs/api/`,
which exists only after `pnpm run docs:api` (repository root, which needs the root `pnpm install`).
The graft step fails on purpose when it is missing; CI regenerates it from HEAD right before every
build, so the shipped site can never carry stale API docs.

Search is local and static. The build runs Pagefind **after** the API graft, producing
`dist/pagefind/`; the header search box therefore covers the rendered guides and API reference and
the package and example pages without a search service, credentials, or runtime backend.

CI runs `.github/workflows/website.yml`: build with link validation, unit tests, and Lighthouse
assertions (performance/accessibility/best-practices/SEO ≥ 0.9) over the built output.

## Cloudflare Workers deployment

Cloudflare's current dashboard deploys new static sites through **Workers** rather than the legacy
Pages flow. `wrangler.jsonc` deliberately declares only `assets.directory`: the site is fully
pre-rendered, so it does not need a Worker script or a runtime binding.

When configuring a Git-connected Worker, set its **Root directory** to `website`. Cloudflare's Git
deployment runs `wrangler versions upload` from this directory after the build, so it must be able
to discover this configuration. Use these commands:

```bash
# Build command
corepack enable && (cd .. && pnpm install --frozen-lockfile) && pnpm install --frozen-lockfile && pnpm run build

# Deploy command
npx -y wrangler@latest deploy
```

The build command installs the repository root first because `pnpm run build` regenerates the API
reference with the root TypeDoc install. This build command is not yet verified on Cloudflare's
builder. The build task regenerates the uncommitted API reference before rendering the website. The
deploy command publishes `website/dist` as static Worker assets using the checked-in configuration.
The Worker name must remain `setu-ts`, matching the Cloudflare project name.
