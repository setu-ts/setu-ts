# Milestone 123 — A styling foundation and app shell for generated UIs (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m123-app-shell-and-view-styling`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

Generated UIs start styled and shaped like a SaaS application. The `full-stack` template ships
Tailwind 4, shadcn/ui's theme and two of its components, a light/dark/system theme switch with no
flash, and a fixed app shell (viewport-height frame, header and sidebar that never move, one
scrolling content region). `setu add view` leaves a server-rendered project ready to render styled
pages: `hono` and the JSX compiler options (closing V10-64), Tailwind's standalone CLI with a `css`
build and watch step, a stylesheet with the same tokens, `StaticPlugin` serving the built CSS, and a
layout carrying the same fixed shell that an example view renders through. The boundary is the
generator: no published package's runtime behaviour changes.

- **In scope:** the full-stack template (all four runtimes), `setu add view` on Node, Bun and Deno
  (a reduced form on Cloudflare Workers, §3.11), the browser gate and scaffold e2e that prove both,
  `docs/mvc.md`, the view-plugin README, the generated READMEs, CHANGELOG, the upgrade guide, the
  ROADMAP row. Closes **V10-59** and **V10-64**; answers PRODUCT-DEFECTS **RM-2**.
- **NOT this milestone:** more shadcn components or a component gallery (the builder runs
  `npx shadcn add …`; nothing owns more); Tailwind for the REST/microservice templates without
  `setu add view` (no UI there to style); a React engine scaffold for server-rendered views (§3.12,
  documented only); serving view CSS on Workers through Wrangler static assets (§3.11, documented
  only — no milestone owns it yet, recorded in §9); a root `dev` runner that runs the CSS watcher
  beside the server (V10-60 owns workspace root scripts, M121).

## 1. Contracts verified from SOURCE (not names)

Facts measured on 2026-10-28 with the CLI built from `origin/develop` after #516, installs served by
`scripts/registry-overlay.ts`, Tailwind 4.3.3, Chromium from the in-app browser. Probe projects:
`.tmp/probe/` in this worktree (scratch, never committed).

| Reference                                | Source (file:line)                                                                                                       | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full-stack stylesheet today              | `packages/cli/src/templates/full-stack-app-files.ts:167`                                                                 | `appCss` is 13 lines: `color-scheme`, system font, body margin, `.error` padding. No tooling, tokens or theme.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Full-stack layouts today                 | `full-stack-app-files.ts:517-560`                                                                                        | `AppLayout` renders `div.app-shell > nav + main` with `classNames('nav-link', … 'is-active')`; `LoginLayout` renders `div.auth-shell > main`. Neither class has a rule anywhere — the shell is unstyled and the whole document scrolls (RM-2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `classNames` helper                      | `full-stack-app-files.ts:342-352`                                                                                        | `app/lib/utils.ts` exports `classNames(...values)`; its only caller is `AppLayout`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Root document                            | `full-stack-app-files.ts:44-75`                                                                                          | `root.tsx` imports `./app.css`, renders `<html lang='en'>`, `<Links />` in head, `<ScrollRestoration />` in body. `ScrollRestoration` saves and restores `window.scrollY` only (`react-router/dist/development/lib/dom/lib.js:1084-1133`: `window.scrollTo`, never an element).                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Vite config                              | `full-stack-build-files.ts:54-130`                                                                                       | `renderViteConfig` emits `plugins: [reactRouter()]` plus the externals list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Full-stack npm sections                  | `full-stack-build-files.ts:230-257`                                                                                      | `FULL_STACK_NPM_DEV_DEPENDENCIES` (React Router, React, types, typescript, `vite ^8.0.0`) and `FULL_STACK_NPM_DEPENDENCIES` (react-router, react, react-dom). A Deno full-stack project carries these in `package.json` (probe `fsdeno/package.json`); `frameworkImports` maps every `npmDependencies` entry into `deno.json` `imports` automatically (`templates/project-files.ts:1160-1167`), so a new runtime dependency needs no separate Deno entry.                                                                                                                                                                                                                                                      |
| Full-stack security headers              | `packages/cli/src/templates/full-stack.ts:168`; `http-security-plugin/src/middleware/security-headers-middleware.ts:168` | The template sets only `referrerPolicy`; CSP has **no default** ("only when explicitly configured"), so an inline `<head>` script runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Tailwind in the full-stack build (probe) | probes `fsnode`, `fsdeno`, `fs-bun`, `fs-cloudflare-workers`                                                             | `tailwindcss` + `@tailwindcss/vite` 4.3.3 in `devDependencies`, `plugins: [tailwindcss(), reactRouter()]`, `app.css` = `@import "tailwindcss"`: every runtime's `build` emits `build/client/assets/root-*.css` containing `.h-dvh{height:100dvh}`. Node (`node:24-alpine`), Deno (Debian frontend stage) and Bun (`oven/bun:1-alpine`) images build — the native `@tailwindcss/oxide`/`lightningcss` bindings resolve on musl — and serve the CSS `200 text/css` read-only.                                                                                                                                                                                                                                    |
| `setu add view` today                    | `packages/cli/src/commands/add.ts:177`, `:223`                                                                           | `ADDABLE` `view → view-plugin` with no `peers`; `ZERO_CONFIG_WIRINGS` inserts `ViewPlugin()`. Probe `vnode`: the diff is the pin and the call, nothing else — no `hono`, no `jsx`/`jsxImportSource` (V10-64 reproduced).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Peer-write path (M119f)                  | `add.ts:88-103` (`IAddablePackage.peers`); `templates/client-dependencies.ts:20-60`                                      | `peers.packages` are written at their `CLIENT_RANGES` range into `dependencies` or a Deno import map as `npm:<name>@<range>`, through the M119f shape handling (overrides, dev-only pins, BOM, workspace root). `CLIENT_RANGES` has no `hono` entry today.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `hono` range                             | `packages/view-plugin/package.json:41`; `scripts/node-manifests.ts:588`                                                  | view-plugin depends on `hono ^4.12.30` (`EXTERNAL_RANGES.hono`). README says the application must declare it directly (pnpm and Deno do not expose a transitive one).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Provider insertion in `setu add`         | `add.ts:830-895` (`withPluginWiring`)                                                                                    | Inserts `Factory(<seam args>)` before the single `...(devtool?.plugins ?? [])` array element of the factory; returns `undefined` (→ printed "Register …" line) when that anchor is absent or repeated, the config is starter-composed (`composingStarter`), the factory is already referenced, or imports are in an unrecognized form. Args come only from a seam: it cannot render `StaticPlugin({ root, urlPrefix })` today. Probe `anchor-cfw`: a Workers REST config has no devtool anchor, so `setu add view` prints "Register ViewPlugin()" and inserts nothing.                                                                                                                                         |
| Route-registration anchor                | probes `vnode`, `vdeno`, `vbun`, `anchor-class-based`, `anchor-none`, `anchor-microservice`, `anchor-cfw`                | Every non-starter config — functional and class-based, all four runtimes — calls `registerGeneratedRoutes(app.router, app.services)` exactly once. `registerModules(` is absent from class-based configs, so it is not a usable anchor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Copied components (probe)                | probes `fsnode`, `fsdeno`, `fs-cloudflare-workers`                                                                       | Registry Button and Card with the `cn` import rewritten to `~/lib/utils.ts`, deps `clsx`, `tailwind-merge`, `class-variance-authority`, `radix-ui`: Node `check` + `build`, Workers `check` + `build`, Deno `check` + `check:app` all pass; the Button server-renders with `data-slot="button"` and its variant classes on Node (`node dist/main.js`) and Workers (`wrangler dev`, 200).                                                                                                                                                                                                                                                                                                                       |
| Workers view (probe)                     | probe `anchor-cfw`                                                                                                       | With `hono`, `jsx`/`jsxImportSource: "hono/jsx"` in `tsconfig.json` and `ViewPlugin()` registered by hand, `wrangler dev` serves a `.tsx` view `200 text/html` — Wrangler's bundler honours the tsconfig. Without the registration it answers 500 (`renderView() requires a CAPABILITIES.VIEW provider`). A Workers project carries both `tsconfig.json` and `deno.json`; the peer loop writes every manifest present (`add.ts:1065-1075`).                                                                                                                                                                                                                                                                    |
| Docs gate task names                     | `scripts/toolchain-prose.ts:415`                                                                                         | `generatedDenoTasks` is `['build','check','dev','install','proto:gen','start','test']`; prose naming any other `deno task <name>` is refused (`:476`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `StaticPlugin` options                   | `packages/static-plugin/README.md:34-51`                                                                                 | `root`, `urlPrefix` (default `'/'`); registers `<urlPrefix>/*` on GET/HEAD. On Workers it reports `fs: false` (`:139`) — no filesystem to serve from.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| View CSS through `build/` (probe)        | probes `vnode`, `vdeno`, `vbun`                                                                                          | `@tailwindcss/cli -i src/views/styles.css -o build/assets/app.css --minify` plus `StaticPlugin({ root: './build/assets', urlPrefix: '/assets' })`: each read-only image serves `/pages` 200 and `/assets/app.css` 200 `text/css` with no Dockerfile change, because M120's images already copy `buil[d]` (Node `COPY --from=build /srv/buil[d] ./build/`; Deno frontend stage runs `deno task build` when the task exists; Bun runs `build` when the script exists). `tsc --noEmit` and `setu build` (esbuild) accept the `.tsx` views with `jsxImportSource: "hono/jsx"`.                                                                                                                                     |
| Tailwind CLI under Deno (probe)          | probe `vdeno`                                                                                                            | `deno run -A npm:@tailwindcss/cli@^4.3.3 …` FAILS `Can't resolve 'tailwindcss'` unless `tailwindcss` is in the import map and installed (`nodeModulesDir: "auto"`, `deno install`); with `"tailwindcss": "npm:tailwindcss@^4.3.3"` and `deno install` first, it builds. `deno check` resolves `hono/jsx/jsx-runtime` from `"hono": "npm:hono@^4.12.0"` plus `compilerOptions.jsx/jsxImportSource`.                                                                                                                                                                                                                                                                                                             |
| Fixed shell + theme in Chromium (probe)  | probe `vnode` image, in-app Chromium                                                                                     | Layout `flex h-dvh flex-col overflow-hidden` + `h-14 shrink-0` header + `min-h-0 flex-1` row + `overflow-y-auto` main: content `scrollTop` 3000 → `window.scrollY` 0, header top 0, sidebar top 56. Inline head script reading `localStorage.theme`: `'light'` → no `dark` class, body `oklch(1 0 0)`; `'dark'` → `dark` class, body `oklch(0.145 0 0)`.                                                                                                                                                                                                                                                                                                                                                       |
| shadcn sources (registry, new-york-v4)   | `https://ui.shadcn.com/r/styles/new-york-v4/{button,card}.json`                                                          | Button imports `cva` (`class-variance-authority`), `Slot` from `radix-ui`, and `cn` from the `cn` npm package; Card imports only `cn`. `cn` is shadcn's own package (`npm view cn`: maintainer `shadcn`, repo `shadcn-ui/cn`, 0.5.0, no dependencies; `cn('p-2', false, 'p-6')` → `p-6` on Node and Deno). shadcn CLI 4.23.0 with this plan's `components.json` writes `import { cn } from "cn"` and installs `cn` on `add`; its `init` now defaults to style `base-nova` (Base UI), and `add` under `new-york` still serves the Radix sources (probes `fsnode`, `fsnode-init`). Registry `index` lists `tw-animate-css` as a dev dependency (used by animated components only; neither of ours). Licence MIT. |
| npm versions                             | `npm view` 2026-10-28                                                                                                    | tailwindcss / @tailwindcss/vite / @tailwindcss/cli 4.3.3; class-variance-authority 0.7.1; tailwind-merge 3.7.0; clsx 2.1.1; radix-ui 1.8.1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| React Router's own starter               | `remix-run/react-router-templates` `default/package.json`                                                                | Ships `tailwindcss` + `@tailwindcss/vite` (^4.2.2) in devDependencies; shadcn's React Router guide starts from it and keeps the `~/*` alias.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Browser gate                             | `.github/workflows/ci.yml:31-49`; `apps/full-stack/browser/full-stack.browser.test.ts:20-47`                             | A `browser` job installs Playwright 1.63.0 Chromium and runs `pnpm run check:browser`, which already scaffolds a fresh Node full-stack project through the overlay and runs the same Chromium checks over it and `apps/full-stack`. The job installs neither Bun nor Deno.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Scaffold e2e                             | `packages/cli/test/e2e/scaffold-runs-e2e.test.ts`                                                                        | Formats, lints, installs, type-checks and boots each template per runtime, then requests advertised endpoints (CLAUDE.md, M63).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                     | Resolution (picked side)                                                                                                                                | Doc deliverable (same PR)                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| C1  | The view-plugin README's Installation section tells the developer to add `hono` and the JSX options by hand; after M123 `setu add view` does it.             | The README keeps the manual steps (a project not using the CLI still needs them) and gains one line naming `setu add view` as the way that writes them. | `packages/view-plugin/README.md` Installation.                         |
| C2  | ROADMAP §M123 lists "whether a component library is scaffolded or left to `npx shadcn`" as open; the maintainer chose to copy a few components (2026-10-28). | The decision governs (§3.4); the ROADMAP section records it when the deliverables are checked.                                                          | `ROADMAP.md` §M123 deliverables + Progress row `123`.                  |
| C3  | ROADMAP §M123's `setu add view` e2e names Node, Bun and Deno; the CLI also accepts `--runtime cloudflare-workers`, where `StaticPlugin` has no filesystem.   | Workers gets the V10-64 half only (§3.11); the ROADMAP line stays as written and the Workers behaviour is documented.                                   | `docs/mvc.md` "Styling server-rendered views" names the Workers limit. |

## 3. Design decisions

### 3.1 Full-stack styling foundation: Tailwind 4 through Vite

- **Decision:** `FULL_STACK_NPM_DEV_DEPENDENCIES` gains `tailwindcss` and `@tailwindcss/vite` at
  `^4.3.3`; `renderViteConfig` imports `tailwindcss` from `@tailwindcss/vite` and emits
  `plugins: [tailwindcss(), reactRouter()]`. One shared constant `TAILWIND_RANGE = '^4.3.3'` in a
  new `packages/cli/src/templates/ui-tokens.ts` feeds both this and §3.7. No PostCSS config.
- **Why:** maintainer decision (2026-10-28); React Router's own starter ships exactly this, and
  shadcn/ui assumes it. Probed on all four runtimes and in the Node, Deno and Bun images (§1).
- **Test home:** `full-stack-template.test.ts` (vite config and devDependencies); scaffold e2e and
  browser gate (built CSS served).

### 3.2 One token stylesheet, shared by both stories

- **Decision:** `ui-tokens.ts` exports `renderTokenCss()`: shadcn new-york-v4's **neutral** theme as
  CSS custom properties — `:root` and `.dark` blocks for `background`, `foreground`, `card`,
  `card-foreground`, `popover`, `popover-foreground`, `primary`, `primary-foreground`, `secondary`,
  `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`,
  `border`, `input`, `ring`, `radius` — then `@custom-variant dark (&:where(.dark, .dark *));`,
  `@theme inline` mapping each to `--color-*` (and `--radius-sm…xl` from `--radius`), and
  `@layer base { * { @apply border-border outline-ring/50; } body { @apply bg-background text-foreground; } }`.
  The values are copied from the registry's neutral theme at implementation time and pinned in the
  source; a unit test asserts every listed token is defined in both blocks. The full-stack
  `app/app.css` is `@import "tailwindcss";` + this block; the view stylesheet (§3.7) is the same
  plus nothing else. The old `.error` rule becomes utilities on the error boundary.
- **Why:** `bg-primary`, `text-primary-foreground` and the other token classes produce no CSS
  without these variables (VIEW-STYLING-PROBE); one renderer keeps the two stories identical.
- **Test home:** `ui-tokens.test.ts`; `full-stack-template.test.ts`; `add-view.test.ts`.

### 3.3 shadcn-ready project shape

- **Decision:** the full-stack template writes `components.json` (`style: "new-york"`, `rsc: false`,
  `tsx: true`,
  `tailwind: { config: "", css: "app/app.css", baseColor: "neutral", cssVariables: true }`,
  `iconLibrary: "lucide"`, aliases `components: "~/components"`, `utils: "~/lib/utils"`,
  `ui: "~/components/ui"`, `lib: "~/lib"`, `hooks: "~/hooks"`), so `npx shadcn add <component>`
  works without `init`. Class names are combined with shadcn's own `cn` package (`cn ^0.5.0` in
  `FULL_STACK_NPM_DEPENDENCIES`, rendered on the server and in the browser): `AppLayout` imports
  `cn` from `'cn'`, and `app/lib/utils.ts` (whose only export, `classNames`, had one caller) is no
  longer emitted. No `clsx` or `tailwind-merge`. `iconLibrary` adds no dependency: shadcn installs
  `lucide-react` when a component that needs it is added. `new-york` is kept although shadcn 4.23's
  `init` now defaults to `base-nova`: `add` still serves `new-york` (Radix) sources, consistent with
  the copied pair.
- **Why:** maintainer decisions 2026-10-28 (copy components; follow upstream's `cn` package; keep
  `new-york`). Current shadcn sources import `cn` from the `cn` package and `shadcn add` installs it
  (§1), so a local helper would leave every later-added component on a second implementation.
- **Test home:** `full-stack-template.test.ts` (components.json fields, `cn` dependency, no
  `app/lib/utils.ts`, no `clsx`/`tailwind-merge`); scaffold e2e (type-check, and the generated
  project's `cn('p-2', false, 'p-6')` prints `p-6`).

### 3.4 Two copied shadcn components, used by the template

- **Decision:** `app/components/ui/button.tsx` and `app/components/ui/card.tsx`, copied from the
  new-york-v4 registry sources with exactly one edit: a header comment naming the source URL and
  shadcn/ui's MIT licence (the `import { cn } from "cn"` line stays, §3.3). Formatting follows the
  template. `class-variance-authority` and `radix-ui` join `FULL_STACK_NPM_DEPENDENCIES`, which also
  maps them into a Deno project's import map (§1). Used by the template: the theme toggle (§3.6) and
  the login submit are `Button`s; the landing page and the products page render inside `Card`. The
  sources live in a new `packages/cli/src/templates/full-stack-ui-files.ts`.
- **Why:** maintainer decision; two components prove the setup end to end (a variant component with
  `cva` + `Slot`, a plain one) without the template owning a component library.
- **Test home:** `full-stack-template.test.ts` (files present, licence header, imports identical to
  the registry's, dependencies); browser gate (the primary button renders with `--primary`).

### 3.5 The fixed app shell

- **Decision:** `AppLayout` renders `div[data-shell=frame].flex.h-dvh.flex-col.overflow-hidden` >
  `header[data-shell=header].h-14.shrink-0.border-b` (app name + theme toggle) +
  `div.flex.min-h-0.flex-1` >
  `aside[data-shell=sidebar].hidden.md:block.w-56.shrink-0.overflow-y-auto.border-r` (the nav) +
  `main[data-shell=content].flex-1.overflow-y-auto.p-6` (`<Outlet />`). Below `md` the sidebar is
  hidden and the same `APP_NAV` renders as a horizontal, horizontally scrollable row directly under
  the header, still inside the frame. Because the window never scrolls, `<ScrollRestoration />`
  cannot reset position on navigation: `AppLayout` holds a ref to `main` and sets `scrollTop = 0` in
  an effect keyed on `pathname`. Tailwind's preflight removes browser defaults, so the template's
  own content carries utilities: page headings `text-2xl font-semibold`, paragraphs and lists spaced
  (`list-disc pl-5` on lists), inline links `font-medium underline underline-offset-4`, and form
  fields `h-9 w-full rounded-md border border-input bg-transparent px-3` with their labels stacked
  (`grid gap-2`). `LoginLayout` is a centred `min-h-dvh` grid with the form in a `Card`. Active nav
  links use `cn(…, 'bg-accent text-accent-foreground')`.
- **Why:** RM-2 — the expected SaaS behaviour, measured working in §1; `data-shell` attributes give
  the tests stable hooks independent of class names. The scroll reset is the consequence of moving
  scrolling off the window.
- **Test home:** browser gate (scroll content 3,000 px → `window.scrollY` 0, header and sidebar
  `getBoundingClientRect().top` unchanged; navigate after scrolling → content `scrollTop` 0; at 375
  × 812 the header stays at 0 and `document.documentElement.scrollWidth` ≤ viewport width).

### 3.6 Theme: light, dark and system, no flash

- **Decision:** `ui-tokens.ts` exports `THEME_STORAGE_KEY = 'theme'` and `renderThemeScript()`, an
  IIFE that reads `localStorage[THEME_STORAGE_KEY]`; `'dark'`, or anything but `'light'` while
  `prefers-color-scheme: dark` matches, adds `dark` to `<html>` and sets `style.colorScheme`; every
  storage error is swallowed (private mode). The value is only compared, never written into the DOM.
  Full-stack: `root.tsx` renders it as the first child of `<head>` via
  `<script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />` (the constant is emitted into
  `app/lib/theme.ts`) and sets `suppressHydrationWarning` on `<html>`.
  `app/components/theme-toggle.tsx` (a ghost icon `Button`) cycles system → light → dark, writes or
  removes the key, re-applies the class, and while on system follows `matchMedia` changes. With
  JavaScript disabled the page renders light. The view layout (§3.7) uses the same script through
  hono's `raw()` and a toggle bound by a second small inline script. Docs state that an application
  adding a CSP must allow these scripts by hash or nonce.
- **Why:** maintainer decision; same approach as Phoenix 1.8 and next-themes; no route, cookie or
  session dependency, identical on every runtime. No CSP is set by default (§1).
- **Test home:** `ui-tokens.test.ts` (script executed in a `node:vm` context against fake
  `localStorage`/`matchMedia`/`document` for every case: stored light/dark/absent × system
  light/dark × throwing storage); browser gate (stored `dark` → `<html>` has `dark` at
  `DOMContentLoaded`, recorded by an init script before any module script runs; toggle cycles and
  persists across reload; emulated `prefers-color-scheme: dark` with no stored value → dark).

### 3.7 `setu add view` scaffolds the Tailwind setup

- **Decision:** a new `packages/cli/src/commands/add-view.ts` exports `planViewSetup(input)`, a pure
  planner over what the target already contains, returning
  `{ files, manifestEdits, configEdits, notes }`; `runAddCommand` calls it after the existing
  view-plugin pin and `ViewPlugin()` insertion, writes the planned changes through the existing
  writers (so `--dry-run` lists them, M119h), and prints the notes. Pieces, each written only when
  absent:
  1. **`hono`** — `ADDABLE` `view` gains
     `peers: { runtimes: ['node', 'bun', 'deno', 'cloudflare-workers'], packages: ['hono'] }` and
     `CLIENT_RANGES.hono = '^4.12.30'` (equal to `EXTERNAL_RANGES.hono`; a unit test pins the
     equality). This reuses the M119f write path and its shape handling (§1). Closes V10-64's
     dependency half.
  2. **Compiler options** — Node, Bun and Workers: `tsconfig.json`
     `compilerOptions.jsx = "react-jsx"`, `jsxImportSource = "hono/jsx"` (Wrangler's bundler reads
     it — §1); Deno: the same keys in `deno.json` `compilerOptions`. When one of those keys already
     holds another value (a React project), or the file is not plain JSON, nothing is written and
     the note names the per-file pragma `/** @jsxImportSource hono/jsx */`. Closes V10-64's compiler
     half.
  3. **Tailwind** — npm/Bun: `tailwindcss` and `@tailwindcss/cli` at `TAILWIND_RANGE` in
     `devDependencies` (an existing pin in `dependencies` or `devDependencies` counts as present);
     Deno: import-map entries `"tailwindcss": "npm:tailwindcss@^4.3.3"` (required — §1 probe) and
     the tasks run the CLI as `npm:@tailwindcss/cli@^4.3.3`.
  4. **Files** — `src/views/styles.css` (`@import "tailwindcss";` + §3.2 tokens),
     `src/views/layout.tsx` (`Layout({ title, children })`: the §3.5 shell markup in hono JSX with
     `class` attributes, the §3.6 theme script and toggle,
     `<link rel="stylesheet" href="/assets/app.css">` in `<head>`), `src/views/home.tsx` (an example
     page using shadcn's card and button class recipes as plain class strings, no React), and
     `src/views/routes.ts` exporting `registerViewRoutes(router: IRouterApi): void`, which registers
     `GET /ui` rendering `Home` through `renderView`. An existing file at any of these paths is left
     untouched and named in the notes.
  5. **Registration** — two insertions, both failing closed to a printed line:
     - `StaticPlugin({ root: './build/assets', urlPrefix: '/assets' })`, plus the
       `@setu-ts/static-plugin` pin when absent. `withPluginWiring` gains an internal optional
       `args` parameter (used instead of the seam's when given; no seam and no args keeps today's
       bare call) and `static-plugin` is NOT added to `ZERO_CONFIG_WIRINGS`, so `setu add static`
       keeps its existing guidance. Every existing refusal applies unchanged: no single devtool
       anchor, a starter-composed config, an existing `StaticPlugin` reference, an unrecognized
       import form.
     - `registerViewRoutes(app.router);` on its own line directly after the factory's single
       `registerGeneratedRoutes(app.router, app.services);` statement — present in every non-starter
       config, both styles, all runtimes (§1); `registerModules(` is not, so it is not used — with
       `import { registerViewRoutes } from './src/views/routes.ts';`. Refused when that statement is
       absent or repeated, the config is starter-composed, or `registerViewRoutes` is already
       referenced. A new internal `withRouteRegistration(source)` in `add-view.ts`, built on the
       same `factoryScope`/`maskComments`/`referencesIdentifier` helpers as `withPluginWiring`. The
       route is inserted when the factory calls `ViewPlugin` — inserted by this run, or already
       registered (an earlier `setu add view` on 0.10.0 wired only the plugin). When it is neither
       (no devtool anchor — every Workers config, §1 — or a starter-composed config), the route is
       not inserted and the note says the route needs the plugin registered first.
  6. **Scripts** — npm/Bun: `css` =
     `tailwindcss -i src/views/styles.css -o build/assets/app.css --minify`, `css:watch` = the same
     with `--watch`; `build` is prefixed `npm run css && ` (Bun: `bun run css && `), or created as
     the `css` call when absent (Bun REST has none); `start:dev` is prefixed the same way so the
     first boot is styled. Deno: tasks `css`
     (`deno install && deno run -A npm:@tailwindcss/cli@… …`), `css:watch`, `build`
     (`deno task css`, or prefixed when present) and the `start:dev` prefix. A script or task
     already named `css`/`css:watch`, or a `build`/`start:dev` that already runs `css`, is left
     alone and named in the notes.
  7. **`.gitignore`** — `build/` appended when the file exists and no line ignores it. A second
     `setu add view` plans nothing and prints only the already-present notes.
- **Why:** maintainer decision 2026-10-24 (ROADMAP) for the set; maintainer decision 2026-10-28 for
  "write only what is absent, print what exists, never overwrite". `build/assets` reuses M120's
  image copy on all three runtimes with no Dockerfile change (§1). A separate `css:watch` matches
  Rails (`tailwindcss:watch`) and Phoenix (a `tailwind` watcher); a combined runner is V10-60's.
- **Test home:** `add-view.test.ts` (planner table: each piece × absent/present/conflicting, per
  runtime; idempotence; `withRouteRegistration` accept and refuse cases);
  `packages/cli/test/unit/commands/add.test.ts` (end-to-end over a memory filesystem: files,
  manifests, dry-run listing; `withPluginWiring` with explicit args); scaffold e2e (§3.9).

### 3.8 Images and `check:deploy`

- **Decision:** no Dockerfile or `.dockerignore` change. `scripts/check-deploy.ts --generated` gains
  one case: a Node REST project after `setu add view`, built read-only with no network, asserting
  `/ui` 200 and `/assets/app.css` 200 `text/css` containing `.h-dvh`.
- **Why:** probed working on all three runtimes (§1); one gated case keeps the `build/` copy
  contract from regressing silently. Node only, matching the existing generated-image cases' cost.
- **Test home:** `scripts/check-deploy.ts` case + `test/deploy-gate.test.ts` for its table entry.

### 3.9 Scaffold e2e

- **Decision:** `scaffold-runs-e2e.test.ts` gains, per Node, Bun and Deno, plus one Node
  `--template class-based` case (the other route style): `setu new --template rest` →
  `setu add view` → install → build (CSS included) → type-check → boot → `GET /ui` 200 with the
  stylesheet link and `data-shell="frame"`, `GET /assets/app.css` 200 `text/css` containing
  `.h-dvh`. The existing full-stack cases additionally assert the built client CSS contains `.h-dvh`
  and a `--primary` definition, and `deno fmt`/Prettier pass over every new file.
- **Why:** CLAUDE.md requires a booted scaffold for generator changes; the CSS assertions are what
  "styled" means without a browser.
- **Test home:** itself.

### 3.10 Browser gate

- **Decision:** the existing browser suite's scaffold target gains the §3.5 and §3.6 assertions for
  the full-stack scaffold. A new `apps/full-stack/browser/view-scaffold.browser.test.ts` scaffolds
  REST + `setu add view` on Node, Bun and Deno, builds, boots, and asserts in Chromium the fixed
  shell, the stored-theme application at `DOMContentLoaded`, a computed `--primary` background on
  the example button, and the stylesheet `<link>` preceding `<body>` (render-blocking, so no
  unstyled first paint). The `browser` CI job adds `oven-sh/setup-bun@v2` (bun 1.4.0, as M120's
  deploy job) and `denoland/setup-deno@v2` (2.9.5); a missing Bun or Deno skips that runtime locally
  by name and fails under `CI=true`, the existing Chromium rule.
- **Why:** the ROADMAP deliverable names a browser on each runtime; geometry and first-paint theme
  are not observable over HTTP.
- **Test home:** itself; `test/browser-gate.test.ts` for the skip policy extension.

### 3.11 `setu add view` on Cloudflare Workers

- **Decision:** pieces 1, 2 and the `home.tsx`/`layout.tsx`/`routes.ts` files are written; Tailwind,
  `styles.css`, `StaticPlugin`, the scripts and `.gitignore` are not, and the layout omits the
  stylesheet link. Registration is printed, not inserted: a Workers config has no devtool anchor, so
  `ViewPlugin()` was never inserted there (§1), and the notes give both lines — `ViewPlugin()` in
  the plugin list and `registerViewRoutes(app.router);` after `registerGeneratedRoutes(…)`. One
  further note says CSS on Workers is served through Wrangler static assets and points at
  `docs/mvc.md`.
- **Why:** `StaticPlugin` has no filesystem on Workers (§1); a half-wired stylesheet would 404.
  Closing V10-64 there still matters, and the probe showed the view serving 200 once those two
  printed lines are applied.
- **Test home:** `add-view.test.ts` Workers rows.

### 3.12 React engine for views: documented, not scaffolded

- **Decision:** `docs/mvc.md` gains "Styling server-rendered views": the `setu add view` setup;
  shadcn class recipes work, interactive components do not (no client JavaScript); a `'custom'`
  React engine can render shadcn's static components but needs `/** @jsxImportSource react */` on
  every React file and separate TypeScript projects because the two JSX type sets conflict (probe),
  so the CLI does not scaffold it; the CSP note (§3.6); the Workers limit (§3.11).
- **Why:** the probe measured both traps; scaffolding a configuration that needs two tsconfigs would
  be the template's largest special case for its least common use.
- **Test home:** `pnpm run check:docs` (prose and links); no behaviour.

### 3.13 Security

- **Decision:** no committed-tree security audit. The milestone adds generated client code with two
  static inline scripts whose only input (`localStorage`) is compared against literals and never
  reaches the DOM or a network; no server behaviour, header, cookie or package runtime changes.
- **Why:** CLAUDE.md requires an audit when the plan names one or the diff crosses a trust boundary;
  neither holds. Reviewers re-check this claim against the final diff.
- **Test home:** `ui-tokens.test.ts` (script cases, §3.6).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. No package's `src/index.ts` changes. Generated-project changes
(Node full-stack `app/lib/utils.ts` exports `cn` instead of `classNames`) are template output, named
in the CHANGELOG and upgrade guide for projects that copy from a fresh scaffold.

| Exported symbol (module-internal to `packages/cli`) | Kind     | Consumer / real code path that READS it                                      |
| --------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `TAILWIND_RANGE`                                    | const    | `full-stack-build-files.ts` devDependencies; `add-view.ts` npm/Deno pins     |
| `THEME_STORAGE_KEY`                                 | const    | `renderThemeScript`; the full-stack theme toggle and view toggle renderers   |
| `renderTokenCss()`                                  | function | `full-stack-app-files.ts` (`app/app.css`); `add-view.ts` (`styles.css`)      |
| `renderThemeScript()`                               | function | `full-stack-app-files.ts` (`app/lib/theme.ts`); `add-view.ts` (`layout.tsx`) |
| `FULL_STACK_UI_FILES`                               | const    | `full-stack.ts` file list (components.json, button, card, theme toggle)      |
| `planViewSetup()`                                   | function | `add.ts` `runAddCommand` for `view-plugin`                                   |

### 4.1 Options — every option names its consumer

| Option                                                                                       | Consumer | Behavior (per implementation) |
| -------------------------------------------------------------------------------------------- | -------- | ----------------------------- |
| None (checked: no new CLI flag or plugin option; `setu add view` keeps `--dir`, `--dry-run`) | —        | —                             |

## 5. Implementation files

| File                                                      | Purpose                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/cli/src/templates/ui-tokens.ts` (new)           | `TAILWIND_RANGE`, `THEME_STORAGE_KEY`, `renderTokenCss`, `renderThemeScript` (§3.2, §3.6)                                                                                      |
| `packages/cli/src/templates/full-stack-ui-files.ts` (new) | components.json, `button.tsx`, `card.tsx`, `theme-toggle.tsx`, `app/lib/theme.ts` (§3.3–3.6)                                                                                   |
| `packages/cli/src/templates/full-stack-app-files.ts`      | root.tsx script + `suppressHydrationWarning`; `app.css`; `cn` utils; layouts; Card/Button use                                                                                  |
| `packages/cli/src/templates/full-stack-build-files.ts`    | Tailwind devDependencies; vite plugin; runtime deps clsx, tailwind-merge, cva, radix-ui                                                                                        |
| `packages/cli/src/templates/full-stack.ts`                | wire `FULL_STACK_UI_FILES` (Deno imports follow `npmDependencies` automatically, §1)                                                                                           |
| `packages/cli/src/templates/client-dependencies.ts`       | `CLIENT_RANGES.hono`                                                                                                                                                           |
| `packages/cli/src/commands/add-view.ts` (new)             | `planViewSetup` and the view file renderers (§3.7, §3.11)                                                                                                                      |
| `packages/cli/src/commands/add.ts`                        | `view` peers; call `planViewSetup`; write and print its plan                                                                                                                   |
| `packages/cli/test/fixtures/template-baseline.json`       | recaptured with `capture-template-baseline.ts` (M118/M120 precedent)                                                                                                           |
| `apps/full-stack/browser/*` + `.github/workflows/ci.yml`  | §3.10                                                                                                                                                                          |
| `scripts/toolchain-prose.ts`                              | `generatedDenoTasks` gains `css` and `css:watch` (§1), so docs naming `deno task css` pass                                                                                     |
| `scripts/check-deploy.ts`                                 | §3.8 case                                                                                                                                                                      |
| Docs                                                      | `docs/mvc.md`, `packages/view-plugin/README.md`, `packages/cli/README.md` (`add view`), generated full-stack README section, `docs/upgrading.md`, `CHANGELOG.md`, `ROADMAP.md` |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                   | src covered                                                                                       | Key assertions                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/cli/test/unit/templates/ui-tokens.test.ts` (new)                                  | `ui-tokens.ts`                                                                                    | every token defined in `:root` and `.dark` and mapped in `@theme inline`; `TAILWIND_RANGE` equals the vite plugin's; theme script in `node:vm` over the 3×2 + throwing-storage table (§3.6)                                                                                                |
| `full-stack-template.test.ts` + `templates/full-stack-app-files.test.ts`                    | `full-stack-app-files.ts`, `full-stack-build-files.ts`, `full-stack-ui-files.ts`, `full-stack.ts` | vite plugins order; dev/runtime deps (table); components.json fields; `cn` exported, `classNames` gone; button/card licence header and rewritten import; `data-shell` hooks; scroll reset effect; script first in `<head>`; a Deno scaffold's import map carries the four new runtime deps |
| `packages/cli/test/unit/add-view.test.ts` (new)                                             | `add-view.ts`                                                                                     | planner table: each of the 7 pieces × absent / present / conflicting × node, bun, deno, workers; second run plans nothing; notes name each skipped piece                                                                                                                                   |
| `packages/cli/test/unit/commands/add.test.ts`                                               | `add.ts` (view path), `client-dependencies.ts`                                                    | memory-fs run writes the planned files and manifests; `--dry-run` lists them and writes nothing; `hono` written through the peer path incl. an `overrides` row; `CLIENT_RANGES.hono === EXTERNAL_RANGES.hono`                                                                              |
| `packages/cli/test/unit/templates/style-baseline.test.ts`                                   | baseline                                                                                          | recaptured fixture; header names M123                                                                                                                                                                                                                                                      |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts`                                           | generated output                                                                                  | §3.9                                                                                                                                                                                                                                                                                       |
| `apps/full-stack/browser/full-stack.browser.test.ts`, `view-scaffold.browser.test.ts` (new) | generated output                                                                                  | §3.5, §3.6, §3.10                                                                                                                                                                                                                                                                          |
| `test/browser-gate.test.ts`, `test/deploy-gate.test.ts`                                     | `harness.ts` skip policy, `check-deploy.ts` case                                                  | Bun/Deno skip-by-name locally, fail under CI; the new deploy case is listed                                                                                                                                                                                                                |

Negative controls (each observed failing, then restored): theme script removed from `<head>` →
DOMContentLoaded assertion fails; `h-dvh` removed from the frame → `window.scrollY` > 0 (removing
`overflow-hidden` alone does not fail: `h-dvh`, `min-h-0` and `overflow-y-auto` still bound the
document, measured); scroll-reset effect removed → navigation assertion fails; `tailwindcss`
import-map entry removed on Deno → scaffold e2e build fails; `StaticPlugin` insertion removed →
`/assets/app.css` 404.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m123-app-shell-and-view-styling
pnpm run check:plan
pnpm run fmt:check && pnpm run lint && pnpm run check && pnpm run check:docs
pnpm run ci:local            # all shards on the final commit
pnpm run check:deploy --generated
pnpm run check:browser       # Chromium + Bun + Deno present
pnpm run test:deno-lane
pnpm run release:publish --dry-run && pnpm run release:verify 0.10.0
```

## 8. Risks & mitigations

- Tailwind/shadcn churn (a 4.x minor renaming a utility, a registry change to the copied sources) →
  sources and tokens are pinned in the template, the range is caret on 4.3.3, and the browser gate
  asserts computed styles rather than class names.
- `radix-ui` and `class-variance-authority` widen every full-stack install → they are the two
  dependencies Button needs; measured install and image sizes go in the PR description.
- Browser job time grows with three runtimes → the view scaffolds share one overlay and run
  sequentially; the job's 15-minute timeout is raised only if a measured run needs it.
- `setu add view` inserting into a hand-edited `setu.config.ts` → reuses the classified insertion
  that `setu add` already fails closed with (§3.7 piece 5), printing the line instead.

## 9. Out of scope

- More shadcn components, a gallery page, or icons — `npx shadcn add` (§3.3 makes it work).
- Serving view CSS on Cloudflare Workers through Wrangler static assets — documented (§3.11); no
  milestone owns it yet.
- A cookie- or session-backed theme read on the server — not chosen (§3.6).
- One `dev` command running the server and the CSS watcher together — V10-60 (M121).
- Styling for REST/microservice projects without views — nothing to style.
