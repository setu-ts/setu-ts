/** Executes the actual injection examples extracted from the curated guide. @module */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

function injectionFences(markdown: string): readonly string[] {
  const matches = [...markdown.matchAll(/```typescript\n([\s\S]*?)```/g)];
  return matches.map((match) => match[1] ?? '').filter((code) =>
    code.includes("import { inject } from '@setu-ts/testing';")
  );
}

describe('programmatic API injection examples', () => {
  it('executes both actual guide fences with their assertions and shutdown', async () => {
    const guide = await Deno.readTextFile('docs/programmatic-api.md');
    const fences = injectionFences(guide);
    expect(fences.length).toBe(2);
    await Deno.mkdir('.tmp/guide-injection', { recursive: true });
    for (const [index, code] of fences.entries()) {
      expect(code).toContain('await app.start()');
      expect(code).toContain('await app.stop()');
      const path = `.tmp/guide-injection/example-${index}.ts`;
      await Deno.writeTextFile(path, code);
      const output = await new Deno.Command('deno', {
        args: ['run', '-A', path],
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      expect(new TextDecoder().decode(output.stderr)).toBe('');
      expect(output.code).toBe(0);
    }
  });
});
