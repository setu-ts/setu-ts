# Setu-TS website

The public website, rendered from the repository's canonical documentation. This
is an **out-of-band repository workstream** — not a framework milestone — living
on the `chore/website` branch.

## Isolation boundary (read before editing)

- This directory is **outside the Deno workspace**: it is not a member in the
  root `deno.json`, and no JSR-published package depends on anything here. All
  site dependencies live in `package.json` and are installed through Deno's npm
  support (`nodeModulesDir: auto`) — the same precedent as `apps/full-stack`,
  and the reason this works on machines without a global npm binary.
- The root `deno.json` excludes `website/` from `deno fmt` and `deno lint`; the
  site is governed by its own gates (build-time dead-link check, Lighthouse
  assertions).
- `../docs/` is the **sole canonical documentation source** and a read-only
  input: nothing in this directory may copy, edit, or reformat it. Pages render
  the files in place via the content loader in `src/content.config.ts`, and
  repository-relative links are rewritten at render time by
  `src/lib/docs-links.ts`.
- `../assets/` is the single brand-asset source. `astro.config.mjs` points
  `publicDir` at it, so the logos and favicon are copied into the build output
  without a second copy existing in the repository.

## Commands (run from this directory)

```bash
deno task install   # resolve npm deps via Deno (deno install --allow-scripts)
deno task dev       # local dev server
deno task build     # fresh API docs + Astro (dead-link check) + graft + Pagefind
deno task test      # unit tests for the link-rewriting pipeline (Deno's standard test tools)
deno task preview   # serve dist/
```

The API reference at `/api/` is **generated, not committed**: it is grafted from
`../docs/api/`, which exists only after `deno task docs:api` (repository root).
The graft step fails on purpose when it is missing; CI regenerates it from HEAD
right before every build, so the shipped site can never carry stale API docs.

Search is local and static. The build runs Pagefind **after** the API graft,
producing `dist/pagefind/`; the header search box therefore covers the rendered
guides and API reference without a search service, credentials, or runtime
backend.

CI runs `.github/workflows/website.yml`: build with link validation, unit tests,
and Lighthouse assertions (performance/accessibility/best-practices/SEO ≥ 0.9)
over the built output.

## Cloudflare Workers deployment

Cloudflare's current dashboard deploys new static sites through **Workers**
rather than the legacy Pages flow. The repository-root `wrangler.jsonc`
deliberately declares only `assets.directory`: the site is fully pre-rendered,
so it does not need a Worker script or a runtime binding. Keeping this
configuration at the repository root is required for Cloudflare's Git
deployment, which runs `wrangler versions upload` from that directory after the
build.

When configuring a Git-connected Worker, keep the repository root as the build
directory and use these commands:

```bash
# Build command
curl -fsSL https://deno.land/install.sh | sh -s v2.9.6 && export PATH="$HOME/.deno/bin:$PATH" && cd website && deno task install && deno task build

# Deploy command
npx -y wrangler@latest deploy
```

The build task regenerates the uncommitted API reference before rendering the
website. The deploy command publishes `website/dist` as static Worker assets
using the checked-in configuration. The Worker name must remain `setu-ts`,
matching the Cloudflare project name.
