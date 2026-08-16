/**
 * The template side of the seams: which hosts emit which barrels, what their config
 * imports, and the invariants that keep a barrel from existing without its import.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { getTemplate, listTemplates, packagesOf } from '../../src/templates/registry.ts';
import type { TemplateDefinition } from '../../src/templates/registry.ts';
import {
  decoratorSeamExtras,
  seamFiles,
  seamLocalImports,
  seamPluginSpreads,
  seamSetupCalls,
  seamsFor,
  withPluginOptionSeams,
} from '../../src/templates/seam.ts';
import { listSeamSpecs } from '../../src/seams/registry.ts';
import { MINIMAL_HOST } from '../../src/templates/minimal.ts';
import { seamSpecFor } from './schematics/_shared.ts';

/** The templates that host generated-artifact seams. */
const HOSTS = ['rest', 'microservice', 'class-based'] as const;

/**
 * Every barrel path a template emits.
 *
 * @param template - The template to inspect
 * @returns The `index.ts` paths under `src/`
 */
function barrels(template: TemplateDefinition): readonly string[] {
  return (template.files ?? [])
    .map((f) => f.path)
    .filter((p) => p.endsWith('/index.ts'))
    .sort();
}

describe('the no-template host', () => {
  // M60 left this Unowned, reasoning that a minimal host would carry six inert
  // seams. It carries none: `seamsFor` selects only the three that need no
  // plugin, which is what makes the host possible without a fourth template.
  it('carries exactly the three barrels that need no plugin', () => {
    expect((MINIMAL_HOST.files ?? []).map((f) => f.path).sort()).toEqual([
      'src/controllers/index.ts',
      'src/middleware/index.ts',
      'src/plugins/index.ts',
    ]);
  });

  it('is not a template — --help still lists exactly the four that exist', () => {
    const names = listTemplates().map((t) => t.name);
    expect(names).toEqual(['rest', 'microservice', 'class-based', 'full-stack']);
    expect(getTemplate('minimal')).toBeUndefined();
    expect(getTemplate('none')).toBeUndefined();
  });
});

describe('seam selection', () => {
  it('omits a seam whose backing plugin the host does not install', () => {
    // Emitting it would put an unresolvable import in the generated config.
    const bare = seamsFor(new Set()).map((s) => s.schematic).sort();
    // `controller` is ungated since M70h/E8 and appears here in its functional
    // shape, sharing the `route` barrel rather than adding one.
    expect(bare).toEqual(['controller', 'middleware', 'plugin', 'route']);
  });

  it('selects every seam for a host installing every backing plugin', () => {
    const all = new Set(
      listSeamSpecs().map((s) => s.requiresPlugin).filter((p): p is string => p !== undefined),
    );
    expect(seamsFor(all)).toHaveLength(listSeamSpecs().length);
  });

  it('always selects the three ungated seams, whatever the host installs', () => {
    // `route`, `middleware` and `plugin` declare no `requiresPlugin`, because their
    // registration sites are the app itself rather than a plugin's options.
    for (const installed of [new Set<string>(), new Set(['cqrs-plugin'])]) {
      const selected = seamsFor(installed).map((s) => s.schematic);
      expect(selected).toContain('route');
      expect(selected).toContain('middleware');
      expect(selected).toContain('plugin');
    }
  });

  it('deduplicates the barrel two families share', () => {
    const cqrs = [seamSpecFor('command-handler')!, seamSpecFor('query-handler')!];
    // One file and one import, not two — a duplicate path would trip the
    // duplicate-path guard in `commands/new.ts`.
    expect(seamFiles(cqrs).map((f) => f.path)).toEqual(['src/cqrs/index.ts']);
    expect(seamLocalImports(cqrs)).toHaveLength(1);
  });

  it('names both cqrs exports on the one import', () => {
    const [imported] = seamLocalImports([
      seamSpecFor('command-handler')!,
      seamSpecFor('query-handler')!,
    ]);
    expect(imported!.symbols).toEqual(['COMMAND_HANDLERS', 'QUERY_HANDLERS']);
    expect(imported!.from).toBe('./src/cqrs/index.ts');
  });

  it('emits a setup call only for the two families whose site is a call', () => {
    const calls = seamSetupCalls(listSeamSpecs()).join('\n');
    expect(calls).toContain('registerGeneratedRoutes(app.router);');
    expect(calls).toContain('for (const generated of GENERATED_MIDDLEWARE) {');
    // The priority comes from the artifact's own module, never a literal here.
    expect(calls).toContain('priority: generated.priority,');
    expect(calls).not.toContain('priority: 500');
    // A plugin-option seam contributes no statement at all.
    expect(seamSetupCalls([seamSpecFor('health-indicator')!])).toEqual([]);
  });

  it('spreads the generated plugins only when that seam is present', () => {
    expect(seamPluginSpreads(listSeamSpecs())).toEqual(['...GENERATED_PLUGINS']);
    expect(seamPluginSpreads([seamSpecFor('health-indicator')!])).toEqual([]);
  });

  it('leaves the decorator wiring to withModuleSeam, and contributes extras instead', () => {
    // Two functions rewriting the same `args` would silently overwrite one another, so
    // `withPluginOptionSeams` must not touch `decorator-plugin`.
    const wirings = [{ pkg: 'decorator-plugin', symbol: 'DecoratorPlugin', args: 'KEEP' }];
    expect(withPluginOptionSeams(wirings, listSeamSpecs())[0]!.args).toBe('KEEP');

    const extras = decoratorSeamExtras(listSeamSpecs());
    expect(extras.controllers).toEqual(['...APP_CONTROLLERS']);
    expect(extras.services).toEqual(['...APP_SERVICES']);
    expect(decoratorSeamExtras(seamsFor(new Set()))).toEqual({ controllers: [], services: [] });
  });

  it('replaces the args of each plugin whose options carry a seam', () => {
    const wirings = [
      { pkg: 'health-plugin', symbol: 'HealthPlugin' },
      { pkg: 'metrics-plugin', symbol: 'MetricsPlugin' },
      { pkg: 'cqrs-plugin', symbol: 'CqrsPlugin' },
      { pkg: 'events-plugin', symbol: 'EventsPlugin' },
      { pkg: 'logger-plugin', symbol: 'LoggerPlugin' },
    ];
    const wired = withPluginOptionSeams(wirings, listSeamSpecs());
    expect(wired.map((w) => w.args)).toEqual([
      '{ indicators: [...HEALTH_INDICATORS] }',
      '{ customMetrics: [...CUSTOM_METRICS] }',
      '{ commandHandlers: COMMAND_HANDLERS, queryHandlers: QUERY_HANDLERS }',
      '{ handlers: EVENT_HANDLERS }',
      undefined,
    ]);
  });
});

describe('seam hosts', () => {
  for (const name of HOSTS) {
    const template = getTemplate(name)!;

    it(`${name} emits an import for every barrel it emits`, () => {
      // The invariant that keeps a barrel from existing without the config import that
      // reads it — the M58 failure mode a pre-seam project has.
      const emitted = new Set(barrels(template));
      const imported = new Set(
        (template.localImports ?? []).map((l) => l.from.replace(/^\.\//, '')),
      );
      for (const path of emitted) expect(imported.has(path)).toBe(true);
    });

    it(`${name} brings every setupCalls identifier into scope`, () => {
      // `setupCalls` is a rendered string the CLI's own `deno check` cannot see, so an
      // identifier no import declares is a compile error only in the generated project.
      const symbols = new Set((template.localImports ?? []).flatMap((l) => l.symbols));
      for (const call of template.setupCalls ?? []) {
        for (const match of call.matchAll(/\b([A-Z][A-Z0-9_]{2,}|registerGeneratedRoutes)\b/g)) {
          expect(symbols.has(match[1]!)).toBe(true);
        }
      }
    });

    it(`${name} brings every pluginSpreads identifier into scope`, () => {
      const symbols = new Set((template.localImports ?? []).flatMap((l) => l.symbols));
      for (const spread of template.pluginSpreads ?? []) {
        expect(symbols.has(spread.replace('...', ''))).toBe(true);
      }
    });
  }

  it('keeps functional hosts decorator-free while class-based hosts class seams', () => {
    // Both modes now scaffold the HTTP barrel — E8 gave `controller` a
    // functional shape, so the directory exists either way. What still
    // separates them is the SERVICE barrel, which has a registration site only
    // when a decorator plugin is present.
    expect(barrels(getTemplate('rest')!)).toContain('src/controllers/index.ts');
    expect(barrels(getTemplate('rest')!)).not.toContain('src/services/index.ts');
    expect(barrels(getTemplate('class-based')!)).toContain('src/controllers/index.ts');
    expect(barrels(getTemplate('class-based')!)).toContain('src/services/index.ts');
    expect(barrels(getTemplate('microservice')!)).toContain('src/cqrs/index.ts');
  });

  it('gives each mode its OWN HTTP shape, not merely the same barrel path', () => {
    const shapeOf = (name: 'rest' | 'class-based'): readonly string[] =>
      seamsFor(new Set(packagesOf(getTemplate(name)!.plugins, getTemplate(name)!.middleware)))
        .filter((spec) => spec.barrel === 'src/controllers/index.ts')
        .flatMap((spec) => spec.exports);

    // The class-based barrel declares the controller array; the functional one
    // must not, or `setu.config.ts` would spread a symbol nothing exports.
    expect(shapeOf('class-based')).toContain('APP_CONTROLLERS');
    expect(shapeOf('rest')).not.toContain('APP_CONTROLLERS');
    expect(shapeOf('rest')).toContain('registerGeneratedRoutes');
  });

  it('gives the cqrs and events seams to microservice alone', () => {
    for (const name of ['rest', 'class-based'] as const) {
      expect(barrels(getTemplate(name)!)).not.toContain('src/cqrs/index.ts');
      expect(barrels(getTemplate(name)!)).not.toContain('src/events/index.ts');
    }
    expect(barrels(getTemplate('microservice')!)).toContain('src/cqrs/index.ts');
    expect(barrels(getTemplate('microservice')!)).toContain('src/events/index.ts');
  });

  it('gives full-stack the ungated seams, wired as STATEMENTS', () => {
    // X5-8: it used to host none, so `setu generate route` — which the generated
    // README tells the developer to run — wrote a module and a barrel that
    // `setu.config.ts` imported neither of, and the route answered 404.
    const fullStack = getTemplate('full-stack')!;
    expect(barrels(fullStack)).toEqual([
      'src/controllers/index.ts',
      'src/middleware/index.ts',
      'src/plugins/index.ts',
    ]);
    expect(fullStack.setupCalls ?? []).toContain('registerGeneratedRoutes(app.router);');
  });

  it('registers generated plugins through app.register, having no array to spread', () => {
    // A starter builds the plugin list and no starter accepts extra plugins, so
    // the spread mechanism is unavailable here. `IApplication.register` is the
    // equivalent: the kernel resolves plugins at `start()`, and the generated
    // factory deliberately does not start.
    const fullStack = getTemplate('full-stack')!;
    expect(fullStack.setupCalls ?? []).toContain(
      'for (const generated of GENERATED_PLUGINS) app.register(generated);',
    );
    expect(fullStack.pluginSpreads ?? []).toEqual([]);
  });

  // Enforced across the registry rather than by a runtime check no user input could
  // reach, exactly as the `plugins`-vs-`appFactory` rule already is.
  it('never spreads into a plugin array it does not have', () => {
    for (const template of listTemplates()) {
      if (template.appFactory === undefined) continue;
      // `setupCalls` are statements and compose with a starter factory; a
      // `pluginSpreads` entry would name an array the generated config lacks.
      expect(template.pluginSpreads ?? []).toEqual([]);
      expect(template.plugins).toEqual([]);
    }
  });
});
