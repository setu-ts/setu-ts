import { describe, expect, it } from 'vitest';
import {
  renderBrief,
  renderMemberPointer,
  renderWorkspaceRoot,
} from '../../../src/agents/render.ts';
import type { WorkspaceManifest } from '../../../src/workspace/manifest.ts';
import { agentFacts } from '../../fixtures/agent-facts.ts';

describe('workspace briefs', () => {
  const manifest: WorkspaceManifest = {
    version: 1,
    basePort: 3000,
    runtime: 'node',
    transport: 'redis',
    transportUrl: 'redis://localhost:6379',
    members: [
      { name: 'orders', port: 3000, devtoolPort: 4919 },
      { name: 'billing', port: 3001, dependsOn: ['orders'] },
    ],
  };
  it.each(['\n', '`', '|', '<', '>', '\r', '\u0000', '\u007f', '\u2028', '\u202e'])(
    'F1 suppresses unsafe workspace display values containing %j',
    (char) => {
      const value = `CANARY${char}injection`;
      const text = renderWorkspaceRoot(
        {
          ...manifest,
          transportUrl: value,
          members: [{ name: value, port: 3000, dependsOn: ['orders', value] }],
        },
        '1',
      );
      expect(text).not.toContain(value);
      expect(text).toContain('| (not shown) | 3000 | orders, (not shown) |');
      expect(text).toContain('apps/(not shown)/AGENTS.md');
      expect(text).toContain('Endpoint override: (not shown).');
    },
  );
  it('F1 refuses duplicate markers in a rendered workspace section', () => {
    expect(() => renderWorkspaceRoot(manifest, '<!-- setu-agents:end -->')).toThrow(
      'exactly one begin marker and one end marker',
    );
  });
  it('renders members, ports, dependencies and transport variable and URL', () => {
    const text = renderWorkspaceRoot(manifest, '1.0.0');
    for (const value of [
      'orders',
      '3000',
      '4919',
      'billing',
      '3001',
      'REDIS_URL',
      'redis://localhost:6379',
      'apps/billing/AGENTS.md',
      'npm run dev',
      'npm test',
      'npm run build',
      'npm run deploy',
      'k8s/secrets/<member>/.env',
    ])
      expect(text).toContain(value);
    expect(text).not.toContain('## Installed');
    expect(renderBrief(agentFacts(), true)).toContain(renderMemberPointer());
  });
  it('supports all workspace runners and endpoint-free transports', () => {
    for (const [runtime, runner] of [
      ['deno', 'deno task'],
      ['bun', 'bun run'],
    ] as const)
      expect(renderWorkspaceRoot({ ...manifest, runtime, transport: 'http' }, '1')).toContain(
        `${runner} dev`,
      );
    const { transportUrl: removed, ...withoutUrl } = manifest;
    expect(removed).toBeDefined();
    expect(renderWorkspaceRoot({ ...withoutUrl, transport: 'http' }, '1')).toContain(
      'URL variable: none. Endpoint override: transport default',
    );
  });
  it('names root card paths in member rules and package rows while standalone paths stay local', () => {
    const facts = agentFacts({ installed: new Set(['common']) });
    expect(renderBrief(facts, true)).toContain(
      '`../../node_modules/@setu-ts/<package>/AGENT_CARD.md`',
    );
    expect(renderBrief(facts, true)).toContain(
      '| ../../node_modules/@setu-ts/common/AGENT_CARD.md |',
    );
    expect(renderBrief(facts)).toContain('`node_modules/@setu-ts/<package>/AGENT_CARD.md`');
    expect(renderBrief(facts)).toContain('| node_modules/@setu-ts/common/AGENT_CARD.md |');
  });
});
