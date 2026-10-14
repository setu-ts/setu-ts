import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { run } from '../../scripts/lib/run.ts';

it('loads every pure script and exercises the harmless entry points under plain Node', async () => {
  const explicit: Record<string, string[]> = {
    'node-manifests.ts': ['--check'],
    'plan-lint.ts': [],
    'inspect-kernel.ts': [],
    'check-deploy.ts': ['--render'],
  };
  const files = readdirSync('scripts').filter((file) => file.endsWith('.ts'));
  for (const file of files) {
    const source = readFileSync(`scripts/${file}`, 'utf8');
    const args = explicit[file] ?? (!source.includes('import.meta.main') ? [] : undefined);
    if (args === undefined) continue;
    const hook = /from\s+['"]@setu-ts\//.test(source)
      ? ['--import', './test/node-source-register.ts']
      : [];
    const result = await run(process.execPath, [...hook, `scripts/${file}`, ...args], {
      timeoutMs: 30_000,
    });
    expect(result.code, `${file}\n${result.stderr}`).toBe(0);
    expect(result.stderr, file).not.toContain('Deno is not defined');
  }
}, 120_000);

it('has no executable Deno APIs left in any ported script', () => {
  for (const file of readdirSync('scripts').filter((file) => file.endsWith('.ts'))) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(`scripts/${file}`, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const accesses: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(sf) === 'Deno')
        accesses.push(node.getText(sf));
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(accesses, file).toEqual([]);
  }
});
