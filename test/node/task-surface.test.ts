import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

const deno = JSON.parse(readFileSync('deno.json', 'utf8')) as { tasks: Record<string, string> };
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };

it('preserves every task name and the tooling-only test pair', () => {
  for (const name of Object.keys(deno.tasks)) {
    const target =
      name === 'test' ? 'test:tooling' : name === 'test:coverage' ? 'test:tooling:coverage' : name;
    expect(deno.tasks[name], name).toBe(`pnpm run ${target}`);
    expect(pkg.scripts[target], target).toBeTypeOf('string');
  }
  expect(pkg.scripts.test).toBe('node scripts/test-node.ts');
  expect(pkg.scripts['test:coverage']).toBe('node scripts/test-node.ts --coverage');
  expect(pkg.scripts['test:tooling']).toBe('SETU_TEST_MEMBER=tooling vitest run');
  expect(pkg.scripts['test:tooling:coverage']).toBe(
    'SETU_TEST_MEMBER=tooling vitest run --coverage',
  );
  expect(pkg.scripts.check).toBe('tsc -p tsconfig.check.json --noEmit');
});

it('pins the plan section 3.12 direct Deno commands', () => {
  const direct = Object.entries(pkg.scripts)
    .filter(([, command]) => /\bdeno\s/.test(command))
    .map(([name]) => name)
    .sort();
  // `check:browser` runs the full-stack app's browser harness, which is a Deno
  // program until M111e3 moves the apps to pnpm.
  expect(direct).toEqual(['audit', 'check:browser', 'fmt', 'fmt:check']);
});

it('pins every repository script that launches a Deno subject', () => {
  const retained = readdirSync('scripts')
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => {
      const source = readFileSync(`scripts/${file}`, 'utf8');
      return (
        /\b(?:runProcess|run)\(\s*(?:'deno'|\[\s*'deno')/.test(source) ||
        /cmd\.run\(\[mode === 'check' \? process\.execPath : 'deno'/.test(source)
      );
    })
    .sort();
  expect(retained).toEqual([
    'audit.ts',
    'check-apps.ts',
    'generate-api-docs.ts',
    'inspect-local-diagnostics.ts',
    'test-deno-lane.ts',
  ]);
});

it('pins the root test fixtures that launch Deno', () => {
  // `contract-ast.ts` reads interface shapes through `deno doc --json`; M111e3
  // owns removing the last `deno` from the root suite.
  const retained = readdirSync('test/fixtures', { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.ts'))
    .filter((file) =>
      /\b(?:runProcess|run)\(\s*'deno'/.test(readFileSync(`test/fixtures/${file}`, 'utf8')),
    )
    .sort();
  expect(retained).toEqual(['contract-ast.ts']);
});
