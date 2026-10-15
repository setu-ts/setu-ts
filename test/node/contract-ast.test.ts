/** Pins compiler-API records to the former Deno doc engine's output. @module */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { contractAst } from '../fixtures/contract-ast.ts';
import shapes from '../fixtures/contract-shapes.json' with { type: 'json' };

describe('TypeScript contract records', () => {
  for (const [name, path] of [
    ['IRequest', 'http'],
    ['IRuntimeServices', 'runtime'],
    ['IResponse', 'http'],
  ] as const) {
    it(`preserves the committed ${name} shape from deno doc`, async () => {
      const source = await readFile(`packages/common/src/${path}.ts`, 'utf8');
      expect(await contractAst(source, name, name)).toEqual(shapes[name]);
    });
  }
});
