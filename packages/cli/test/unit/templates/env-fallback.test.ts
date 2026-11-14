import { expect, it } from 'vitest';
import { runtimeEnvRead, withNullishEnvReads } from '../../../src/templates/env-fallback.ts';

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

it('rewrites only the listed current reads to the nullish form earlier releases wrote', () => {
  const source =
    `const port = Number(${runtimeEnvRead('PORT', '3000')});\n` +
    `const vitePort = Number(${runtimeEnvRead('VITE_PORT', '5173')});\n` +
    `const other = ${runtimeEnvRead('OTHER', 'x')};\n`;
  expect(
    withNullishEnvReads(source, [
      ['PORT', '3000'],
      ['VITE_PORT', '5173'],
    ]),
  ).toBe(
    "const port = Number(runtime.env.PORT ?? '3000');\n" +
      "const vitePort = Number(runtime.env.VITE_PORT ?? '5173');\n" +
      "const other = runtime.env.OTHER || 'x';\n",
  );
  expect(withNullishEnvReads(source, [])).toBe(source);
});
