/**
 * Unit tests for generated-artifact discovery.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem, StatResult } from '@setu-ts/common';

import { readArtifactNames, scanArtifacts } from '../../../src/utils/artifact-scanner.ts';
import { listSeamSpecs } from '../../../src/seams/registry.ts';
import type { SeamSpec } from '../../../src/seams/seam-spec.ts';
import { seamSpecFor } from '../schematics/_shared.ts';
import { deriveNames } from '../../../src/utils/names.ts';

/** A file stat, shaped as the real runtime adapters report one. */
const FILE_STAT: StatResult = { isFile: true, isDirectory: false, size: 12 };
/** A directory stat. */
const DIR_STAT: StatResult = { isFile: false, isDirectory: true, size: 0 };
/** A stat rejection shaped like a real runtime's missing-path error. */
const MISSING = new Error('NotFound');

const ROUTES = seamSpecFor('route')!;
const PLUGINS = seamSpecFor('plugin')!;
const MIDDLEWARE = seamSpecFor('middleware')!;

/**
 * Source text that exports everything a spec's barrel imports from one artifact.
 *
 * The double has to honor the REAL contract the scanner reads — the file's EXPORTS, not
 * just its name — or every test here passes against a scanner that never checks them,
 * which is exactly how the upgrade defect shipped.
 *
 * @param spec - The family the artifact belongs to
 * @param name - The artifact's kebab name
 * @returns Source declaring each required export
 */
function wellFormed(spec: SeamSpec, name: string): string {
  return spec.importSymbols(deriveNames(name))
    .map((symbol) => `export const ${symbol} = 1;`)
    .join('\n');
}

/**
 * Builds a filesystem double over one directory listing, a stat map, and a source map.
 *
 * @param entries - What `readdir` returns, or an error to reject with
 * @param options - Per-entry stat and source overrides
 * @returns The double, satisfying the required members of IFileSystem
 */
function fsWith(
  entries: readonly string[] | Error,
  options: {
    readonly stats?: Readonly<Record<string, StatResult | Error>>;
    readonly sources?: Readonly<Record<string, string | Error>>;
    readonly spec?: SeamSpec;
  } = {},
): IFileSystem {
  const { stats = {}, sources = {}, spec = ROUTES } = options;
  return {
    readdir: () => entries instanceof Error ? Promise.reject(entries) : Promise.resolve(entries),
    stat: (path: string) => {
      const entry = path.slice(path.lastIndexOf('/') + 1);
      const result = stats[entry];
      if (result !== undefined) {
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      }
      return Promise.resolve(FILE_STAT);
    },
    readFile: (path: string) => {
      const entry = path.slice(path.lastIndexOf('/') + 1);
      const override = sources[entry];
      if (override instanceof Error) return Promise.reject(override);
      const name = entry.endsWith(spec.suffix) ? entry.slice(0, -spec.suffix.length) : entry;
      const source = override ?? wellFormed(spec, name);
      return Promise.resolve(new TextEncoder().encode(source));
    },
    writeFile: () => Promise.reject(new Error('unused')),
    mkdir: () => Promise.reject(new Error('unused')),
    rm: () => Promise.reject(new Error('unused')),
  };
}

describe('readArtifactNames', () => {
  it('returns names sorted, with the suffix stripped', async () => {
    // Enumeration order is filesystem-defined; the sort is what makes the regenerated
    // barrel byte-identical between two machines holding the same artifacts.
    const scan = await readArtifactNames(
      fsWith(['user.routes.ts', 'billing.routes.ts', 'order.routes.ts']),
      '/app',
      ROUTES,
    );
    expect(scan.names).toEqual(['billing', 'order', 'user']);
    expect(scan.skipped).toEqual([]);
  });

  it('excludes an entry whose suffix does not match', async () => {
    const scan = await readArtifactNames(
      fsWith(['user.routes.ts', 'notes.md', 'helper.ts']),
      '/app',
      ROUTES,
    );
    expect(scan.names).toEqual(['user']);
  });

  // The barrel's own file ends in `.ts`, so a `.ts` suffix would admit it and the barrel
  // would import from itself. This is the case the `.plugin.ts` suffix exists for.
  it('excludes a hand-written module in a scanned directory', async () => {
    const scan = await readArtifactNames(
      fsWith(['user.plugin.ts', 'index.ts', 'notes.ts'], { spec: PLUGINS }),
      '/app',
      PLUGINS,
    );
    expect(scan.names).toEqual(['user']);
  });

  it('excludes a DIRECTORY whose name matches the suffix', async () => {
    // A directory cannot be imported, so admitting one would make the barrel name a
    // module that does not exist.
    const scan = await readArtifactNames(
      fsWith(['user.routes.ts', 'legacy.routes.ts'], {
        stats: { 'legacy.routes.ts': DIR_STAT },
      }),
      '/app',
      ROUTES,
    );
    expect(scan.names).toEqual(['user']);
    // Not a rejection: nothing is wrong with an unrelated directory.
    expect(scan.skipped).toEqual([]);
  });

  it('excludes a bare suffix, which would derive an empty symbol name', async () => {
    const scan = await readArtifactNames(
      fsWith(['.routes.ts', 'user.routes.ts']),
      '/app',
      ROUTES,
    );
    expect(scan.names).toEqual(['user']);
  });

  it('returns nothing when the directory does not exist', async () => {
    // The common case for a project that has never generated this family — not an error.
    const scan = await readArtifactNames(fsWith(MISSING), '/app', ROUTES);
    expect(scan.names).toEqual([]);
    expect(scan.skipped).toEqual([]);
  });

  it('skips one unreadable entry and keeps the rest', async () => {
    const scan = await readArtifactNames(
      fsWith(['user.routes.ts', 'gone.routes.ts'], {
        stats: { 'gone.routes.ts': MISSING },
      }),
      '/app',
      ROUTES,
    );
    expect(scan.names).toEqual(['user']);
    // Not reported: the filesystem moved under us, the artifact is not at fault.
    expect(scan.skipped).toEqual([]);
  });

  it('skips an entry whose source cannot be read', async () => {
    const scan = await readArtifactNames(
      fsWith(['user.routes.ts', 'locked.routes.ts'], {
        sources: { 'locked.routes.ts': new Error('EACCES') },
      }),
      '/app',
      ROUTES,
    );
    expect(scan.names).toEqual(['user']);
    expect(scan.skipped).toEqual([]);
  });

  // The regression that motivated the export check. `middleware` and `metric` each gained
  // a second export, so an artifact generated before that has the right FILENAME and the
  // wrong EXPORTS — and a barrel regenerated over it named a symbol the file did not
  // have, so `deno check` failed on a file the CLI had just reported creating.
  describe('the export check', () => {
    it('rejects an artifact missing a symbol the barrel would import', async () => {
      const scan = await readArtifactNames(
        fsWith(['audit-log.middleware.ts', 'request-id.middleware.ts'], {
          spec: MIDDLEWARE,
          // The pre-seam shape: the factory only, no priority constant.
          sources: {
            'audit-log.middleware.ts': 'export function auditLogMiddleware() {}',
          },
        }),
        '/app',
        MIDDLEWARE,
      );

      expect(scan.names).toEqual(['request-id']);
      expect(scan.skipped).toEqual([{
        path: 'src/middleware/audit-log.middleware.ts',
        missing: ['AUDIT_LOG_MIDDLEWARE_PRIORITY'],
      }]);
    });

    it('reports every missing symbol, not just the first', async () => {
      const scan = await readArtifactNames(
        fsWith(['orders.middleware.ts'], {
          spec: MIDDLEWARE,
          sources: { 'orders.middleware.ts': 'export const UNRELATED = 1;' },
        }),
        '/app',
        MIDDLEWARE,
      );

      expect(scan.skipped[0]?.missing).toEqual([
        'ORDERS_MIDDLEWARE_PRIORITY',
        'ordersMiddleware',
      ]);
    });

    it('reports a project-relative path, which is what a message should name', async () => {
      const scan = await readArtifactNames(
        fsWith(['user.routes.ts'], { sources: { 'user.routes.ts': 'export const X = 1;' } }),
        '/some/deep/project',
        ROUTES,
      );
      expect(scan.skipped[0]?.path).toBe('src/controllers/user.routes.ts');
    });

    it('accepts the named-re-export form as well as a declaration', async () => {
      const scan = await readArtifactNames(
        fsWith(['user.routes.ts'], {
          sources: {
            'user.routes.ts': 'function impl() {}\nexport { impl as registerUserRoutes };',
          },
        }),
        '/app',
        ROUTES,
      );
      expect(scan.names).toEqual(['user']);
    });

    it('does not mistake a mere mention for an export', async () => {
      // A doc comment or a call naming the symbol must not admit the file — that would put
      // an unresolvable import in the developer's barrel.
      const scan = await readArtifactNames(
        fsWith(['user.routes.ts'], {
          sources: { 'user.routes.ts': '// see registerUserRoutes\nregisterUserRoutes();' },
        }),
        '/app',
        ROUTES,
      );
      expect(scan.names).toEqual([]);
      expect(scan.skipped[0]?.missing).toEqual(['registerUserRoutes']);
    });
  });
});

describe('scanArtifacts', () => {
  it('keys every wired family, even the ones with no artifacts', async () => {
    const scan = await scanArtifacts(fsWith(MISSING), '/app', listSeamSpecs());
    expect(Object.keys(scan.artifacts).sort()).toEqual(
      listSeamSpecs().map((s) => s.schematic).sort(),
    );
    for (const names of Object.values(scan.artifacts)) expect(names).toEqual([]);
    expect(scan.skipped).toEqual([]);
  });

  // `command-handler` and `query-handler` share `src/cqrs/`, so they are told apart by
  // suffix rather than by location — a scan keyed on directory would merge them.
  it('separates two families sharing one directory', async () => {
    const command = seamSpecFor('command-handler')!;
    const query = seamSpecFor('query-handler')!;
    const scan = await scanArtifacts(
      {
        ...fsWith(['a.command-handler.ts', 'b.query-handler.ts', 'index.ts']),
        readFile: (path: string) => {
          const entry = path.slice(path.lastIndexOf('/') + 1);
          const spec = entry.endsWith(command.suffix) ? command : query;
          const name = entry.slice(0, -spec.suffix.length);
          return Promise.resolve(new TextEncoder().encode(wellFormed(spec, name)));
        },
      },
      '/app',
      [command, query],
    );
    expect(scan.artifacts['command-handler']).toEqual(['a']);
    expect(scan.artifacts['query-handler']).toEqual(['b']);
  });

  it('aggregates rejections across families', async () => {
    const scan = await scanArtifacts(
      fsWith(['broken.routes.ts'], { sources: { 'broken.routes.ts': 'export const X = 1;' } }),
      '/app',
      [ROUTES],
    );
    expect(scan.skipped).toHaveLength(1);
    expect(scan.artifacts['route']).toEqual([]);
  });
});
