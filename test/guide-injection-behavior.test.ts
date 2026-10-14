import { run as runProcess } from './../scripts/lib/run.ts';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
/** Executes the actual injection examples extracted from the curated guide. @module */
import { describe, expect, it } from 'vitest';

function injectionFences(markdown: string): readonly string[] {
  const matches = [...markdown.matchAll(/```typescript\n([\s\S]*?)```/g)];
  return matches
    .map((match) => match[1] ?? '')
    .filter((code) => code.includes("import { inject } from '@setu-ts/testing';"));
}

describe('programmatic API injection examples', () => {
  it('executes both actual guide fences with their assertions and shutdown', async () => {
    const guide = await readFile('docs/programmatic-api.md', 'utf8');
    const fences = injectionFences(guide);
    expect(fences.length).toBe(2);
    await mkdir('.tmp/guide-injection', { recursive: true });
    for (const [index, code] of fences.entries()) {
      expect(code).toContain('await app.start()');
      expect(code).toContain('await app.stop()');
      const path = `.tmp/guide-injection/example-${index}.ts`;
      await writeFile(path, code);
      const output = await runProcess(process.execPath, [
        '--import',
        './test/node-source-register.ts',
        path,
      ]);
      expect(output.stderr).toBe('');
      expect(output.code).toBe(0);
    }
  });
});
