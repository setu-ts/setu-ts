import { describe, expect, it } from 'vitest';
import { TARGET_RUNTIMES } from '../../../src/constants.ts';
import { ADDABLE } from '../../../src/commands/add.ts';
import { renderBrief, renderWorkspaceRoot } from '../../../src/agents/render.ts';
import { gatherFacts } from '../../../src/agents/facts.ts';
import { runCli } from '../../../src/cli.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';
import { agentFacts } from '../../fixtures/agent-facts.ts';
import { availableSchematics } from '../../../src/commands/generate.ts';
import { seamsFor } from '../../../src/templates/seam.ts';

describe('agent brief byte budgets', () => {
  it('covers style × runtime × all template defaults, all addable packages, and none', async () => {
    for (const runtime of TARGET_RUNTIMES) {
      const compositions: ReadonlySet<string>[] = [
        new Set(),
        new Set([...ADDABLE.values()].map((p) => p.pkg)),
      ];
      for (const template of ['rest', 'class-based', 'microservice', 'full-stack']) {
        const fs = createFakeFs();
        expect(
          await runCli(['new', 'app', '--template', template, '--runtime', runtime], {
            fs,
            cwd: '/work',
            now: () => 0,
            log: () => {},
            error: () => {},
          }),
        ).toBe(0);
        compositions.push((await gatherFacts(fs, '/work/app')).installed);
      }
      for (const style of ['functional', 'class-based'] as const) {
        for (const installed of compositions) {
          const facts = agentFacts({
            runtime,
            style,
            installed,
            commands: [
              'start',
              'start:dev',
              'start:debug',
              'check',
              'test',
              'test:e2e',
              'dev',
              'build',
              'db:migrate',
            ],
            commandBodies: {
              dev: runtime === 'cloudflare-workers' ? 'wrangler dev' : 'main.dev.ts',
            },
            schematics: availableSchematics(installed).map((s) => s.name),
            seams: [...new Set(seamsFor(installed).map((s) => s.dir))],
            directories: ['src/modules', 'src/shared'],
          });
          const label = `${runtime}/${style}/${installed.size}`;
          expect(new TextEncoder().encode(renderBrief(facts)).length, label).toBeLessThanOrEqual(
            12288,
          );
          expect(
            new TextEncoder().encode(renderBrief(facts, true)).length,
            label,
          ).toBeLessThanOrEqual(12288);
        }
      }
      expect(
        new TextEncoder().encode(
          renderWorkspaceRoot(
            {
              runtime,
              version: 1,
              basePort: 3000,
              transport: 'http',
              members: [
                { name: 'orders', port: 3000 },
                { name: 'billing', port: 3001 },
              ],
            },
            '1',
          ),
        ).length,
      ).toBeLessThanOrEqual(4096);
    }
  });
});
