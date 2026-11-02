import { describe, it, expect } from 'vitest';
import { resolveOptions } from '../../src/options.ts';
import type { McpToolDeclaration } from '../../src/options.ts';
import { declaration } from '../fixtures.ts';
describe('MCP declaration', () => {
  it.each(['a', 'a'.repeat(64), 'A-_.09'])('accepts name %s', (name) => {
    expect(resolveOptions({ tools: [{ ...declaration, name }] }).tools[0]?.name).toBe(name);
  });
  it.each(['', 'a'.repeat(65), 'a'.repeat(128), 'has space', 'has/slash', '💥'])(
    'refuses name %s',
    (name) => {
      expect(() => resolveOptions({ tools: [{ ...declaration, name }] })).toThrow();
    },
  );
  it.each([
    null,
    { name: 1 },
    { description: '' },
    { description: ' ' },
    { title: 4 },
    { route: null },
    { route: { method: 'HEAD', path: '/x' } },
    { route: { method: 'GET', path: 'x' } },
    { route: { method: 'GET', path: '/mcp' } },
    { repeatable: false },
  ])('refuses declaration %j', (bad) => {
    expect(() =>
      resolveOptions({
        tools: [
          (bad === null ? null : { ...declaration, ...bad }) as unknown as McpToolDeclaration,
        ],
      }),
    ).toThrow();
  });
  it('refuses duplicates but names are case sensitive', () => {
    expect(() => resolveOptions({ tools: [declaration, declaration] })).toThrow('Duplicate');
    expect(
      resolveOptions({
        tools: [declaration, { ...declaration, name: 'READ', title: 'Read', repeatable: true }],
      }).tools,
    ).toHaveLength(2);
  });
});

it('preserves an optional string title without adding a non-empty restriction', () => {
  expect(resolveOptions({ tools: [{ ...declaration, title: '' }] }).tools[0]?.title).toBe('');
});
