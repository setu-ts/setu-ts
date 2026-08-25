/**
 * Tests for the API documentation generation script.
 *
 * This test suite covers:
 * - Manifest expansion (string and object exports)
 * - Published package parity
 * - Workspace/publish mismatch detection
 * - Target sorting and deduplication
 * - deno doc argument building for both modes
 * - Check mode must pass the COMPLETE target set, never a subset
 * - Stale output removal
 * - Child process exit code propagation
 * - Ratchet diagnostics parsing and partitioning
 * - Path normalization for absolute and relative paths
 * - ANSI stripping for both stdout and stderr
 * - Fatal classification from both streams
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  buildDenoDocArgs,
  classifyChildResult,
  CLEAN_PACKAGES,
  collectApiEntrypoints,
  DOC_LINT_BASELINE,
  DOC_LINT_EXIT_CODE,
  expandExportTargets,
  normalizeDiagnosticPath,
  parseDocLintDiagnostics,
  partitionDiagnostics,
  readManifestExports,
  runApiDocs,
} from '../scripts/generate-api-docs.ts';
import { PUBLISHED_PACKAGES } from '../scripts/release-packages.ts';

describe('API Documentation Generation', () => {
  describe('expandExportTargets', () => {
    it('expands a string export to a single target', () => {
      const result = expandExportTargets('./src/index.ts');
      expect(result).toEqual(['./src/index.ts']);
    });

    it('expands an object export map with root and subpaths', () => {
      const exports = {
        '.': './src/index.ts',
        './worker': './src/worker/define-worker-task.ts',
      };
      const result = expandExportTargets(exports);
      expect(result).toEqual([
        './src/index.ts',
        './src/worker/define-worker-task.ts',
      ]);
    });

    it('handles mixed string and object exports', () => {
      const exports = {
        '.': './src/index.ts',
        './main': './src/main.ts',
      };
      const result = expandExportTargets(exports);
      expect(result).toContain('./src/index.ts');
      expect(result).toContain('./src/main.ts');
    });

    it('deduplicates and sorts targets', () => {
      const exports = {
        '.': './src/index.ts',
        './worker': './src/index.ts', // duplicate
      };
      const result = expandExportTargets(exports);
      expect(result).toHaveLength(1);
      expect(result).toEqual(['./src/index.ts']);
    });

    it('handles null/undefined exports gracefully', () => {
      expect(expandExportTargets(null)).toEqual([]);
      expect(expandExportTargets(undefined)).toEqual([]);
    });
  });

  describe('normalizeDiagnosticPath', () => {
    it('normalizes a relative path', () => {
      expect(normalizeDiagnosticPath('packages/common/src/index.ts')).toBe(
        'packages/common/src/index.ts',
      );
    });

    it('strips leading ./ from relative paths', () => {
      expect(normalizeDiagnosticPath('./packages/common/src/index.ts')).toBe(
        'packages/common/src/index.ts',
      );
    });

    it('extracts repo-relative portion from absolute paths', () => {
      expect(
        normalizeDiagnosticPath(
          '/home/user/project/packages/common/src/index.ts',
        ),
      ).toBe(
        'packages/common/src/index.ts',
      );
    });

    it('handles starter paths', () => {
      expect(
        normalizeDiagnosticPath('packages/starters/rest-starter/src/index.ts'),
      ).toBe(
        'packages/starters/rest-starter/src/index.ts',
      );
    });
  });

  describe('buildDenoDocArgs', () => {
    it('builds generate mode arguments correctly', () => {
      const targets = ['packages/common/src/index.ts'];
      const args = buildDenoDocArgs(targets, 'generate', 'docs/api');

      expect(args).toContain('doc');
      expect(args).toContain('--html');
      expect(args).toContain('--output=docs/api');
      expect(args).toContain('--name=Setu-TS');
      expect(args).toContain('packages/common/src/index.ts');
    });

    it('builds check mode arguments correctly', () => {
      const targets = ['packages/common/src/index.ts'];
      const args = buildDenoDocArgs(targets, 'check', 'docs/api');

      expect(args).toContain('doc');
      expect(args).toContain('--lint');
      expect(args).toContain('packages/common/src/index.ts');
      expect(args).not.toContain('--html');
      expect(args).not.toContain('--output');
    });

    it('includes the COMPLETE target set in check mode, never a subset', () => {
      const targets = [
        'packages/common/src/index.ts',
        'packages/kernel/src/index.ts',
        'packages/runtime/src/index.ts',
      ];
      const args = buildDenoDocArgs(targets, 'check', 'docs/api');

      // Verify all targets are included
      for (const target of targets) {
        expect(args).toContain(target);
      }

      // Verify no filtering to CLEAN_PACKAGES happens
      expect(args.join(' ')).not.toMatch(/CLEAN_PACKAGES|filter|subset/);
    });
  });

  describe('parseDocLintDiagnostics', () => {
    it('parses plain text diagnostics with path on separate line', () => {
      const output = `error[missing-jsdoc]: exported symbol is missing JSDoc documentation
  --> packages/common/src/index.ts:10:0
error[private-type-ref]: public type references private type
  --> packages/kernel/src/index.ts:20:5`;

      const diagnostics = parseDocLintDiagnostics(output);

      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[0]).toMatchObject({
        rule: 'missing-jsdoc',
        path: 'packages/common/src/index.ts',
        line: 10,
      });
      expect(diagnostics[1]).toMatchObject({
        rule: 'private-type-ref',
        path: 'packages/kernel/src/index.ts',
        line: 20,
      });
    });

    it('parses ANSI-coloured diagnostics', () => {
      const output =
        '\u001b[0m\u001b[1m\u001b[31merror[missing-jsdoc]: exported symbol is missing JSDoc documentation\u001b[0m\n' +
        '  \u001b[0m\u001b[36m-->\u001b[0m \u001b[36mpackages/common/src/index.ts\u001b[0m\u001b[33m:10:0\u001b[0m';

      const diagnostics = parseDocLintDiagnostics(output);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        rule: 'missing-jsdoc',
        path: 'packages/common/src/index.ts',
        line: 10,
      });
    });

    it('handles multi-line diagnostic format', () => {
      const output = `error[missing-jsdoc]: exported symbol is missing JSDoc documentation
  --> packages/common/src/index.ts:10:0`;

      const diagnostics = parseDocLintDiagnostics(output);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        rule: 'missing-jsdoc',
        path: 'packages/common/src/index.ts',
        line: 10,
      });
    });

    it('strips ANSI from both stdout and stderr for fatal detection', () => {
      // ANSI-colored fatal error on stderr
      const stderr = '\u001b[31merror: Module not found\u001b[0m\n';
      const diagnostics = parseDocLintDiagnostics(stderr);
      expect(diagnostics).toHaveLength(0);
    });
  });

  describe('partitionDiagnostics', () => {
    it('fails on clean package findings', () => {
      const diagnostics = [
        {
          rule: 'missing-jsdoc',
          path: 'packages/common/src/index.ts',
          line: 10,
          message: 'test',
        },
      ];

      const { cleanPackageFindings, knownDebt } = partitionDiagnostics(
        diagnostics,
      );

      expect(cleanPackageFindings).toHaveLength(1);
      expect(knownDebt).toHaveLength(0);
    });

    it('passes identical finding in non-clean package', () => {
      const diagnostics = [
        {
          rule: 'missing-jsdoc',
          path: 'packages/queue-plugin/src/index.ts',
          line: 10,
          message: 'test',
        },
      ];

      const { cleanPackageFindings, knownDebt } = partitionDiagnostics(
        diagnostics,
      );

      expect(cleanPackageFindings).toHaveLength(0);
      expect(knownDebt).toHaveLength(1);
    });

    it('correctly handles starters under packages/starters/<name>/', () => {
      const diagnostics = [
        {
          rule: 'missing-jsdoc',
          path: 'packages/starters/rest-starter/src/index.ts',
          line: 10,
          message: 'test',
        },
      ];

      const { cleanPackageFindings, knownDebt } = partitionDiagnostics(
        diagnostics,
      );

      // rest-starter is in CLEAN_PACKAGES
      expect(cleanPackageFindings).toHaveLength(1);
      expect(knownDebt).toHaveLength(0);
    });

    it('failing diagnostic in clean package vs non-clean package', () => {
      const cleanDiag = {
        rule: 'missing-jsdoc',
        path: 'packages/common/src/index.ts',
        line: 10,
        message: 'test',
      };
      const nonCleanDiag = {
        rule: 'missing-jsdoc',
        path: 'packages/messaging-plugin/src/index.ts',
        line: 10,
        message: 'test',
      };

      const cleanResult = partitionDiagnostics([cleanDiag]);
      const nonCleanResult = partitionDiagnostics([nonCleanDiag]);

      // Same finding, different packages
      expect(cleanResult.cleanPackageFindings).toHaveLength(1);
      expect(nonCleanResult.cleanPackageFindings).toHaveLength(0);
    });

    it('normalizes absolute paths correctly', () => {
      const diagnostics = [
        {
          rule: 'missing-jsdoc',
          path: '/home/user/project/packages/common/src/index.ts',
          line: 10,
          message: 'test',
        },
      ];

      const { cleanPackageFindings, knownDebt } = partitionDiagnostics(
        diagnostics,
      );

      // Should still be recognized as common package
      expect(cleanPackageFindings).toHaveLength(1);
      expect(knownDebt).toHaveLength(0);
    });

    it('normalizes paths with leading ./', () => {
      const diagnostics = [
        {
          rule: 'missing-jsdoc',
          path: './packages/kernel/src/index.ts',
          line: 10,
          message: 'test',
        },
      ];

      const { cleanPackageFindings, knownDebt } = partitionDiagnostics(
        diagnostics,
      );

      // Should still be recognized as kernel package
      expect(cleanPackageFindings).toHaveLength(1);
      expect(knownDebt).toHaveLength(0);
    });
  });

  describe('CLEAN_PACKAGES constant', () => {
    it('contains exactly the ten measured clean packages', () => {
      expect(CLEAN_PACKAGES).toEqual(
        new Set([
          'common',
          'config-plugin',
          'cqrs-plugin',
          'exceptions',
          'http-security-plugin',
          'kernel',
          'scheduler-plugin',
          'full-stack-starter',
          'microservice-starter',
          'rest-starter',
        ]),
      );
    });
  });

  describe('DOC_LINT_BASELINE constant', () => {
    it('is the frozen baseline of 752', () => {
      // 776 when the plan was written against a pre-M56 tree; merging
      // origin/main brought M56-M61's JSDoc and the real count fell to 775.
      // M59 then added four diagnostics and removed five, so it fell to 774.
      // M67's newly public starter option added one diagnostic, so the ratchet
      // recorded the measured 775 rather than concealing the increase.
      // M70i (X6-3) widened the GraphQL structural facades to accept the real
      // `graphql` package, replacing a number of `missing-jsdoc` /
      // `private-type-ref` diagnostics on the old narrow facade members with
      // documented, `unknown`-typed ones — the real count fell to 764.
      // M70i's fix pass then completed the plan's gRPC + GraphQL deliverables:
      // the new modules and widened members replaced four further diagnostics,
      // and the ratchet recorded the measured 760.
      // M70n (X4-7) exported StoredAuditEntry/AuditQuery from the audit barrel,
      // making fifteen interface members newly reachable; documenting them plus
      // re-exporting the handlers' referenced types cleared sixteen more — the
      // ratchet recorded the measured 752.
      // M72 added the `Prompter`/`PromptChoice` exports and held the line at
      // 752: `Prompter.select` initially carried no JSDoc of its own (the
      // block sat on the interface, so its @param/@returns described a member
      // deno_doc never saw), which the ratchet caught as one `missing-jsdoc`.
      // Documenting the member cleared it rather than raising the constant.
      // The ratchet refused the stale constant in BOTH directions and named
      // the new number, which is exactly the behaviour §3.10 specifies.
      expect(DOC_LINT_BASELINE).toBe(752);
    });
  });

  describe('collectApiEntrypoints', () => {
    it('returns workspace-relative targets with package prefixes', async () => {
      const fs = {
        readTextFile: async (path: string) => await Deno.readTextFile(path),
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      const result = await collectApiEntrypoints(fs);
      // Every target must start with "packages/" — never bare "./src/..."
      for (const target of result.targets) {
        expect(target).toMatch(/^packages\//);
      }
    });

    it('includes runtime worker subpath target', async () => {
      const fs = {
        readTextFile: async (path: string) => await Deno.readTextFile(path),
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      const result = await collectApiEntrypoints(fs);
      expect(result.targets).toContain(
        'packages/runtime/src/worker/define-worker-task.ts',
      );
    });

    it('includes CLI main entrypoint', async () => {
      const fs = {
        readTextFile: async (path: string) => await Deno.readTextFile(path),
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      const result = await collectApiEntrypoints(fs);
      expect(result.targets).toContain('packages/cli/src/main.ts');
    });

    it('includes all three starter targets', async () => {
      const fs = {
        readTextFile: async (path: string) => await Deno.readTextFile(path),
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      const result = await collectApiEntrypoints(fs);
      expect(result.targets).toContain(
        'packages/starters/rest-starter/src/index.ts',
      );
      expect(result.targets).toContain(
        'packages/starters/microservice-starter/src/index.ts',
      );
      expect(result.targets).toContain(
        'packages/starters/full-stack-starter/src/index.ts',
      );
    });

    it('does not collapse to bare ./src/... paths', async () => {
      const fs = {
        readTextFile: async (path: string) => await Deno.readTextFile(path),
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      const result = await collectApiEntrypoints(fs);
      // No target should be a bare relative path without package prefix
      for (const target of result.targets) {
        expect(target.startsWith('./')).toBe(false);
      }
    });

    it('returns targets sorted and deduplicated', async () => {
      const fs = {
        readTextFile: async (path: string) => await Deno.readTextFile(path),
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      const result = await collectApiEntrypoints(fs);
      const sorted = [...result.targets].sort();
      expect(result.targets).toEqual(sorted);
      // No duplicates
      expect(result.targets).toHaveLength(
        new Set(result.targets).size,
      );
    });

    it('has the expected authoritative count of 49 targets', async () => {
      const fs = {
        readTextFile: async (path: string) => await Deno.readTextFile(path),
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      const result = await collectApiEntrypoints(fs);
      // 47 published packages, runtime has 2 exports (./src/index.ts + ./worker),
      // cli has 2 exports (./src/index.ts + ./main), rest have 1 each
      // = 47 + 1 (extra runtime) + 1 (extra cli) = 49
      expect(result.targets).toHaveLength(49);
    });

    it('maps each target to its correct package name', async () => {
      const fs = {
        readTextFile: async (path: string) => await Deno.readTextFile(path),
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      const result = await collectApiEntrypoints(fs);
      // Verify runtime worker maps to "runtime" pkg
      const runtimeWorker = result.targetsWithPackage.find(
        (e) => e.target === 'packages/runtime/src/worker/define-worker-task.ts',
      );
      expect(runtimeWorker?.pkg).toBe('runtime');
      // Verify CLI main maps to "cli" pkg
      const cliMain = result.targetsWithPackage.find(
        (e) => e.target === 'packages/cli/src/main.ts',
      );
      expect(cliMain?.pkg).toBe('cli');
      // Verify starter maps to starter name
      const restStarter = result.targetsWithPackage.find(
        (e) =>
          e.target ===
            'packages/starters/rest-starter/src/index.ts',
      );
      expect(restStarter?.pkg).toBe('rest-starter');
    });

    it('validates workspace parity: every published package has at least one target', async () => {
      const fs = {
        readTextFile: async (path: string) => await Deno.readTextFile(path),
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      const result = await collectApiEntrypoints(fs);
      // Every published package should appear in targetsWithPackage
      const publishedPkgs = new Set(
        PUBLISHED_PACKAGES.map((p) => {
          const match = p.match(
            /^packages\/([^/]+)(?:\/([^/]+))?/,
          );
          const first = match?.[1]!;
          const second = match?.[2];
          return first === 'starters' && second ? second : first;
        }),
      );
      const collectedPkgs = new Set(
        result.targetsWithPackage.map((e) => e.pkg),
      );
      for (const pkg of publishedPkgs) {
        expect(collectedPkgs.has(pkg!)).toBe(true);
      }
    });

    it('throws when a published package has an invalid export map (no exports field)', async () => {
      const { PUBLISHED_PACKAGES } = await import(
        '../scripts/release-packages.ts'
      );
      const fs = {
        readTextFile: (path: string) => {
          if (path === 'deno.json') {
            return Promise.resolve(
              JSON.stringify({ workspace: PUBLISHED_PACKAGES }),
            );
          }
          // All manifests return {} (no exports field) → invalid export map
          return Promise.resolve('{}');
        },
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      // {} has no exports field → invalid-export-map classification
      await expect(collectApiEntrypoints(fs)).rejects.toThrow(
        'invalid exports map',
      );
    });

    it('throws when a published package has no local export targets', async () => {
      const { PUBLISHED_PACKAGES } = await import(
        '../scripts/release-packages.ts'
      );
      const fs = {
        readTextFile: (path: string) => {
          if (path === 'deno.json') {
            return Promise.resolve(
              JSON.stringify({ workspace: PUBLISHED_PACKAGES }),
            );
          }
          // exports is an empty object → no-export-targets
          return Promise.resolve(JSON.stringify({ exports: {} }));
        },
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      await expect(collectApiEntrypoints(fs)).rejects.toThrow(
        'has no export targets in its deno.json manifest',
      );
    });

    it('repository-level: all targets exist on disk', async () => {
      const fs = {
        readTextFile: async (path: string) => await Deno.readTextFile(path),
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      const result = await collectApiEntrypoints(fs);
      for (const target of result.targets) {
        try {
          await Deno.stat(target);
        } catch {
          throw new Error(
            `Target does not exist on disk: ${target}`,
          );
        }
      }
    });
  });

  describe('runApiDocs — integrated check-mode discrimination', () => {
    function makeFs() {
      return {
        readTextFile: async (path: string) => await Deno.readTextFile(path),
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
        remove: (path: string, options?: { recursive: boolean }) => Deno.remove(path, options),
        mkdir: (path: string, options?: { recursive: boolean }) => Deno.mkdir(path, options),
      };
    }

    it('normal lint with exactly baseline diagnostics → success', async () => {
      const fs = makeFs();
      const diagnostics = Array.from(
        { length: DOC_LINT_BASELINE },
        (_, i) =>
          `error[missing-jsdoc]: diag ${i}
  --> packages/runtime/src/index.ts:${i + 1}:0`,
      ).join('\n');
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr: diagnostics }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(0);
      expect(result.findings).toHaveLength(0);
    });

    it('above baseline diagnostics → failure', async () => {
      const fs = makeFs();
      const diagnostics = Array.from(
        { length: DOC_LINT_BASELINE + 1 },
        (_, i) =>
          `error[missing-jsdoc]: diag ${i}
  --> packages/runtime/src/index.ts:${i + 1}:0`,
      ).join('\n');
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr: diagnostics }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('exceeds baseline'))).toBe(
        true,
      );
    });

    it('below baseline diagnostics → failure with lower-the-constant hint', async () => {
      const fs = makeFs();
      const diagnostics = `error[missing-jsdoc]: test
  --> packages/runtime/src/index.ts:1:0`;
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr: diagnostics }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('BELOW baseline'))).toBe(
        true,
      );
      expect(
        result.findings.some((f) => f.includes('Update DOC_LINT_BASELINE')),
      ).toBe(true);
    });

    it('fatal nonzero with zero parseable diagnostics → fatal failure surfacing original error', async () => {
      const fs = makeFs();
      const cmd = {
        run: () =>
          Promise.resolve({
            code: 1,
            stdout: '',
            stderr: 'error: Module not found\n',
          }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed')))
        .toBe(true);
      expect(result.findings.some((f) => f.includes('Module not found'))).toBe(
        true,
      );
      // Must NOT report "below baseline"
      expect(result.findings.some((f) => f.includes('BELOW baseline'))).toBe(
        false,
      );
    });

    it('fatal nonzero with partial parseable diagnostics plus fatal text → fatal failure', async () => {
      const fs = makeFs();
      const stderr = 'error: Module not found\n' +
        'error[missing-jsdoc]: test\n' +
        '  --> packages/runtime/src/index.ts:1:0\n';
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed')))
        .toBe(true);
      expect(result.findings.some((f) => f.includes('Module not found'))).toBe(
        true,
      );
    });

    it('fatal nonzero with exactly baseline-sized parseable diagnostics plus fatal text → fatal failure, never success', async () => {
      const fs = makeFs();
      const lintDiags = Array.from(
        { length: DOC_LINT_BASELINE },
        (_, i) =>
          `error[missing-jsdoc]: diag ${i}
  --> packages/runtime/src/index.ts:${i + 1}:0`,
      ).join('\n');
      const stderr = 'error: Module not found\n' + lintDiags;
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed')))
        .toBe(true);
      expect(result.findings.some((f) => f.includes('Module not found'))).toBe(
        true,
      );
      // Must NOT pass even though diagnostic count equals baseline
      expect(result.code).not.toBe(0);
    });

    it('generation-mode fatal failure remains propagated', async () => {
      // Use a mock fs that returns valid manifests for the generate-mode test
      // so collectApiEntrypoints succeeds and we can test cmd.run failure.
      const { PUBLISHED_PACKAGES } = await import(
        '../scripts/release-packages.ts'
      );
      const fs = {
        readTextFile: (path: string) => {
          if (path === 'deno.json') {
            return Promise.resolve(
              JSON.stringify({ workspace: PUBLISHED_PACKAGES }),
            );
          }
          // Return valid manifest for published packages
          return Promise.resolve(
            JSON.stringify({ exports: { '.': './src/index.ts' } }),
          );
        },
        readDir: async function* () {
          yield* [];
        },
        stat: () =>
          Promise.resolve(
            { isFile: true, isDirectory: false, size: 0 } as Deno.FileInfo,
          ),
        remove: (_path: string, _options?: { recursive: boolean }) => Promise.resolve(),
        mkdir: (_path: string, _options?: { recursive: boolean }) => Promise.resolve(),
      };
      const cmd = {
        run: () =>
          Promise.resolve({
            code: 2,
            stdout: '',
            stderr: 'fatal generation error\n',
          }),
      };
      const result = await runApiDocs(
        'generate',
        '/tmp/fake-api-docs',
        fs,
        cmd,
      );
      expect(result.code).toBe(2);
      expect(result.findings.some((f) => f.includes('deno doc failed'))).toBe(
        true,
      );
      expect(result.findings.some((f) => f.includes('fatal generation error')))
        .toBe(true);
    });

    it('clean-package finding in check mode → failure even without fatal text', async () => {
      const fs = makeFs();
      const stderr = 'error[missing-jsdoc]: test\n  --> packages/common/src/index.ts:1:0\n';
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('CLEAN packages'))).toBe(
        true,
      );
    });

    it('ANSI-colored fatal on stderr is detected', async () => {
      const fs = makeFs();
      const ansiFatal = '\u001b[31merror: Permission denied\u001b[0m\n';
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr: ansiFatal }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed')))
        .toBe(true);
      expect(result.findings.some((f) => f.includes('Permission denied'))).toBe(
        true,
      );
    });

    it('fatal text on stdout with clean stderr is detected', async () => {
      const fs = makeFs();
      const cmd = {
        run: () =>
          Promise.resolve({
            code: 1,
            stdout: 'error: Module not found: ./missing.ts\n',
            stderr: '',
          }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed')))
        .toBe(true);
      expect(result.findings.some((f) => f.includes('Module not found'))).toBe(
        true,
      );
    });

    it('warning format with non-1 exit is now fatal (fail-closed)', async () => {
      const fs = makeFs();
      // A warning that is not a recognized lint diagnostic or summary.
      // After removing recognized diagnostics and the exact known summary, every
      // non-whitespace residual must be fatal. This proves the gate fails closed.
      const output = 'warning: some non-fatal warning\n';
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: output, stderr: '' }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      // Must be treated as fatal — residual content with exit 1 fails closed
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed')))
        .toBe(true);
    });

    it('fatal mixed with zero parseable diagnostics fails', async () => {
      const fs = makeFs();
      const stderr = 'error: Fatal error\n';
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed')))
        .toBe(true);
      // Should NOT say "below baseline" since there's a fatal
      expect(result.findings.some((f) => f.includes('BELOW baseline'))).toBe(
        false,
      );
    });

    it('fatal mixed with partial diagnostics fails', async () => {
      const fs = makeFs();
      const stderr = 'error: Fatal error\n' +
        'error[missing-jsdoc]: some diag\n' +
        '  --> packages/runtime/src/index.ts:5:0\n';
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed')))
        .toBe(true);
      expect(result.findings.some((f) => f.includes('Fatal error'))).toBe(true);
    });

    it('fatal mixed with baseline-sized diagnostics still fails', async () => {
      const fs = makeFs();
      const lintDiags = Array.from(
        { length: DOC_LINT_BASELINE },
        (_, i) =>
          `error[missing-jsdoc]: diag ${i}
  --> packages/runtime/src/index.ts:${i + 1}:0`,
      ).join('\n');
      const stderr = 'error: Fatal error\n' + lintDiags;
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed')))
        .toBe(true);
      // Must NOT pass even though diagnostic count equals baseline
      expect(result.code).not.toBe(0);
    });

    // The two exact review failures: the prior global-summary suppression let a
    // fatal line coexist with a lint summary and pass. These reproduce both.
    it('REVIEW REPRO 1: code 2 + exactly 776 diagnostics → fatal, never success', async () => {
      const fs = makeFs();
      const diagnostics = Array.from(
        { length: DOC_LINT_BASELINE },
        (_, i) =>
          `error[missing-jsdoc]: diag ${i}
  --> packages/runtime/src/index.ts:${i + 1}:0`,
      ).join('\n');
      // Exit code 2 (not the documented lint exit code 1) → always fatal.
      const cmd = {
        run: () => Promise.resolve({ code: 2, stdout: '', stderr: diagnostics }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).not.toBe(0);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed')))
        .toBe(true);
    });

    it('REVIEW REPRO 2: code 2 + 776 diagnostics + fatal module-not-found + normal summary → fatal', async () => {
      const fs = makeFs();
      const diagnostics = Array.from(
        { length: DOC_LINT_BASELINE },
        (_, i) =>
          `error[missing-jsdoc]: diag ${i}
  --> packages/runtime/src/index.ts:${i + 1}:0`,
      ).join('\n');
      // A fatal module-not-found line AND the normal lint summary, with exit 2.
      // The prior suppression saw the summary, set isLintSummary=true, and let
      // the fatal pass. The structural classifier removes the recognized lint
      // records and rejects the residual `error: Module not found`.
      const stderr =
        `error: Module not found: ./missing.ts\n${diagnostics}\nFound ${DOC_LINT_BASELINE} documentation lint errors.`;
      const cmd = {
        run: () => Promise.resolve({ code: 2, stdout: '', stderr }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).not.toBe(0);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed')))
        .toBe(true);
      expect(result.findings.some((f) => f.includes('Module not found'))).toBe(
        true,
      );
      // Must NOT report "below baseline" — it is fatal, not lint debt.
      expect(result.findings.some((f) => f.includes('BELOW baseline'))).toBe(
        false,
      );
    });
  });

  describe('classifyChildResult — structural exit classification', () => {
    it('classifies the documented lint-debt exit (code 1, only diagnostics + summary) as lint-debt', () => {
      const stderr =
        `error[missing-jsdoc]: test\n  --> packages/runtime/src/index.ts:1:0\nFound 1 documentation lint errors.`;
      const result = classifyChildResult(DOC_LINT_EXIT_CODE, '', stderr);
      expect(result.kind).toBe('lint-debt');
    });

    it('classifies exit code 0 as immediate success', () => {
      const result = classifyChildResult(0, '', '');
      expect(result.kind).toBe('success');
    });

    it('requires a clean exit-code-0 child', () => {
      expect(classifyChildResult(0, 'unexpected output', '').kind).toBe(
        'fatal',
      );
      expect(classifyChildResult(0, '', 'unexpected stderr').kind).toBe(
        'fatal',
      );
    });

    it('rejects malformed diagnostic records and summary mismatches', () => {
      expect(
        classifyChildResult(1, '', 'error[missing-jsdoc]: missing location\n')
          .kind,
      ).toBe('fatal');
      expect(
        classifyChildResult(
          1,
          '',
          'error[missing-jsdoc]: one\n  --> packages/runtime/src/index.ts:1:1\n' +
            'error: Found 2 documentation lint errors.\n',
        ).kind,
      ).toBe('fatal');
    });

    for (
      const residual of [
        'plain residual',
        'info: unattached',
        '= hint: unattached',
        '- unattached reference',
        '  | unattached source',
        'prefix Found 1 documentation lint errors suffix',
        '  --> missing.ts:1:1',
      ]
    ) {
      it(`fails closed on unattached output: ${residual}`, () => {
        expect(classifyChildResult(1, '', residual).kind).toBe('fatal');
        expect(classifyChildResult(1, residual, '').kind).toBe('fatal');
      });
    }

    it('classifies exit code 2 as fatal regardless of content', () => {
      const result = classifyChildResult(
        2,
        '',
        'Found 5 documentation lint errors.',
      );
      expect(result.kind).toBe('fatal');
    });

    it('classifies exit code 1 with an independent fatal error as fatal', () => {
      const stderr = 'error: Module not found: ./missing.ts\n';
      const result = classifyChildResult(DOC_LINT_EXIT_CODE, '', stderr);
      expect(result.kind).toBe('fatal');
    });

    it('classifies exit code 1 with a fatal error plus lint diagnostics as fatal', () => {
      const stderr =
        'error: Module not found\nerror[missing-jsdoc]: test\n  --> packages/runtime/src/index.ts:1:0\n';
      const result = classifyChildResult(DOC_LINT_EXIT_CODE, '', stderr);
      expect(result.kind).toBe('fatal');
    });

    it('does NOT falsely fatal on a lint diagnostic whose message contains "error: "', () => {
      // A lint diagnostic opener is error[rule]: — even if its message text
      // contains "error: something", the opener line is removed before the
      // residual scan, so it is not falsely classified as fatal.
      const stderr =
        'error[missing-jsdoc]: error: this is part of the message\n  --> packages/runtime/src/index.ts:1:0\n';
      const result = classifyChildResult(DOC_LINT_EXIT_CODE, '', stderr);
      expect(result.kind).toBe('lint-debt');
    });

    it('detects a fatal on stdout when stderr is clean', () => {
      const stdout = 'error: Permission denied\n';
      const result = classifyChildResult(DOC_LINT_EXIT_CODE, stdout, '');
      expect(result.kind).toBe('fatal');
    });

    it('detects ANSI-coloured fatal text', () => {
      const stderr = '\u001b[31merror: Permission denied\u001b[0m\n';
      const result = classifyChildResult(DOC_LINT_EXIT_CODE, '', stderr);
      expect(result.kind).toBe('fatal');
    });

    it('detects a stack trace as fatal', () => {
      const stderr = 'error: something\n    at file:///foo.ts:10:5\n';
      const result = classifyChildResult(DOC_LINT_EXIT_CODE, '', stderr);
      expect(result.kind).toBe('fatal');
    });

    it('F3 regression: a stack trace with no "error: " literal is fatal via the stack-pattern branch', () => {
      // This residual contains NO `error: ` literal, so the unanchored
      // `/error: /` check does NOT fire. The stack frame is on the SECOND
      // line (not at position 0 of the residual), so a `STACK_TRACE_PATTERN`
      // without the `m` flag (whose `^` anchors to the start of the whole
      // string) would MISS it and misclassify as lint-debt. The `m` flag
      // makes `^` anchor to the start of each line, so the stack frame is
      // found and the result is fatal. This proves the stack-pattern branch
      // itself — not the `error: ` detector — causes the classification.
      const stderr = 'TypeError: foo\n    at file:///x.ts:10:5\n';
      const result = classifyChildResult(DOC_LINT_EXIT_CODE, '', stderr);
      expect(result.kind).toBe('fatal');
      // The actionable output is preserved (not converted to a baseline
      // message).
      expect(result.stderrStripped).toContain('TypeError: foo');
      expect(result.stderrStripped).toContain('at file:///x.ts:10:5');
      // No `error: ` marker is present, confirming the stack branch — not the
      // error-detector branch — classified this.
      expect(result.stderrStripped).not.toMatch(/^error: /m);
    });

    it('lint location lines ( --> file) are not confused with stack frames', () => {
      // A normal lint-debt residual contains only diagnostic openers (removed),
      // their ` --> ` location continuation lines, and the summary. The ` --> `
      // lines must NOT match the stack-trace pattern, and the residual must
      // classify as lint-debt, not fatal.
      const stderr =
        'error[missing-jsdoc]: test\n  --> packages/runtime/src/index.ts:1:0\nFound 1 documentation lint errors.';
      const result = classifyChildResult(DOC_LINT_EXIT_CODE, '', stderr);
      expect(result.kind).toBe('lint-debt');
    });

    it('recognizes the lint summary line so it is not residual-fatal', () => {
      const stderr =
        `error[missing-jsdoc]: test\n  --> packages/runtime/src/index.ts:1:0\nFound 1 documentation lint errors.`;
      const result = classifyChildResult(DOC_LINT_EXIT_CODE, '', stderr);
      expect(result.kind).toBe('lint-debt');
    });
  });

  describe('readManifestExports — exact error classifications', () => {
    it('classifies a missing/unreadable manifest as read-failed', async () => {
      const fs = {
        readTextFile: (_path: string) => Promise.reject(new Error('NotFound')),
      };
      const result = await readManifestExports(
        'packages/missing/deno.json',
        fs,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('read-failed');
        expect(result.failure.path).toBe('packages/missing/deno.json');
      }
    });

    it('classifies malformed JSON as malformed-manifest', async () => {
      const fs = {
        readTextFile: (_path: string) => Promise.resolve('{ not json }'),
      };
      const result = await readManifestExports('packages/foo/deno.json', fs);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('malformed-manifest');
        expect(result.failure.path).toBe('packages/foo/deno.json');
      }
    });

    it('classifies a manifest with no exports field as invalid-export-map', async () => {
      const fs = {
        readTextFile: (_path: string) => Promise.resolve('{}'),
      };
      const result = await readManifestExports('packages/foo/deno.json', fs);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('invalid-export-map');
      }
    });

    it('classifies a manifest with exports of wrong type as invalid-export-map', async () => {
      const fs = {
        readTextFile: (_path: string) => Promise.resolve(JSON.stringify({ exports: 42 })),
      };
      const result = await readManifestExports('packages/foo/deno.json', fs);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('invalid-export-map');
      }
    });

    it('classifies a manifest with an empty exports object as no-export-targets', async () => {
      const fs = {
        readTextFile: (_path: string) => Promise.resolve(JSON.stringify({ exports: {} })),
      };
      const result = await readManifestExports('packages/foo/deno.json', fs);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('no-export-targets');
      }
    });

    it('returns targets for a valid string export', async () => {
      const fs = {
        readTextFile: (_path: string) =>
          Promise.resolve(JSON.stringify({ exports: './src/index.ts' })),
      };
      const result = await readManifestExports('packages/foo/deno.json', fs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.targets).toEqual(['./src/index.ts']);
      }
    });

    it('returns targets for a valid object export map', async () => {
      const fs = {
        readTextFile: (_path: string) =>
          Promise.resolve(
            JSON.stringify({
              exports: { '.': './src/index.ts', './worker': './src/worker.ts' },
            }),
          ),
      };
      const result = await readManifestExports('packages/foo/deno.json', fs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.targets).toContain('./src/index.ts');
        expect(result.targets).toContain('./src/worker.ts');
      }
    });

    it('corrupt double-prefix prevention: a target with a doubled ./ is not silently accepted', async () => {
      // An export target "././src/index.ts" must not collapse to a valid path
      // silently; expandExportTargets normalizes it to "./src/index.ts".
      const fs = {
        readTextFile: (_path: string) =>
          Promise.resolve(JSON.stringify({ exports: '././src/index.ts' })),
      };
      const result = await readManifestExports('packages/foo/deno.json', fs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The normalized target must not contain a doubled prefix.
        for (const t of result.targets) {
          expect(t).not.toContain('././');
        }
      }
    });
  });

  describe('runApiDocs — generate-mode edge cases', () => {
    it('generate mode with stdout on failure includes stdout in findings', async () => {
      const { PUBLISHED_PACKAGES } = await import(
        '../scripts/release-packages.ts'
      );
      const fs = {
        readTextFile: (path: string) => {
          if (path === 'deno.json') {
            return Promise.resolve(
              JSON.stringify({ workspace: PUBLISHED_PACKAGES }),
            );
          }
          return Promise.resolve(
            JSON.stringify({ exports: { '.': './src/index.ts' } }),
          );
        },
        readDir: async function* () {
          yield* [];
        },
        stat: () =>
          Promise.resolve(
            { isFile: true, isDirectory: false, size: 0 } as Deno.FileInfo,
          ),
        remove: (_p: string, _o?: { recursive: boolean }) => Promise.resolve(),
        mkdir: (_p: string, _o?: { recursive: boolean }) => Promise.resolve(),
      };
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: 'some stdout error', stderr: '' }),
      };
      const result = await runApiDocs('generate', '/tmp/fake-api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('some stdout error'))).toBe(
        true,
      );
    });

    it('generate mode with success but missing output reports the gap', async () => {
      const { PUBLISHED_PACKAGES } = await import(
        '../scripts/release-packages.ts'
      );
      const fs = {
        readTextFile: (path: string) => {
          if (path === 'deno.json') {
            return Promise.resolve(
              JSON.stringify({ workspace: PUBLISHED_PACKAGES }),
            );
          }
          return Promise.resolve(
            JSON.stringify({ exports: { '.': './src/index.ts' } }),
          );
        },
        readDir: async function* () {
          yield* [];
        },
        stat: (path: string) => {
          // The target files exist, but the output index.html does not.
          if (path.includes('index.html')) {
            return Promise.reject(new Error('NotFound'));
          }
          return Promise.resolve(
            { isFile: true, isDirectory: false, size: 0 } as Deno.FileInfo,
          );
        },
        remove: (_p: string, _o?: { recursive: boolean }) => Promise.resolve(),
        mkdir: (_p: string, _o?: { recursive: boolean }) => Promise.resolve(),
      };
      const cmd = {
        run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
      };
      const result = await runApiDocs(
        'generate',
        '/tmp/fake-api-missing',
        fs,
        cmd,
      );
      expect(result.code).toBe(1);
      expect(
        result.findings.some((f) => f.includes('Generated output not found')),
      ).toBe(true);
    });
  });

  describe('collectApiEntrypoints — reconciliation errors', () => {
    it('throws when workspace members are missing from PUBLISHED_PACKAGES', async () => {
      const fs = {
        readTextFile: (path: string) => {
          if (path === 'deno.json') {
            // Workspace has an extra package not in PUBLISHED_PACKAGES.
            return Promise.resolve(
              JSON.stringify({
                workspace: ['packages/common', 'packages/extra-pkg'],
              }),
            );
          }
          return Promise.resolve(
            JSON.stringify({ exports: { '.': './src/index.ts' } }),
          );
        },
        readDir: async function* () {
          yield* [];
        },
        stat: () =>
          Promise.resolve(
            { isFile: true, isDirectory: false, size: 0 } as Deno.FileInfo,
          ),
      };
      await expect(collectApiEntrypoints(fs)).rejects.toThrow(
        'Workspace members missing from PUBLISHED_PACKAGES',
      );
    });

    it('throws when published packages are missing from workspace', async () => {
      const fs = {
        readTextFile: (path: string) => {
          if (path === 'deno.json') {
            // Workspace has only one package; PUBLISHED_PACKAGES has more.
            return Promise.resolve(
              JSON.stringify({ workspace: ['packages/common'] }),
            );
          }
          return Promise.resolve(
            JSON.stringify({ exports: { '.': './src/index.ts' } }),
          );
        },
        readDir: async function* () {
          yield* [];
        },
        stat: () =>
          Promise.resolve(
            { isFile: true, isDirectory: false, size: 0 } as Deno.FileInfo,
          ),
      };
      await expect(collectApiEntrypoints(fs)).rejects.toThrow(
        'Published packages missing from workspace',
      );
    });

    it('throws when a declared export target does not exist on disk', async () => {
      const { PUBLISHED_PACKAGES } = await import(
        '../scripts/release-packages.ts'
      );
      const fs = {
        readTextFile: (path: string) => {
          if (path === 'deno.json') {
            return Promise.resolve(
              JSON.stringify({ workspace: PUBLISHED_PACKAGES }),
            );
          }
          return Promise.resolve(
            JSON.stringify({ exports: { '.': './src/index.ts' } }),
          );
        },
        readDir: async function* () {
          yield* [];
        },
        stat: (path: string) => {
          // The target file does not exist on disk.
          if (path.includes('src/index.ts')) {
            return Promise.reject(new Error('NotFound'));
          }
          return Promise.resolve(
            { isFile: true, isDirectory: false, size: 0 } as Deno.FileInfo,
          );
        },
      };
      await expect(collectApiEntrypoints(fs)).rejects.toThrow(
        'does not exist on disk',
      );
    });
  });

  describe('generate-api-docs.ts subprocess integration', () => {
    it('main() --check exits 0 on the real repository (ratchet passes)', async () => {
      const cmd = new Deno.Command('deno', {
        args: [
          'run',
          '--allow-read',
          '--allow-run',
          '--allow-env',
          'scripts/generate-api-docs.ts',
          '--check',
        ],
        stdout: 'piped',
        stderr: 'piped',
      });
      const output = await cmd.output();
      expect(output.code).toBe(0);
    });

    it('main() generate mode exits 0 and produces docs/api/index.html', async () => {
      const cmd = new Deno.Command('deno', {
        args: [
          'run',
          '--allow-read',
          '--allow-run',
          '--allow-write',
          '--allow-env',
          'scripts/generate-api-docs.ts',
        ],
        stdout: 'piped',
        stderr: 'piped',
      });
      const output = await cmd.output();
      expect(output.code).toBe(0);
      // Verify the generated index.html exists.
      try {
        await Deno.stat('docs/api/index.html');
      } catch {
        throw new Error('docs/api/index.html was not generated');
      }
    });
  });
});

describe('cold-cache resilience (the CI-only failure)', () => {
  /**
   * `deno doc` writes `Download https://registry.npmjs.org/...` to stderr once
   * per npm specifier its graph reaches, but ONLY when the cache is cold. CI is
   * always cold; a developer machine almost never is. The classifier treats
   * unrecognized stderr as a fatal child error, so the ratchet reported
   * "fatal child error" on CI while passing locally — with the diagnostic count
   * at exactly the baseline in both places.
   *
   * Two independent guards, pinned here because dropping either silently
   * restores a green local run and a red CI one.
   */
  it('passes --quiet so progress output never reaches the classifier', () => {
    // Measured: 2 `Download` lines without this flag under a forced cold fetch
    // (`--reload=npm:drizzle-orm`), 0 with it.
    expect(buildDenoDocArgs(['a.ts'], 'check', 'docs/api')).toContain('--quiet');
    expect(buildDenoDocArgs(['a.ts'], 'generate', 'docs/api')).toContain('--quiet');
  });

  it('classifies real cold-cache stderr as lint debt, not a fatal error', () => {
    // The exact shape CI produced, reduced to one diagnostic.
    const stderr = [
      'Download https://registry.npmjs.org/drizzle-orm',
      'Download https://registry.npmjs.org/@prisma%2fclient',
      "error[private-type-ref]: public type 'MemoryAuditStorage' references private type 'IAuditStorage'",
      '  --> /repo/packages/audit-plugin/src/storage/memory-audit.ts:14:1',
      '   = hint: make the referenced type public or remove the reference',
      'Found 1 documentation lint errors.',
    ].join('\n');

    expect(classifyChildResult(1, '', stderr).kind).toBe('lint-debt');
  });

  it('still reports a genuine failure as fatal, so the tolerance stayed narrow', () => {
    const stderr = [
      'Download https://registry.npmjs.org/drizzle-orm',
      "error[private-type-ref]: public type 'X' references private type 'Y'",
      '  --> /repo/a.ts:1:1',
      'Found 1 documentation lint errors.',
      'error: Module not found "./missing.ts".',
    ].join('\n');

    expect(classifyChildResult(1, '', stderr).kind).toBe('fatal');
  });

  it('does not treat an arbitrary unrecognized line as progress', () => {
    const stderr = [
      'Something unexpected happened',
      "error[private-type-ref]: public type 'X' references private type 'Y'",
      '  --> /repo/a.ts:1:1',
      'Found 1 documentation lint errors.',
    ].join('\n');

    expect(classifyChildResult(1, '', stderr).kind).toBe('fatal');
  });
});
