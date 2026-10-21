import { describe, expect, it } from 'vitest';
import { RULE_BLOCKS } from '../../../src/agents/rules.ts';
import { agentFacts } from '../../fixtures/agent-facts.ts';
import {
  checkFences,
  exportedIdentifiers,
  identifierProblems,
} from '../../../../../test/fixtures/snippets/agent-card-checks.ts';

describe('composition-specific rule blocks', () => {
  const always = ['generate', 'services', 'time', 'errors', 'config', 'imports'];
  for (const [runtime, style, plugins, expected] of [
    ['node', 'functional', [], ['functional', 'node-tests']],
    ['bun', 'class-based', ['decorator-plugin', 'di-plugin'], ['class-based', 'bun-tests']],
    [
      'deno',
      'functional',
      ['react-router-plugin', 'messaging-plugin'],
      ['functional', 'deno-tests', 'full-stack', 'messaging'],
    ],
    ['cloudflare-workers', 'class-based', ['decorator-plugin'], ['class-based', 'workers']],
  ] as const) {
    it(`${runtime} ${style}: selects exactly its ordered applicable rules`, () => {
      const facts = agentFacts({ runtime, style, installed: new Set(plugins) });
      expect(
        RULE_BLOCKS.filter((r) => r.applies(facts))
          .map((r) => r.id)
          .sort(),
      ).toEqual([...always, ...expected].sort());
    });
  }
  it('checks identifiers against common and each rule’s required packages and compiles its snippets', async () => {
    const packages = [...new Set(['common', ...RULE_BLOCKS.flatMap((r) => r.packages)])].map(
      (p) => `packages/${p}`,
    );
    const inventory = await exportedIdentifiers(packages);
    for (const rule of RULE_BLOCKS) {
      const allowed = new Set(
        ['common', ...rule.packages].flatMap((pkg) => [...inventory.get(`packages/${pkg}`)!]),
      );
      expect(identifierProblems(rule.text, allowed), rule.id).toEqual([]);
      expect(await checkFences(rule.id, rule.text, '.tmp/agent-rule-fences')).toBe(0);
    }
  });
});
