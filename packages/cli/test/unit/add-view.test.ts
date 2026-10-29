import { describe, expect, it } from 'vitest';
import { planViewSetup } from '../../src/commands/add-view.ts';
import { withPluginWiring } from '../../src/commands/add.ts';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { REST_TEMPLATE } from '../../src/templates/rest.ts';
import { CLASS_BASED_TEMPLATE } from '../../src/templates/class-based.ts';
import type { TargetRuntime } from '../../src/constants.ts';
import { renderTokenCss } from '../../src/templates/ui-tokens.ts';

function fresh(runtime: TargetRuntime, classBased = false) {
  return new Map(
    projectFiles(
      'shop',
      runtime,
      resolveHost(classBased ? CLASS_BASED_TEMPLATE : REST_TEMPLATE, runtime),
    ).map((file) => [file.path, file.contents]),
  );
}
function plan(existing: Map<string, string>, runtime: TargetRuntime = 'node', ready = true) {
  return planViewSetup({
    runtime,
    existing,
    viewPluginRegistered: ready,
    wireStatic: (source, args) => withPluginWiring(source, 'static-plugin', undefined, args),
  });
}
function apply(existing: Map<string, string>, result: ReturnType<typeof plan>) {
  return new Map([
    ...existing,
    ...[...result.files, ...result.manifestEdits, ...result.configEdits].map(
      (file) => [file.path, file.contents] as const,
    ),
  ]);
}

describe('add view planner', () => {
  for (const runtime of ['node', 'bun', 'deno', 'cloudflare-workers'] as const) {
    it(`plans each absent piece and preserves every present piece on ${runtime}`, () => {
      const existing = fresh(runtime);
      const result = plan(existing, runtime);
      const after = apply(existing, result);
      const workers = runtime === 'cloudflare-workers';
      expect(result.files.map((file) => file.path)).toEqual([
        'src/views/layout.tsx',
        'src/views/home.tsx',
        'src/views/routes.ts',
        ...(workers ? [] : ['src/views/styles.css']),
      ]);
      expect(after.get('src/views/layout.tsx')).toContain("data-shell='frame'");
      expect(after.get('src/views/layout.tsx')!.includes('/assets/app.css')).toBe(!workers);
      expect(after.get('src/views/home.tsx')).toContain('bg-primary');
      expect(after.get('src/views/routes.ts')).toContain("router.get('/ui'");
      const compiler = JSON.parse(after.get(runtime === 'deno' ? 'deno.json' : 'tsconfig.json')!);
      expect(compiler.compilerOptions).toMatchObject({
        jsx: 'react-jsx',
        jsxImportSource: 'hono/jsx',
      });
      if (workers) {
        expect(result.manifestEdits).toEqual([]);
        expect(result.notes.join('\n')).toContain('Wrangler static assets');
      } else {
        expect(after.get('src/views/styles.css')).toBe(
          `@import "tailwindcss";\n\n${renderTokenCss()}`,
        );
        const manifest = JSON.parse(after.get(runtime === 'deno' ? 'deno.json' : 'package.json')!);
        const scripts = runtime === 'deno' ? manifest.tasks : manifest.scripts;
        const pins = runtime === 'deno' ? manifest.imports : manifest.devDependencies;
        expect(pins.tailwindcss).toBe(runtime === 'deno' ? 'npm:tailwindcss@^4.3.3' : '^4.3.3');
        if (runtime !== 'deno') expect(pins['@tailwindcss/cli']).toBe('^4.3.3');
        expect(scripts.css).toContain('-i src/views/styles.css -o build/assets/app.css --minify');
        expect(scripts['css:watch']).toBe(scripts.css + ' --watch');
        const call =
          runtime === 'deno' ? 'deno task css' : `${runtime === 'bun' ? 'bun' : 'npm'} run css`;
        expect(scripts.build.startsWith(call)).toBe(true);
        expect(scripts['start:dev'].startsWith(call)).toBe(true);
        expect(after.get('setu.config.ts')).toContain(
          "StaticPlugin({ root: './build/assets', urlPrefix: '/assets' })",
        );
        expect(after.get('setu.config.ts')).toContain(
          'registerGeneratedRoutes(app.router, app.services);\n  registerViewRoutes(app.router);',
        );
        expect(after.get('.gitignore')).toMatch(/^build\/$/m);
      }
      const again = plan(after, runtime, false);
      expect([...again.files, ...again.manifestEdits, ...again.configEdits]).toEqual([]);
      for (const path of result.files.map((file) => file.path))
        expect(again.notes.join('\n')).toContain(path);
    });

    it(`preserves conflicting files, JSX and CSS choices on ${runtime}`, () => {
      const existing = fresh(runtime);
      const path = runtime === 'deno' ? 'deno.json' : 'package.json';
      const compilerPath = runtime === 'deno' ? path : 'tsconfig.json';
      const compiler = JSON.parse(existing.get(compilerPath)!);
      compiler.compilerOptions = { jsx: 'preserve', jsxImportSource: 'react' };
      existing.set(compilerPath, JSON.stringify(compiler));
      const manifest = JSON.parse(existing.get(path)!);
      if (runtime === 'deno') manifest.imports.tailwindcss = 'npm:tailwindcss@4.0.0';
      else {
        manifest.dependencies.tailwindcss = '4.0.0';
        manifest.devDependencies = { '@tailwindcss/cli': '4.0.0' };
      }
      manifest[runtime === 'deno' ? 'tasks' : 'scripts'] = {
        css: 'custom css',
        'css:watch': 'custom watch',
        build: 'npm run css && custom',
        'start:dev': 'deno task css && custom',
      };
      existing.set(path, JSON.stringify(manifest));
      for (const file of ['layout.tsx', 'home.tsx', 'routes.ts', 'styles.css'])
        existing.set(`src/views/${file}`, 'hand edited');
      const result = plan(existing, runtime);
      expect(result.files).toEqual([]);
      const after = apply(existing, result);
      expect(JSON.parse(after.get(compilerPath)!).compilerOptions).toEqual(
        compiler.compilerOptions,
      );
      if (runtime !== 'cloudflare-workers')
        expect(result.notes.join('\n')).toContain('tailwindcss');
      expect(result.notes.join('\n')).toContain('/** @jsxImportSource hono/jsx */');
      expect(JSON.parse(after.get(path)!)[runtime === 'deno' ? 'tasks' : 'scripts']).toEqual(
        manifest[runtime === 'deno' ? 'tasks' : 'scripts'],
      );
    });
  }

  for (const compiler of [
    '// jsonc\n{}',
    'null',
    '[]',
    '42',
    '{bad',
    '{"compilerOptions":[]}',
    '{"compilerOptions":{"jsxImportSource":"react"}}',
  ]) {
    it(`refuses unfamiliar compiler configuration ${compiler}`, () => {
      const existing = fresh('node');
      existing.set('tsconfig.json', compiler);
      const result = plan(existing);
      expect(result.configEdits.some((file) => file.path === 'tsconfig.json')).toBe(false);
      expect(result.notes.join('\n')).toContain('jsxImportSource hono/jsx');
    });
  }
  it('handles missing manifests and ignore, JSONC and malformed script/pin sections', () => {
    const result = plan(new Map());
    expect(result.manifestEdits).toEqual([]);
    expect(result.notes.join('\n')).toContain('tsconfig.json missing');
    for (const source of [
      '// keep\n{}',
      'null',
      '{"devDependencies":[],"dependencies":[],"scripts":[]}',
      '{}',
    ]) {
      const existing = new Map([['package.json', source]]);
      expect(() => plan(existing)).not.toThrow();
    }
    const deno = plan(new Map([['deno.jsonc', '{}']]), 'deno');
    expect(deno.manifestEdits[0]!.path).toBe('deno.jsonc');
  });
  it('preserves static pins in both npm sections and import maps', () => {
    for (const section of ['dependencies', 'devDependencies', 'imports']) {
      const path = section === 'imports' ? 'deno.json' : 'package.json';
      const existing = fresh('node');
      existing.set(path, JSON.stringify({ [section]: { '@setu-ts/static-plugin': 'custom' } }));
      const after = apply(existing, plan(existing));
      expect(JSON.parse(after.get(path)!)[section]['@setu-ts/static-plugin']).toBe('custom');
    }
  });
  for (const ignore of ['build', '/build/', 'build/\n']) {
    it(`keeps the existing ignore ${JSON.stringify(ignore)}`, () => {
      const existing = fresh('node');
      existing.set('.gitignore', ignore);
      expect(plan(existing).configEdits.some((file) => file.path === '.gitignore')).toBe(false);
    });
  }
  it('appends build after an unterminated ignore line', () => {
    const existing = fresh('node');
    existing.set('.gitignore', 'node_modules/');
    expect(apply(existing, plan(existing)).get('.gitignore')).toBe('node_modules/\nbuild/\n');
  });
  it('accepts both route styles', () => {
    expect(apply(fresh('node', true), plan(fresh('node', true))).get('setu.config.ts')).toContain(
      'registerViewRoutes(app.router);',
    );
  });
  const anchor = 'registerGeneratedRoutes(app.router, app.services);';
  for (const [name, transform] of [
    ['absent', (s: string) => s.replace(anchor, '')],
    ['repeated', (s: string) => s.replace(anchor, anchor + '\n  ' + anchor)],
    ['already referenced', (s: string) => s + '\nvoid registerViewRoutes;'],
    ['commented anchor', (s: string) => s.replace(anchor, '// ' + anchor)],
    [
      'unrecognized factory',
      (s: string) => s.replace('export function createApp', 'export async function createApp'),
    ],
    ['inline statement', (s: string) => s.replace('  ' + anchor, '  void 0; ' + anchor)],
    [
      'starter composed',
      (s: string) =>
        "import { createFullStackAppFromConfig } from '@setu-ts/full-stack-starter';\n" + s,
    ],
    [
      'already imported path',
      (s: string) => "import * as views from './src/views/routes.ts';\n" + s,
    ],
  ] as const) {
    it(`prints the route guidance for ${name}`, () => {
      const existing = fresh('node');
      existing.set('setu.config.ts', transform(existing.get('setu.config.ts')!));
      const after = apply(existing, plan(existing)).get('setu.config.ts')!;
      expect(after).not.toContain("import { registerViewRoutes } from './src/views/routes.ts'");
    });
  }
  it('does not insert the route when ViewPlugin was not inserted', () => {
    const existing = fresh('node');
    expect(apply(existing, plan(existing, 'node', false)).get('setu.config.ts')).not.toContain(
      'registerViewRoutes(app.router)',
    );
  });
});

it('preserves non-string scripts and fills partial compiler options', () => {
  for (const options of [{ jsx: 'react-jsx' }, { jsxImportSource: 'hono/jsx' }]) {
    const existing = fresh('node');
    existing.set('tsconfig.json', JSON.stringify({ compilerOptions: options }));
    existing.set(
      'package.json',
      JSON.stringify({
        dependencies: { tailwindcss: 'custom' },
        scripts: { build: 42, 'start:dev': null, css: 42, 'css:watch': null },
      }),
    );
    const after = apply(existing, plan(existing));
    expect(JSON.parse(after.get('tsconfig.json')!).compilerOptions).toEqual({
      jsx: 'react-jsx',
      jsxImportSource: 'hono/jsx',
    });
    expect(JSON.parse(after.get('package.json')!).scripts).toEqual({
      build: 42,
      'start:dev': null,
      css: 42,
      'css:watch': null,
    });
  }
});

it('prints the exact registration lines for existing conflicting references', () => {
  const existing = fresh('node');
  existing.set(
    'setu.config.ts',
    existing.get('setu.config.ts')! + '\nvoid StaticPlugin;\nvoid registerViewRoutes;\n',
  );
  const notes = plan(existing).notes.join('\n');
  expect(notes).toContain("StaticPlugin({ root: './build/assets', urlPrefix: '/assets' })");
  expect(notes).toContain(
    'registerViewRoutes(app.router); after registerGeneratedRoutes(app.router, app.services);',
  );
  expect(notes).toContain('requires ViewPlugin() registered first');
});
