import { expect, it } from 'vitest';
import { classifyWiring, wiringFinding, wiringSites } from '../../src/diagnostics/wiring.ts';
import { hostSeamSpecs } from '../../src/seams/registry.ts';

it('X91-3 requires registerModules to be called and consumes values outside imports', () => {
  for (const source of [
    "import { registerModules } from './index.ts';",
    "import { registerModules } from './index.ts'; const pending = registerModules;",
  ])
    expect(classifyWiring(source, 'registerModules')).toBe('unwired');
  expect(
    classifyWiring(
      "import { GENERATED_PLUGINS } from './index.ts'; const p = [...GENERATED_PLUGINS];",
      'GENERATED_PLUGINS',
    ),
  ).toBe('wired');
});

it('classifies code and imports, masks strings/comments and refuses undecidable source', () => {
  expect(classifyWiring('use(APP_CONTROLLERS)', 'APP_CONTROLLERS')).toBe('wired');
  expect(classifyWiring("import { APP_CONTROLLERS } from './index.ts';", 'APP_CONTROLLERS')).toBe(
    'unwired',
  );
  expect(
    classifyWiring("// APP_CONTROLLERS\nconst label = 'APP_CONTROLLERS';", 'APP_CONTROLLERS'),
  ).toBe('unwired');
  expect(classifyWiring('const label = `APP_CONTROLLERS`;', 'APP_CONTROLLERS')).toBe('unwired');
});

it('classifies a config reading env by bracket access, still refusing a computed constructor', () => {
  const config = [
    "import { registerModules } from './src/modules/index.ts';",
    "const secret = createRuntimeServices().env['JWT_SECRET'] ?? 'demo';",
    'registerModules(app.router, app.services);',
  ].join('\n');
  expect(classifyWiring(config, 'registerModules')).toBe('wired');
  expect(classifyWiring(config, 'GENERATED_PLUGINS')).toBe('unwired');
  expect(
    classifyWiring(config.replace("['JWT_SECRET']", "['constructor']"), 'registerModules'),
  ).toBe('unclassifiable');
});

it('checks every host export and preserves the narrower generator inventory', () => {
  for (const installed of [
    new Set<string>(),
    new Set(['decorator-plugin', 'di-plugin', 'queue-plugin', 'cqrs-plugin', 'events-plugin']),
  ]) {
    const sites = wiringSites(installed, false);
    for (const spec of hostSeamSpecs(installed))
      expect(sites.get(spec.barrel)?.symbols).toEqual(spec.exports);
    expect(sites.get('src/modules/index.ts')?.symbols).toEqual([
      installed.has('decorator-plugin') ? 'MODULES' : 'registerModules',
    ]);
  }
  expect([...wiringSites(new Set(['queue-plugin']), true).keys()]).toEqual([
    'src/jobs/index.ts',
    'src/modules/index.ts',
  ]);
});

it('returns missing symbols only and names the starter decorators arm', () => {
  expect(wiringFinding('use(A, B)', 'src/index.ts', ['A', 'B'], 'config')).toBeUndefined();
  expect(wiringFinding('use(A)', 'src/index.ts', ['A', 'B'], 'config')).toEqual({
    kind: 'unwired',
    barrel: 'src/index.ts',
    symbols: ['B'],
    site: 'config',
    outcome: 'unwired',
  });
  expect(
    wiringFinding(
      "import { createRestApp } from '@setu-ts/rest-starter';",
      'src/controllers/index.ts',
      ['APP_CONTROLLERS'],
      'controllers',
    ),
  ).toMatchObject({ starter: 'createRestApp', outcome: 'unwired' });
  expect(wiringFinding('const x = `template`;', 'src/index.ts', ['A'], 'config')).toMatchObject({
    outcome: 'unwired',
  });
});

it('V12-32 classifies template substitutions and regex arrays without counting text references', () => {
  for (const source of [
    'const base = `https://${host}`; use(APP_CONTROLLERS);',
    'const patterns = [/a/, /b/]; use(APP_CONTROLLERS);',
  ])
    expect(classifyWiring(source, 'APP_CONTROLLERS')).toBe('wired');
  expect(classifyWiring('const label = `APP_CONTROLLERS ${other}`;', 'APP_CONTROLLERS')).toBe(
    'unwired',
  );
});
