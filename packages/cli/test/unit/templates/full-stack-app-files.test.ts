/** Contract tests for the app files emitted by the full-stack template. */
import { describe, expect, it } from 'vitest';

import {
  FULL_STACK_APP_FILES,
  FULL_STACK_README_SECTION,
} from '../../../src/templates/full-stack-app-files.ts';
import { cliInvocation } from '../../../src/templates/project-files.ts';

function contentsOf(path: string): string {
  const file = FULL_STACK_APP_FILES.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`Full-stack app files emit no ${path}`);
  return file.contents;
}

describe('full-stack app files', () => {
  for (const runtime of ['node', 'deno', 'bun', 'cloudflare-workers'] as const) {
    it(`aligns the README table around the pinned ${runtime} command`, () => {
      const invocation = cliInvocation(runtime);
      const section = FULL_STACK_README_SECTION(invocation);
      const table = section.split('\n').filter((line) => line.startsWith('|'));
      expect(table).toHaveLength(4);
      const widths = table.map((line) => line.split('|').at(-2)!.length);
      expect(new Set(widths).size).toBe(1);
      expect(section).toContain(`${invocation} generate middleware <name>`);
    });
  }

  it('documents who renders a route-middleware refusal', () => {
    const middleware = contentsOf('app/middleware/require-user.server.ts');

    expect(middleware).toContain("rendered by React Router's route error boundary");
    expect(middleware).toContain('API callers');
  });
});
