/**
 * A hand-written module in a seam directory (M70g — register rows X4-4 and F2).
 *
 * The seam scanner admits any file matching a family's suffix and exports, so a
 * developer's own `src/controllers/admin.routes.ts` — written and wired by hand from
 * `setu.config.ts` — was swept into the CLI-owned barrel by an UNRELATED
 * `setu generate route report`. Since M68 refuses a duplicate `METHOD path`, the
 * application then failed to boot, and the error named the developer's module and
 * their config: two files they had not touched, from a command that reported success.
 *
 * The unit tests cover the scanner's decision. This drives the whole command against a
 * real scaffold and BOOTS it, because "the application starts" is the property that
 * actually broke.
 *
 * @module
 */
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import { bootAndProbe, denoCheck, useWorkspacePackages } from '../fixtures/generated-project.ts';

const runtime = createDenoRuntimeServices();
const fs = runtime.fs as IFileSystem;

/** A routes module a developer wrote themselves, matching the family's convention. */
const HAND_WRITTEN = `import type { IRouterApi } from '@setu-ts/common';

export function registerAdminRoutes(router: IRouterApi): void {
  router.get('/admin', (ctx) => ctx.response.json({ from: 'hand-written' }));
}
`;

/** Requests both routes through the booted application. */
const PROBE = `import { createApp } from './setu.config.ts';

const app = createApp();
await app.start();
const read = async (path: string) => {
  const res = await app.fetch(new Request(\`http://localhost\${path}\`));
  return { status: res.status, body: await res.text() };
};
const result = {
  admin: await read('/admin'),
  report: await read('/report'),
};
console.log('__PROBE_RESULT__' + JSON.stringify(result));
await app.stop();
`;

describe('a hand-written module in a seam directory', () => {
  let root: string;
  const err: string[] = [];

  const run = (argv: readonly string[]) =>
    runCli(argv, {
      fs,
      cwd: root,
      now: () => runtime.now(),
      log: () => {},
      error: (m) => err.push(m),
    });

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: 'setu-adopt-' });
    err.length = 0;
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  it('stays hand-wired, and the generated project still boots and serves both', async () => {
    expect(await run(['new', 'shop'])).toBe(0);
    const project = `${root}/shop`;

    // The developer's own module, registered from their own config — the exact
    // arrangement X4-4 reported.
    await Deno.writeTextFile(`${project}/src/controllers/admin.routes.ts`, HAND_WRITTEN);
    const config = await Deno.readTextFile(`${project}/setu.config.ts`);
    await Deno.writeTextFile(
      `${project}/setu.config.ts`,
      config
        .replace(
          "import { registerGeneratedRoutes } from './src/controllers/index.ts';",
          "import { registerGeneratedRoutes } from './src/controllers/index.ts';\n" +
            "import { registerAdminRoutes } from './src/controllers/admin.routes.ts';",
        )
        .replace(
          'registerGeneratedRoutes(app.router, app.services);',
          'registerGeneratedRoutes(app.router, app.services);\n  registerAdminRoutes(app.router);',
        ),
    );

    // An UNRELATED generate. This is what used to claim the file.
    expect(await run(['g', 'route', 'report', '--dir', project])).toBe(0);

    const barrel = await Deno.readTextFile(`${project}/src/controllers/index.ts`);
    expect(barrel).toContain('registerReportRoutes');
    expect(barrel).not.toContain('registerAdminRoutes');
    const report = err.join('\n');
    expect(report).toContain('src/controllers/admin.routes.ts');
    expect(report).toContain('setu.config.ts');

    await useWorkspacePackages(project);
    const checked = await denoCheck(project, [`${project}/setu.config.ts`]);
    expect(checked.code).toBe(0);

    const result = await bootAndProbe(project, PROBE);
    // Both are reachable: the developer's registration still runs, and the generated
    // one is registered exactly once.
    expect(result['admin']).toEqual({ status: 200, body: '{"from":"hand-written"}' });
    expect(result['report']).toEqual({ status: 200, body: '{"items":[]}' });
  });
});
