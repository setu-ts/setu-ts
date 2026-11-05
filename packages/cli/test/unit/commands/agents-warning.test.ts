import { cliInvocation } from '../../../src/templates/project-files.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cards from '../../../src/agents/card-presence.ts';
import { runAgentsCommand } from '../../../src/commands/agents.ts';
import { createFakeFs, createRecorder } from '../../fixtures/fake-fs.ts';

describe('agent warning output', () => {
  it('X93-8 defers cards in new scaffolds with one runtime-specific install hint', async () => {
    const warnings = vi
      .spyOn(cards, 'cardWarnings')
      .mockResolvedValue(['card one missing', 'card two missing']);
    for (const runtime of ['node', 'bun', 'deno'] as const) {
      const error = createRecorder();
      const seed =
        runtime === 'deno'
          ? { '/app/deno.json': '{}' }
          : {
              '/app/package.json': JSON.stringify({
                scripts: { start: runtime === 'bun' ? 'bun main.ts' : 'node main.ts' },
              }),
            };
      expect(
        await runAgentsCommand(
          { positionals: [], flags: {} },
          {
            fs: createFakeFs(seed),
            cwd: '/app',
            log: () => {},
            error: error.sink,
            installPending: true,
          },
        ),
      ).toBe(0);
      expect(error.lines).toEqual([
        `agent cards resolve after \`${runtime === 'node' ? 'npm' : runtime} install\`; then run \`${cliInvocation(runtime)} agents --check\``,
      ]);
    }
    expect(warnings).not.toHaveBeenCalled();
  });
  afterEach(() => vi.restoreAllMocks());
  it('F2 escapes every advisory warning before it reaches the terminal sink', async () => {
    // Independently drive the output boundary: F1 also rejects hostile package names.
    vi.spyOn(cards, 'cardWarnings').mockResolvedValue(['card not found: x\nFORGED\t\r\u001b[2J']);
    const error = createRecorder();
    expect(
      await runAgentsCommand(
        { positionals: [], flags: {} },
        {
          fs: createFakeFs({ '/app/package.json': '{}' }),
          cwd: '/app',
          log: () => {},
          error: error.sink,
        },
      ),
    ).toBe(0);
    expect(error.lines).toEqual(['card not found: x\\u000aFORGED\\u0009\\u000d\\u001b[2J']);
  });
});
