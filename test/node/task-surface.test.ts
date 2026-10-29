import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };

it('removes the root Deno manifest and the forwarding task surface', () => {
  // Plan §3.2: every command is `pnpm run <name>`, so the root `deno.json`
  // and `deno.lock` that only forwarded to it are gone, as are the website's
  // and the apps' Deno manifests.
  expect(existsSync('deno.json')).toBe(false);
  expect(existsSync('deno.lock')).toBe(false);
  expect(existsSync('website/deno.json')).toBe(false);
  const appManifests = readdirSync('apps', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => ['deno.json', 'deno.lock'].map((file) => `apps/${entry.name}/${file}`))
    .filter((file) => existsSync(file));
  expect(appManifests).toEqual([]);
});

it('keeps the package-suite and tooling-suite scripts distinct', () => {
  expect(pkg.scripts.test).toBe('node scripts/test-node.ts');
  expect(pkg.scripts['test:coverage']).toBe('node scripts/test-node.ts --coverage');
  expect(pkg.scripts['test:tooling']).toBe('SETU_TEST_MEMBER=tooling vitest run');
  expect(pkg.scripts['test:tooling:coverage']).toBe(
    'SETU_TEST_MEMBER=tooling vitest run --coverage',
  );
  expect(pkg.scripts['test:deno-lane']).toBe('node scripts/test-deno-lane.ts');
  expect(pkg.scripts.check).toBe('tsc -p tsconfig.check.json --noEmit');
});

it('pins the package scripts that invoke deno directly', () => {
  // Only the SDK fixture formatting keeps a direct `deno` command (§3.11):
  // the generator's output target is `deno fmt`, not Prettier.
  const direct = Object.entries(pkg.scripts)
    .filter(([, command]) => /\bdeno\s/.test(command))
    .map(([name]) => name)
    .sort();
  expect(direct).toEqual(['fmt', 'fmt:check']);
});

it('pins every repository script that launches a Deno subject', () => {
  // The Deno lane and the deploy gate's Deno-target scaffold launch Deno.
  // The diagnostics consumer now stays in the invoking runtime.
  const retained = readdirSync('scripts')
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => {
      const source = readFileSync(`scripts/${file}`, 'utf8');
      return /\b(?:runProcess|run|execute)\(\s*(?:'deno'|\[\s*'deno')/.test(source);
    })
    .sort();
  expect(retained).toEqual(['check-deploy.ts', 'test-deno-lane.ts']);
});

it('keeps every root test fixture off Deno', () => {
  const retained = readdirSync('test/fixtures', { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.ts'))
    .filter((file) =>
      /\b(?:runProcess|run)\(\s*'deno'/.test(readFileSync(`test/fixtures/${file}`, 'utf8')),
    )
    .sort();
  expect(retained).toEqual([]);
});
