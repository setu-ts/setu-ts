/**
 * Command-level tests for the generated-artifact seams.
 *
 * The schematics are pure, so these cover what only the command layer decides: the
 * family scan, the managed-barrel exemption on a regenerate, the collision refusal, and
 * that `--dry-run` still writes nothing now that every generate plans two files.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runGenerateCommand } from '../../src/commands/generate.ts';

/** A Deno manifest declaring the given `@setu-ts` packages as installed. */
const manifest = (...packages: readonly string[]) =>
  JSON.stringify({
    imports: Object.fromEntries(
      packages.map((p) => [`@setu-ts/${p}`, `jsr:@setu-ts/${p}@^0.1.0-alpha.1`]),
    ),
  });

/** A project satisfying every gate the seams need. */
const WIRED = {
  '/app/deno.json': manifest(
    'decorator-plugin',
    'health-plugin',
    'metrics-plugin',
    'cqrs-plugin',
    'events-plugin',
  ),
};

interface Harness {
  readonly fs: FakeFs;
  readonly out: ReturnType<typeof createRecorder>;
  readonly err: ReturnType<typeof createRecorder>;
  run(argv: readonly string[]): Promise<number>;
}

function harness(seed: Readonly<Record<string, string>> = WIRED): Harness {
  const fs = createFakeFs(seed);
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (argv) =>
      runGenerateCommand(parseArgs(argv), {
        fs,
        cwd: '/app',
        now: () => Date.UTC(2026, 6, 28, 12, 30, 45),
        log: out.sink,
        error: err.sink,
      }),
  };
}

describe('setu generate, with seams', () => {
  it('writes the artifact and its barrel, and reads both back', async () => {
    const h = harness();

    expect(await h.run(['health-indicator', 'external-api'])).toBe(0);

    expect(h.fs.writes).toEqual([
      '/app/src/health/external-api.indicator.ts',
      '/app/src/health/index.ts',
    ]);
    expect(h.fs.read('/app/src/health/index.ts')).toContain('new ExternalApiHealthIndicator()');
  });

  it('lists an artifact the scan found alongside the new one', async () => {
    // The whole point of the scan: the barrel is regenerated from the directory, so an
    // artifact generated in an earlier invocation must survive the next one.
    const h = harness({
      ...WIRED,
      '/app/src/health/billing.indicator.ts': 'export class BillingHealthIndicator {}',
    });

    expect(await h.run(['health-indicator', 'external-api'])).toBe(0);

    const barrel = h.fs.read('/app/src/health/index.ts');
    expect(barrel).toContain('BillingHealthIndicator');
    expect(barrel).toContain('ExternalApiHealthIndicator');
  });

  it('rewrites the barrel rather than refusing on it', async () => {
    const h = harness();
    expect(await h.run(['health-indicator', 'billing'])).toBe(0);
    const errorsAfterFirst = h.err.lines.length;

    // Second generate: the barrel already exists on disk. The managed-file exemption is
    // what makes this exit 0 instead of refusing.
    expect(await h.run(['health-indicator', 'external-api'])).toBe(0);
    expect(h.err.lines.length).toBe(errorsAfterFirst);
    expect(h.fs.read('/app/src/health/index.ts')).toContain('BillingHealthIndicator');
  });

  it('still refuses on the artifact itself, and then writes nothing', async () => {
    const h = harness();
    expect(await h.run(['health-indicator', 'billing'])).toBe(0);
    const before = h.fs.read('/app/src/health/index.ts');
    const writesAfterFirst = [...h.fs.writes];

    expect(await h.run(['health-indicator', 'billing'])).toBe(1);

    expect(h.err.lines.join('\n')).toContain('billing.indicator.ts');
    // Check-all-then-write-all: the barrel is not touched either.
    expect([...h.fs.writes]).toEqual(writesAfterFirst);
    expect(h.fs.read('/app/src/health/index.ts')).toBe(before);
  });

  it('prints both planned paths under --dry-run and writes neither', async () => {
    const h = harness();

    expect(await h.run(['health-indicator', 'external-api', '--dry-run'])).toBe(0);

    expect(h.out.lines).toEqual([
      'would create /app/src/health/external-api.indicator.ts',
      'would create /app/src/health/index.ts',
    ]);
    expect(h.fs.writes).toEqual([]);
  });

  // The upgrade path. `middleware` gained a second export in M60, so an artifact
  // generated earlier has the right filename and the wrong exports. Before the scanner
  // checked exports, the regenerated barrel named a constant that file did not have and
  // the project stopped compiling — from a command that reported success.
  describe("an artifact predating its family's second export", () => {
    const PRE_M60 = {
      ...WIRED,
      '/app/src/middleware/audit-log.middleware.ts':
        'export function auditLogMiddleware() { return async () => {}; }',
    };

    it('leaves it out of the barrel instead of emitting an unresolvable import', async () => {
      const h = harness(PRE_M60);

      expect(await h.run(['middleware', 'request-id'])).toBe(0);

      const barrel = h.fs.read('/app/src/middleware/index.ts');
      expect(barrel).toContain('REQUEST_ID_MIDDLEWARE_PRIORITY');
      // The symbol the old file does not export must not appear at all.
      expect(barrel).not.toContain('AUDIT_LOG_MIDDLEWARE_PRIORITY');
      expect(barrel).not.toContain('audit-log.middleware.ts');
    });

    it('says so, rather than dropping it silently', async () => {
      // A silent omission would leave the artifact unwired with no diagnostic, which is
      // the failure this whole milestone exists to end.
      const h = harness(PRE_M60);

      expect(await h.run(['middleware', 'request-id'])).toBe(0);

      const reported = h.err.lines.join('\n');
      expect(reported).toContain('src/middleware/audit-log.middleware.ts');
      expect(reported).toContain('AUDIT_LOG_MIDDLEWARE_PRIORITY');
      expect(reported).toContain('Regenerate it');
    });

    it('still exits 0, because the generate itself succeeded', async () => {
      const h = harness(PRE_M60);
      expect(await h.run(['middleware', 'request-id'])).toBe(0);
      expect(h.fs.writes).toContain('/app/src/middleware/request-id.middleware.ts');
    });

    it('admits it again once it is regenerated', async () => {
      const h = harness(PRE_M60);
      // Regenerating is refused on the artifact itself (it exists), so the developer
      // deletes and regenerates — modelled here by replacing the stale source.
      await h.run(['middleware', 'request-id']);
      await h.fs.writeFile(
        '/app/src/middleware/audit-log.middleware.ts',
        new TextEncoder().encode(
          'export const AUDIT_LOG_MIDDLEWARE_PRIORITY = 500;\n' +
            'export function auditLogMiddleware() { return async () => {}; }',
        ),
      );

      expect(await h.run(['middleware', 'another'])).toBe(0);
      expect(h.fs.read('/app/src/middleware/index.ts')).toContain(
        'AUDIT_LOG_MIDDLEWARE_PRIORITY',
      );
    });
  });

  it('survives an unreadable family directory', async () => {
    // `readdir` throws for every family in a fresh project; a generate must still work.
    const h = harness();
    expect(await h.run(['metric', 'orders-placed'])).toBe(0);
    expect(h.fs.read('/app/src/metrics/index.ts')).toContain('ORDERS_PLACED_METRIC');
  });

  it('roots the scan at --dir, so scan and write cannot disagree', async () => {
    const fs = createFakeFs({
      '/other/deno.json': manifest('decorator-plugin', 'health-plugin'),
      '/other/src/health/billing.indicator.ts': 'export class BillingHealthIndicator {}',
      // Same-named artifact under the CWD, which must be invisible.
      '/app/src/health/ignored.indicator.ts': 'export class IgnoredHealthIndicator {}',
    });
    const err = createRecorder();
    const code = await runGenerateCommand(
      parseArgs(['health-indicator', 'external-api', '--dir', '/other']),
      { fs, cwd: '/app', now: () => 0, log: createRecorder().sink, error: err.sink },
    );

    expect(code).toBe(0);
    const barrel = fs.read('/other/src/health/index.ts');
    expect(barrel).toContain('BillingHealthIndicator');
    expect(barrel).not.toContain('IgnoredHealthIndicator');
  });

  describe('the collision refusal', () => {
    it('refuses a service whose token a module already claims, and writes nothing', async () => {
      const h = harness({
        ...WIRED,
        '/app/src/modules/widget/widget.controller.ts': 'export class WidgetController {}',
        '/app/src/modules/widget/widget.service.ts': 'export class WidgetService {}',
      });

      expect(await h.run(['service', 'widget'])).toBe(1);

      expect(h.err.lines.join('\n')).toContain("the injection token 'widget-service'");
      expect(h.err.lines.join('\n')).toContain('module of the same name');
      expect(h.fs.writes).toEqual([]);
    });

    it('refuses a route whose path a controller already mounts', async () => {
      const h = harness({
        ...WIRED,
        '/app/src/controllers/widget.controller.ts': 'export class WidgetController {}',
      });

      expect(await h.run(['route', 'widget'])).toBe(1);

      expect(h.err.lines.join('\n')).toContain('the HTTP path /widget');
      expect(h.fs.writes).toEqual([]);
    });

    it('refuses before printing a --dry-run plan', async () => {
      // A plan whose output cannot work is not a plan worth printing.
      const h = harness({
        ...WIRED,
        '/app/src/controllers/widget.controller.ts': 'export class WidgetController {}',
      });

      expect(await h.run(['route', 'widget', '--dry-run'])).toBe(1);

      expect(h.out.lines).toEqual([]);
    });

    it('allows the same names in a project without decorator-plugin', async () => {
      // Neither collision can exist there: the service emits no token, and `controller`
      // and `module` are refused by their own gates.
      const h = harness({
        '/app/deno.json': manifest('health-plugin'),
        '/app/src/modules/widget/widget.controller.ts': 'export class WidgetController {}',
        '/app/src/modules/widget/widget.service.ts': 'export class WidgetService {}',
      });

      expect(await h.run(['service', 'widget'])).toBe(0);
      // And no barrel, because the seam is conditional on the same plugin.
      expect(h.fs.writes).toEqual(['/app/src/services/widget.service.ts']);
    });
  });
});
