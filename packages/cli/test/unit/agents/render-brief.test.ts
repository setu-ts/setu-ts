import { describe, expect, it } from 'vitest';
import { renderBrief } from '../../../src/agents/render.ts';
import { agentFacts } from '../../fixtures/agent-facts.ts';

describe('project brief rendering', () => {
  it('renders all sections, exact commands and deterministic installed and addable rows', () => {
    const facts = agentFacts({
      installed: new Set(['runtime', 'common', 'cache-plugin', 'third-party']),
      directories: ['src/modules', 'src/shared'],
    });
    const text = renderBrief(facts);
    expect(renderBrief(facts)).toBe(text);
    let position = -1;
    for (const section of [
      '# Setu-TS',
      'Rule 0',
      '## Commands',
      '## Schematics',
      '## Rules',
      '## Project map',
      '## Installed',
      '## Not installed',
    ]) {
      const next = text.indexOf(section);
      expect(next).toBeGreaterThan(position);
      position = next;
    }
    expect(text).toContain('npm run check');
    expect(text).not.toContain('npm run build');
    expect(text).toContain('node_modules/@setu-ts/cache-plugin/AGENT_CARD.md');
    expect(text).toContain('Read the installed package documentation');
    expect(text).toContain('CAPABILITIES.RUNTIME');
    expect(text).toContain('src/shared/');
    const absent = text.split('## Not installed')[1];
    expect(absent).not.toContain('`cache`');
    expect(absent).not.toContain('`cloudflare`');
    expect(absent).toContain('`scheduler`');
  });
  it('selects the runtime command runner and Workers entry and addable restrictions', () => {
    for (const [runtime, command] of [
      ['deno', 'deno task'],
      ['bun', 'bun run'],
      ['cloudflare-workers', 'npm run'],
    ] as const) {
      const text = renderBrief(agentFacts({ runtime }));
      expect(text).toContain(`${command} start`);
      if (runtime === 'cloudflare-workers') {
        expect(text).toContain('src/index.ts');
        expect(text.split('## Not installed')[1]).not.toContain('`scheduler`');
        expect(text.split('## Not installed')[1]).toContain('`cloudflare`');
      }
    }
  });
});
