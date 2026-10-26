import { expect, it } from 'vitest';
import { classifyWiring, wiringFinding, wiringSites } from '../../src/diagnostics/wiring.ts';
import { hostSeamSpecs } from '../../src/seams/registry.ts';

it('classifies code and imports, masks strings/comments and refuses undecidable source', () => {
  expect(classifyWiring('use(APP_CONTROLLERS)', 'APP_CONTROLLERS')).toBe('wired');
  expect(classifyWiring("import { APP_CONTROLLERS } from './index.ts';", 'APP_CONTROLLERS')).toBe(
    'wired',
  );
  expect(
    classifyWiring("// APP_CONTROLLERS\nconst label = 'APP_CONTROLLERS';", 'APP_CONTROLLERS'),
  ).toBe('unwired');
  expect(classifyWiring('const label = `APP_CONTROLLERS`;', 'APP_CONTROLLERS')).toBe(
    'unclassifiable',
  );
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
    outcome: 'unclassifiable',
  });
});
