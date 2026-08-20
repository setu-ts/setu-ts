/**
 * Adoption reporting and the manual-wiring skip (M70g — register rows X4-4 and F2).
 *
 * The scanner admits any file matching a family's suffix and exports, so a
 * hand-written module in a seam directory becomes the CLI's on the next unrelated
 * `setu generate`. Since M68 refuses a duplicate `METHOD path`, an adopted file that
 * the project ALSO registers by hand stops the application booting — and the error
 * names the developer's file and `setu.config.ts`, neither of which they touched.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem, StatResult } from '@setu-ts/common';

import { readArtifactNames, scanArtifacts } from '../../../src/utils/artifact-scanner.ts';
import { FUNCTIONAL_ROUTES_SEAM } from '../../../src/seams/http.ts';

const FILE_STAT: StatResult = { isFile: true, isDirectory: false, size: 12 };
const ROUTES = FUNCTIONAL_ROUTES_SEAM;

/**
 * A filesystem double over an explicit path → contents map.
 *
 * Explicit rather than generated, because the two signals under test are the CONTENTS
 * of two specific files — the barrel and `setu.config.ts` — and a double that answers
 * every read with well-formed source cannot tell them apart.
 *
 * @param entries - What `readdir` returns for the seam directory
 * @param files - Path (relative to the project root) → source text
 * @returns The double, satisfying the required members of IFileSystem
 */
function fsWith(
  entries: readonly string[],
  files: Readonly<Record<string, string>>,
): IFileSystem {
  const relative = (path: string): string => path.replace(/^\/app\//, '');
  return {
    readdir: () => Promise.resolve(entries),
    stat: () => Promise.resolve(FILE_STAT),
    readFile: (path: string) => {
      const source = files[relative(path)];
      if (source === undefined) return Promise.reject(new Error('NotFound'));
      return Promise.resolve(new TextEncoder().encode(source));
    },
    writeFile: () => Promise.reject(new Error('unused')),
    mkdir: () => Promise.reject(new Error('unused')),
    rm: () => Promise.reject(new Error('unused')),
  };
}

/** A module exporting exactly what the routes barrel imports from it. */
const adminModule = 'export function registerAdminRoutes(): void {}';
const reportModule = 'export function registerReportRoutes(): void {}';

/** A barrel already naming one artifact — what an earlier `generate` wrote. */
const barrelNaming = (symbols: readonly string[]): string =>
  symbols.map((s) => `import { ${s} } from './x.routes.ts';`).join('\n');

describe('artifact adoption', () => {
  it('reports a file the existing barrel does not already name', async () => {
    const scan = await readArtifactNames(
      fsWith(['admin.routes.ts'], {
        'src/controllers/admin.routes.ts': adminModule,
        'src/controllers/index.ts': barrelNaming(['registerReportRoutes']),
      }),
      '/app',
      ROUTES,
    );

    expect(scan.names).toEqual(['admin']);
    expect(scan.adopted).toEqual([
      { path: 'src/controllers/admin.routes.ts', barrel: 'src/controllers/index.ts' },
    ]);
  });

  it('stays quiet about a file the barrel already names', async () => {
    // The claim happened on some earlier run. Reporting it again on every generate
    // would make the diagnostic noise rather than news.
    const scan = await readArtifactNames(
      fsWith(['admin.routes.ts'], {
        'src/controllers/admin.routes.ts': adminModule,
        'src/controllers/index.ts': barrelNaming(['registerAdminRoutes']),
      }),
      '/app',
      ROUTES,
    );

    expect(scan.names).toEqual(['admin']);
    expect(scan.adopted).toEqual([]);
  });

  it('reports every artifact when no barrel exists yet', async () => {
    const scan = await readArtifactNames(
      fsWith(['admin.routes.ts'], { 'src/controllers/admin.routes.ts': adminModule }),
      '/app',
      ROUTES,
    );

    expect(scan.adopted.map((a) => a.path)).toEqual(['src/controllers/admin.routes.ts']);
  });
});

describe('manual-wiring skip', () => {
  it('leaves a hand-registered artifact out of the barrel and says why', async () => {
    // X4-4 exactly: `registerAdminRoutes(router)` called from `setu.config.ts`, then
    // an unrelated `setu generate route report` adopts the file and the app stops
    // booting with `Route 'GET /login' is already registered`.
    const scan = await readArtifactNames(
      fsWith(['admin.routes.ts', 'report.routes.ts'], {
        'src/controllers/admin.routes.ts': adminModule,
        'src/controllers/report.routes.ts': reportModule,
      }),
      '/app',
      ROUTES,
      {
        path: 'setu.config.ts',
        source: "import { registerAdminRoutes } from './src/controllers/admin.routes.ts';\n" +
          'registerAdminRoutes(app.router);',
      },
    );

    expect(scan.names).toEqual(['report']);
    expect(scan.manual).toEqual([
      {
        path: 'src/controllers/admin.routes.ts',
        symbol: 'registerAdminRoutes',
        wiredIn: 'setu.config.ts',
      },
    ]);
  });

  it('does not fire on the aggregate export a generated project imports', async () => {
    // A scaffolded config imports `registerGeneratedRoutes`, never a per-artifact
    // symbol — which is exactly why the per-artifact symbol is a reliable signal.
    const scan = await readArtifactNames(
      fsWith(['admin.routes.ts'], { 'src/controllers/admin.routes.ts': adminModule }),
      '/app',
      ROUTES,
      {
        path: 'setu.config.ts',
        source: "import { registerGeneratedRoutes } from './src/controllers/index.ts';",
      },
    );

    expect(scan.names).toEqual(['admin']);
    expect(scan.manual).toEqual([]);
  });

  it('matches whole identifiers only', async () => {
    const scan = await readArtifactNames(
      fsWith(['admin.routes.ts'], { 'src/controllers/admin.routes.ts': adminModule }),
      '/app',
      ROUTES,
      { path: 'setu.config.ts', source: 'registerAdminRoutesLegacy(app.router);' },
    );

    expect(scan.names).toEqual(['admin']);
    expect(scan.manual).toEqual([]);
  });
});

describe('scanArtifacts aggregation', () => {
  it('reads the wiring module once and aggregates both new lists', async () => {
    let configReads = 0;
    const base = fsWith(['admin.routes.ts'], {
      'src/controllers/admin.routes.ts': adminModule,
      'setu.config.ts': 'registerAdminRoutes(app.router);',
    });
    const fs: IFileSystem = {
      ...base,
      readFile: (path: string) => {
        if (path.endsWith('setu.config.ts')) configReads++;
        return base.readFile(path);
      },
    };

    const scan = await scanArtifacts(fs, '/app', [ROUTES, ROUTES]);

    expect(configReads).toBe(1);
    expect(scan.manual).toHaveLength(2);
    expect(scan.adopted).toEqual([]);
  });
});
