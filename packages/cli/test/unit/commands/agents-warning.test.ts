import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cards from '../../../src/agents/card-presence.ts';
import { runAgentsCommand } from '../../../src/commands/agents.ts';
import { createFakeFs, createRecorder } from '../../fixtures/fake-fs.ts';

describe('agent warning output', () => {
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
