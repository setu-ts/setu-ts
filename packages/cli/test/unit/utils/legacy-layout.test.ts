/**
 * Unit tests for the pre-E8 layout notice.
 *
 * Found by review, not by a gate. E8 is a breaking layout change, and the case
 * that matters is not a fresh scaffold but a project that already has
 * `src/routes/` — which every other check here is blind to, because the artifact
 * scanner reads `src/controllers/` and never looks at the old directory.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createFakeFs } from '../../fixtures/fake-fs.ts';
import {
  LEGACY_HTTP_DIR,
  legacyLayoutNotice,
  readLegacyHttpFiles,
} from '../../../src/utils/legacy-layout.ts';

describe('readLegacyHttpFiles', () => {
  it('lists the TypeScript files an un-migrated project left behind', async () => {
    const fs = createFakeFs({
      '/app/src/routes/index.ts': 'export {};',
      '/app/src/routes/orders.routes.ts': 'export {};',
    });

    expect(await readLegacyHttpFiles(fs, '/app')).toEqual(['index.ts', 'orders.routes.ts']);
  });

  it('reports nothing when the directory is absent', async () => {
    // The normal case: every project scaffolded since E8. A notice here would
    // fire on every generate in every healthy project.
    expect(await readLegacyHttpFiles(createFakeFs({}), '/app')).toEqual([]);
  });

  it('ignores non-TypeScript files', async () => {
    // A stray `.md` or an editor backup is not an unmigrated route module, and
    // reporting one would send the developer looking for work that is not there.
    const fs = createFakeFs({
      '/app/src/routes/NOTES.md': '#',
      '/app/src/routes/orders.routes.ts': 'export {};',
    });

    expect(await readLegacyHttpFiles(fs, '/app')).toEqual(['orders.routes.ts']);
  });

  it('sorts, so the notice does not reorder between runs', async () => {
    const fs = createFakeFs({
      '/app/src/routes/zeta.routes.ts': 'export {};',
      '/app/src/routes/alpha.routes.ts': 'export {};',
    });

    expect(await readLegacyHttpFiles(fs, '/app')).toEqual(['alpha.routes.ts', 'zeta.routes.ts']);
  });
});

describe('legacyLayoutNotice', () => {
  it('says nothing when there is nothing to migrate', () => {
    expect(legacyLayoutNotice([])).toEqual([]);
  });

  it('names the files, the consequence, and the three steps that fix it', () => {
    // The consequence is the part that matters. Measured against a real scaffold:
    // `setu g route billing` printed two `created` lines and exited 0, leaving a
    // new `src/controllers/index.ts` that nothing imports beside the developer's
    // still-wired `src/routes/index.ts` — so the route was generated, reported as
    // created, and unreachable. A notice naming only the directory would not tell
    // the developer their new code does nothing.
    const lines = legacyLayoutNotice(['index.ts', 'orders.routes.ts']).join('\n');

    expect(lines).toContain(LEGACY_HTTP_DIR);
    expect(lines).toContain('orders.routes.ts');
    expect(lines).toContain('unreachable');
    expect(lines).toContain('src/controllers/index.ts');
    expect(lines).toContain('setu.config.ts');
  });

  it('reports the count so a large directory is not truncated silently', () => {
    expect(legacyLayoutNotice(['a.ts', 'b.ts', 'c.ts'])[0]).toContain('3 file(s)');
  });
});
