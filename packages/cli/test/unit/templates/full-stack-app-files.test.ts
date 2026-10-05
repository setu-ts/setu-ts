/** Contract tests for the app files emitted by the full-stack template. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { FULL_STACK_APP_FILES } from '../../../src/templates/full-stack-app-files.ts';

function contentsOf(path: string): string {
  const file = FULL_STACK_APP_FILES.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`Full-stack app files emit no ${path}`);
  return file.contents;
}

describe('full-stack app files', () => {
  it('documents who renders a route-middleware refusal', () => {
    const middleware = contentsOf('app/middleware/require-user.server.ts');

    expect(middleware).toContain("rendered by React Router's route error boundary");
    expect(middleware).toContain('API callers');
  });
});
