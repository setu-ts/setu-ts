import { describe, expect, it } from 'vitest';

import { memberEnvProblem } from '../../../src/commands/check.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';
import type { IFileSystem } from '@setu-ts/common';

/** A filesystem whose `stat` on one path throws the given value. */
function throwingStat(thrown: unknown): IFileSystem {
  const fs = createFakeFs({ '/ws/apps/portal/main.ts': '' });
  return {
    ...fs,
    stat: (path: string) =>
      path === '/ws/apps/portal/.env' ? Promise.reject(thrown) : fs.stat(path),
  } as IFileSystem;
}

describe('memberEnvProblem (M122 re-audit N4)', () => {
  it('passes an absent or regular .env', async () => {
    const fs = createFakeFs({ '/ws/apps/portal/.env': 'A=1\n' });
    expect(await memberEnvProblem(fs, '/ws', '/ws/apps/portal/.env')).toBeUndefined();
    expect(await memberEnvProblem(fs, '/ws', '/ws/apps/orders/.env')).toBeUndefined();
  });

  it('reports a .env it cannot inspect, whatever was thrown', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(await memberEnvProblem(throwingStat(denied), '/ws', '/ws/apps/portal/.env')).toContain(
      'cannot be inspected: EACCES: permission denied',
    );
    expect(await memberEnvProblem(throwingStat('odd'), '/ws', '/ws/apps/portal/.env')).toContain(
      'cannot be inspected: odd',
    );
  });

  it('reports a path it cannot resolve as a refusal, with the Compose consequence', async () => {
    const fs = createFakeFs({});
    const broken = { ...fs, realPath: () => Promise.reject(new Error('boom')) } as IFileSystem;
    expect(await memberEnvProblem(broken, '/ws', '/ws/apps/portal/.env')).toContain(
      'docker compose would follow it',
    );
  });
});
