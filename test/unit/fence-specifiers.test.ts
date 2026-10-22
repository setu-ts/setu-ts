import { expect, it } from 'vitest';
import { normaliseFenceSpecifiers } from '../fixtures/snippets/fence-engine.ts';
import { compileFence } from '../fixtures/snippets/fence-engine.ts';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';

it('leaves npm: specifiers unchanged while @hono/hono is still rewritten', () => {
  const source = `import { z } from 'npm:zod@^3.24.0';
export { pgTable } from 'npm:drizzle-orm@^0.45.2/pg-core';
import { html } from '@hono/hono/html';
import local from './local.ts';
// npm:zod@^3.24.0
const prose = 'npm:zod@^3.24.0';
type T = import('npm:graphql@^16').GraphQLSchema;
const dynamic = import('npm:@scope/name@^1/sub');`;
  expect(normaliseFenceSpecifiers(source)).toBe(
    source.replace("from '@hono/hono/html'", "from 'hono/html'"),
  );
});

it('invalidates reused diagnostics when the fence or its dependency changes', async () => {
  await mkdir('.tmp', { recursive: true });
  const dir = await mkdtemp('.tmp/fence-cache-');
  const file = `${dir}/proof.ts`;
  const dependency = `${dir}/dependency.ts`;
  const context = {};
  try {
    await writeFile(
      file,
      "import { value } from './dependency.ts';\nconst result: number = value;\n",
    );
    await writeFile(dependency, 'export const value = 1;\n');
    expect((await compileFence(file, context)).code).toBe(0);
    await writeFile(dependency, "export const value = 'wrong';\n");
    const broken = await compileFence(file, context);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain('TS2322');
    await writeFile(dependency, 'export const value = 1;\n');
    expect((await compileFence(file, context)).code).toBe(0);
    await writeFile(
      file,
      "import { value } from './dependency.ts';\nconst result: string = value;\n",
    );
    expect((await compileFence(file, context)).code).toBe(1);
  } finally {
    await rm(dir, { recursive: true });
  }
}, 30_000);
