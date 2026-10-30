/** Pure, additive setup for server-rendered views. Existing user choices always win. */
import type { TargetRuntime } from '../constants.ts';
import type { GeneratedFile } from '../utils/file-writer.ts';
import { maskComments, referencesIdentifier } from '../devtool/sources.ts';
import { frameworkSpecifier } from '../templates/framework-specifier.ts';
import {
  renderThemeScript,
  renderTokenCss,
  TAILWIND_RANGE,
  THEME_STORAGE_KEY,
} from '../templates/ui-tokens.ts';

interface IViewSetupInput {
  readonly runtime: TargetRuntime;
  /** Relative paths, with pending manifest/config edits already applied. */
  readonly existing: ReadonlyMap<string, string>;
  /**
   * True when the app factory calls ViewPlugin: inserted by this invocation, or
   * already registered by an earlier `setu add view` or by hand.
   */
  readonly viewPluginRegistered: boolean;
  /** Reuses the command's classified insertion, without a circular import. */
  readonly wireStatic: (source: string, args: string) => string | undefined;
  /**
   * Where the example page's function controller goes: `src/controllers/` in a
   * flat project, the `--module` directory in a modular one.
   */
  readonly controllerDir: string;
  /** The controllers barrel or module index, regenerated to register the controller. */
  readonly registration: GeneratedFile;
}

interface IViewSetupPlan {
  readonly files: readonly GeneratedFile[];
  readonly manifestEdits: readonly GeneratedFile[];
  readonly configEdits: readonly GeneratedFile[];
  readonly notes: readonly string[];
}

/** Narrows plain JSON objects, refusing arrays and primitives at every edited level. */
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const STATIC_ARGS = "{ root: './build/assets', urlPrefix: '/assets' }";
const CSS_ARGS = '-i src/views/styles.css -o build/assets/app.css --minify';

/**
 * Plans only missing pieces; has no I/O and never replaces an existing view file or pin.
 * @param input - Runtime, current text and the command's provider insertion seam
 * @returns New files, rewrites of recognized manifests/config, and actionable skip notes
 */
export function planViewSetup(input: IViewSetupInput): IViewSetupPlan {
  const { runtime, existing } = input;
  const workers = runtime === 'cloudflare-workers';
  const files: GeneratedFile[] = [];
  const manifestEdits: GeneratedFile[] = [];
  const configEdits: GeneratedFile[] = [];
  const notes: string[] = [];
  const note = (piece: string) =>
    notes.push(`left ${piece} unchanged: already present or conflicting.`);
  const compilerFile =
    runtime === 'deno' ? (existing.has('deno.json') ? 'deno.json' : 'deno.jsonc') : 'tsconfig.json';
  const manifestFile = runtime === 'deno' ? compilerFile : 'package.json';
  const paths = new Set([
    compilerFile,
    manifestFile,
    ...(!workers ? ['deno.json', 'deno.jsonc'] : []),
  ]);
  for (const path of paths) {
    const source = existing.get(path);
    if (source === undefined) {
      if (path === compilerFile)
        notes.push(`${path} missing; use /** @jsxImportSource hono/jsx */ on each view file.`);
      continue;
    }
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = object(JSON.parse(source));
    } catch {
      /* JSONC and malformed JSON are preserved. */
    }
    if (parsed === undefined) {
      notes.push(
        `${path} is not plain JSON; left unchanged. Use /** @jsxImportSource hono/jsx */ on each view file.`,
      );
      continue;
    }
    let changed = false;
    if (path === compilerFile) {
      const options =
        parsed['compilerOptions'] === undefined ? {} : object(parsed['compilerOptions']);
      if (
        options === undefined ||
        (options['jsx'] !== undefined && options['jsx'] !== 'react-jsx') ||
        (options['jsxImportSource'] !== undefined && options['jsxImportSource'] !== 'hono/jsx')
      ) {
        notes.push(
          `${path} compilerOptions conflict; use /** @jsxImportSource hono/jsx */ on each view file.`,
        );
      } else if (options['jsx'] === undefined || options['jsxImportSource'] === undefined) {
        parsed['compilerOptions'] = { ...options, jsx: 'react-jsx', jsxImportSource: 'hono/jsx' };
        changed = true;
      } else note(`${path} compilerOptions`);
    }
    if (!workers && path === manifestFile) {
      const deno = runtime === 'deno';
      const section = deno ? 'imports' : 'devDependencies';
      const pins = parsed[section] === undefined ? {} : object(parsed[section]);
      if (pins === undefined) note(`${path} ${section}`);
      else {
        for (const name of deno ? ['tailwindcss'] : ['tailwindcss', '@tailwindcss/cli']) {
          if (
            Object.hasOwn(pins, name) ||
            (!deno && Object.hasOwn(object(parsed['dependencies']) ?? {}, name))
          )
            note(`${path} ${name}`);
          else {
            pins[name] = deno ? `npm:${name}@${TAILWIND_RANGE}` : TAILWIND_RANGE;
            changed = true;
          }
        }
        parsed[section] = pins;
      }
      const scriptKey = deno ? 'tasks' : 'scripts';
      const scripts = parsed[scriptKey] === undefined ? {} : object(parsed[scriptKey]);
      if (scripts === undefined) note(`${path} ${scriptKey}`);
      else {
        const css = deno
          ? `deno install && deno run -A npm:@tailwindcss/cli@${TAILWIND_RANGE} ${CSS_ARGS}`
          : `tailwindcss ${CSS_ARGS}`;
        for (const [name, value] of [
          ['css', css],
          ['css:watch', css + ' --watch'],
        ]) {
          if (Object.hasOwn(scripts, name!)) note(`${path} ${name}`);
          else {
            scripts[name!] = value;
            changed = true;
          }
        }
        const call = deno ? 'deno task css' : runtime === 'bun' ? 'bun run css' : 'npm run css';
        for (const name of ['build', 'start:dev']) {
          const current = scripts[name];
          if (current === undefined) {
            scripts[name] = call;
            changed = true;
          } else if (typeof current !== 'string' || /\b(?:run|task)\s+css\b/.test(current))
            note(`${path} ${name}`);
          else {
            scripts[name] = `${call} && ${current}`;
            changed = true;
          }
        }
        parsed[scriptKey] = scripts;
      }
    }
    // A hybrid npm scaffold can also carry a Deno import map for plugin detection.
    if (!workers && (path === 'package.json' || path === 'deno.json' || path === 'deno.jsonc')) {
      const section = path === 'package.json' ? 'dependencies' : 'imports';
      const pins = parsed[section] === undefined ? {} : object(parsed[section]);
      const specifier = '@setu-ts/static-plugin';
      const declared = ['dependencies', 'devDependencies'].some((key) =>
        Object.hasOwn(object(parsed![key]) ?? {}, specifier),
      );
      if (
        pins === undefined ||
        Object.hasOwn(pins, specifier) ||
        (section === 'dependencies' && declared)
      )
        note(`${path} ${specifier}`);
      else {
        pins[specifier] = frameworkSpecifier(
          'static-plugin',
          section === 'imports' ? 'deno' : 'npm',
        );
        parsed[section] = pins;
        changed = true;
      }
    }
    if (changed) {
      const edit = { path, contents: JSON.stringify(parsed, null, 2) + '\n' };
      (path === 'tsconfig.json' ? configEdits : manifestEdits).push(edit);
    }
  }

  const viewFiles: GeneratedFile[] = [
    { path: 'src/views/layout.tsx', contents: renderLayout(workers) },
    { path: 'src/views/home.tsx', contents: HOME },
    ...(workers
      ? []
      : [
          {
            path: 'src/views/styles.css',
            contents: `@import "tailwindcss";\n\n${renderTokenCss()}`,
          },
        ]),
  ];
  for (const file of viewFiles) {
    if (existing.has(file.path)) note(file.path);
    else files.push(file);
  }
  // The page is served by a function controller, registered like every other
  // controller: through the barrel or module index `setu.config.ts` already calls.
  const controllerPath = `${input.controllerDir}/${VIEWS_CONTROLLER}`;
  if (existing.has(controllerPath)) note(controllerPath);
  else {
    files.push({ path: controllerPath, contents: renderViewsController(input.controllerDir) });
    configEdits.push(input.registration);
  }
  let config = existing.get('setu.config.ts');
  const original = config;
  if (!workers) {
    const wired = config === undefined ? undefined : input.wireStatic(config, STATIC_ARGS);
    if (
      wired === undefined &&
      referencesIdentifier(maskComments(config ?? '') ?? '', 'StaticPlugin')
    )
      note(
        `setu.config.ts StaticPlugin; expected CSS registration: StaticPlugin(${STATIC_ARGS}) from @setu-ts/static-plugin`,
      );
    else if (wired === undefined)
      notes.push(
        `Register StaticPlugin(${STATIC_ARGS}) from @setu-ts/static-plugin in setu.config.ts; existing registration or config shape was preserved.`,
      );
    else config = wired;
    const ignore = existing.get('.gitignore');
    if (ignore !== undefined) {
      if (/^\/?build\/?\s*$/m.test(ignore)) note('.gitignore build/');
      else
        configEdits.push({
          path: '.gitignore',
          contents: ignore + (ignore.endsWith('\n') ? '' : '\n') + 'build/\n',
        });
    }
  } else notes.push('CSS on Workers is served through Wrangler static assets; see docs/mvc.md.');
  if (!input.viewPluginRegistered)
    notes.push(
      `Register ViewPlugin() in setu.config.ts; ${controllerPath} renders /ui through it.`,
    );
  if (config !== original && config !== undefined)
    configEdits.push({ path: 'setu.config.ts', contents: config });
  return { files, manifestEdits, configEdits, notes };
}

const HOME = `import { Layout } from './layout.tsx';

/** A server-rendered page: class recipes need no React or client component runtime. */
export function Home() {
  return (
    <Layout title='Welcome'>
      <section class='flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm'>
        <div class='px-6'>
          <h1 class='text-2xl font-semibold'>Welcome</h1>
          <p class='py-4 text-muted-foreground'>Your server-rendered view is ready.</p>
          <button
            type='button'
            class='inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground'
          >
            Get started
          </button>
        </div>
      </section>
    </Layout>
  );
}
`;
/** The example page's controller file name. */
export const VIEWS_CONTROLLER = 'views.controller.ts';

/**
 * Renders the example page's function controller.
 *
 * @param dir - The directory it is written into, which decides the import path
 * @returns The controller source
 */
function renderViewsController(dir: string): string {
  const up = '../'.repeat(dir.split('/').length - 1);
  return `import type { IRouterApi, IServiceRegistry } from '@setu-ts/common';
import { renderView } from '@setu-ts/view-plugin';
import { Home } from '${up}views/home.tsx';

/** Registers the example server-rendered page: a function controller. */
export function registerViewsRoutes(router: IRouterApi, services?: IServiceRegistry): void {
  void services;
  router.get('/ui', (ctx) => renderView(ctx, Home, {}));
}
`;
}

function renderLayout(workers: boolean): string {
  return `import type { Child } from 'hono/jsx';
import { raw } from '@setu-ts/view-plugin';

const THEME_SCRIPT =
  ${JSON.stringify(renderThemeScript())};
const TOGGLE_SCRIPT =
  ${JSON.stringify(`(function () {
  var button = document.getElementById('theme-toggle');
  var theme = 'system';
  try { var stored = localStorage.getItem('${THEME_STORAGE_KEY}'); if (stored === 'light' || stored === 'dark') theme = stored; } catch { /* Storage may be unavailable. */ }
  var media = matchMedia('(prefers-color-scheme: dark)');
  function apply() {
    var dark = theme === 'dark' || (theme === 'system' && media.matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    button.setAttribute('aria-label', 'Theme: ' + theme);
  }
  button.addEventListener('click', function () {
    theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    try { if (theme === 'system') localStorage.removeItem('${THEME_STORAGE_KEY}'); else localStorage.setItem('${THEME_STORAGE_KEY}', theme); } catch { /* Preference still works on this page. */ }
    apply();
  });
  media.addEventListener('change', function () { if (theme === 'system') apply(); });
  apply();
})();`)};

/** A fixed shell; only the content scrolls. Inline scripts need a CSP hash or nonce. */
export function Layout({ title, children }: { title: string; children: Child }) {
  return (
    <html lang='en'>
      <head>
        <script>{raw(THEME_SCRIPT)}</script>
        <meta charSet='utf-8' />
        <meta name='viewport' content='width=device-width, initial-scale=1' />
        <title>{title}</title>
        ${workers ? '' : "<link rel='stylesheet' href='/assets/app.css' />"}
      </head>
      <body>
        <div data-shell='frame' class='flex h-dvh flex-col overflow-hidden'>
          <header
            data-shell='header'
            class='flex h-14 shrink-0 items-center justify-between border-b px-6'
          >
            <span class='font-semibold'>{title}</span>
            <button
              id='theme-toggle'
              type='button'
              aria-label='Theme: system'
              class='inline-flex size-9 items-center justify-center rounded-md hover:bg-accent'
            >
              <span aria-hidden='true'>◐</span>
            </button>
          </header>
          <nav
            aria-label='Mobile navigation'
            class='flex shrink-0 overflow-x-auto border-b p-2 md:hidden'
          >
            <a href='/ui'>Home</a>
          </nav>
          <div class='flex min-h-0 flex-1'>
            <aside
              data-shell='sidebar'
              class='hidden w-56 shrink-0 overflow-y-auto border-r p-3 md:block'
            >
              <nav>
                <a href='/ui' class='block rounded-md bg-accent px-3 py-2 text-accent-foreground'>
                  Home
                </a>
              </nav>
            </aside>
            <main data-shell='content' class='min-w-0 flex-1 overflow-y-auto p-6'>{children}</main>
          </div>
        </div>
        <script>{raw(TOGGLE_SCRIPT)}</script>
      </body>
    </html>
  );
}
`;
}
