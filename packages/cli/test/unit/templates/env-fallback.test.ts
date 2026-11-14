import { expect, it } from 'vitest';
import { runtimeEnvRead } from '../../../src/templates/env-fallback.ts';

/** Imports a rendered JavaScript expression with the supplied runtime environment. */
async function readExpression(expression: string, env: Record<string, string>): Promise<unknown> {
  const source = `const runtime = { env: ${JSON.stringify(env)} }; export default ${expression};`;
  const result: { default: unknown } = await import(
    `data:text/javascript,${encodeURIComponent(source)}`
  );
  return result.default;
}

it('renders an empty-means-unset runtime environment read', async () => {
  const expression = runtimeEnvRead('PORT', '3000');
  const cases = [
    [{ PORT: '' }, '3000'],
    [{}, '3000'],
    [{ PORT: '4000' }, '4000'],
  ] as const;
  for (const [env, expected] of cases) {
    expect(await readExpression(expression, env)).toBe(expected);
  }
  expect(expression).toBe("runtime.env.PORT || '3000'");
});

it('keeps a quoted fallback a literal', async () => {
  const fallback = "it's a fallback";
  expect(await readExpression(runtimeEnvRead('PORT', fallback), {})).toBe(fallback);
});
