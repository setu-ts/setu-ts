import { expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import ts from 'typescript';
import { ZERO_CONFIG_WIRINGS } from '../../src/utils/plugin-wirings.ts';

it('keeps every moved factory entry and verifies each package exports its factory', async () => {
  expect([...ZERO_CONFIG_WIRINGS.keys()]).toEqual([
    'worker-pool-plugin',
    'secrets-plugin',
    'storage-plugin',
    'audit-plugin',
    'mail-plugin',
    'resilience-plugin',
    'view-plugin',
    'idempotency-plugin',
    'cqrs-plugin',
    'events-plugin',
    'messaging-plugin',
    'queue-plugin',
    'scheduler-plugin',
    'websocket-plugin',
    'cache-plugin',
    'health-plugin',
    'metrics-plugin',
    'openapi-plugin',
    'sse-plugin',
    'realtime-backplane-plugin',
  ]);
  for (const [pkg, { symbol }] of ZERO_CONFIG_WIRINGS) {
    const source = await fs.readFile(
      new URL(`../../../${pkg}/src/index.ts`, import.meta.url),
      'utf8',
    );
    const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
    const exports = ast.statements
      .filter(ts.isExportDeclaration)
      .flatMap((node) =>
        node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((entry) => entry.name.text)
          : [],
      );
    expect(exports, pkg).toContain(symbol);
  }
});
