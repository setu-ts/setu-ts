import { expect, it } from 'vitest';
import { runtimeEnvRead, withNullishEnvReads } from '../../../src/templates/env-fallback.ts';
import { parseEnvRead } from '../../fixtures/env-read-shape.ts';

it('renders an empty-means-unset runtime environment read', () => {
  const expression = runtimeEnvRead('PORT', '3000');
  expect(expression).toBe("runtime.env.PORT || '3000'");
  // Parsed, not executed: the logical-or is what sends '' to the fallback.
  expect(parseEnvRead(expression)).toEqual({ operator: '||', variable: 'PORT', fallback: '3000' });
});

it('keeps a quoted fallback a literal', () => {
  const fallback = "it's a fallback";
  expect(parseEnvRead(runtimeEnvRead('PORT', fallback))?.fallback).toBe(fallback);
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

it('parses the nullish form earlier releases wrote as the other operator', () => {
  const nullish = withNullishEnvReads(runtimeEnvRead('PORT', '3000'), [['PORT', '3000']]);
  expect(parseEnvRead(nullish)).toEqual({ operator: '??', variable: 'PORT', fallback: '3000' });
  expect(parseEnvRead("process.env.PORT || '3000'")).toBeUndefined();
});
