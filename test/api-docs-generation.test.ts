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
  CLEAN_PACKAGES,
  collectApiEntrypoints,
  DOC_LINT_BASELINE,
  expandExportTargets,
  normalizeDiagnosticPath,
  parseDocLintDiagnostics,
  partitionDiagnostics,
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
      expect(result).toEqual(['./src/index.ts', './src/worker/define-worker-task.ts']);
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
      expect(normalizeDiagnosticPath('/home/user/project/packages/common/src/index.ts')).toBe(
        'packages/common/src/index.ts',
      );
    });

    it('handles starter paths', () => {
      expect(normalizeDiagnosticPath('packages/starters/rest-starter/src/index.ts')).toBe(
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
        { rule: 'missing-jsdoc', path: 'packages/common/src/index.ts', line: 10, message: 'test' },
      ];

      const { cleanPackageFindings, knownDebt } = partitionDiagnostics(diagnostics);

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

      const { cleanPackageFindings, knownDebt } = partitionDiagnostics(diagnostics);

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

      const { cleanPackageFindings, knownDebt } = partitionDiagnostics(diagnostics);

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

      const { cleanPackageFindings, knownDebt } = partitionDiagnostics(diagnostics);

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

      const { cleanPackageFindings, knownDebt } = partitionDiagnostics(diagnostics);

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
    it('is the frozen baseline of 776', () => {
      expect(DOC_LINT_BASELINE).toBe(776);
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

    it('throws when a published package has no export targets', async () => {
      const { PUBLISHED_PACKAGES } = await import('../scripts/release-packages.ts');
      const fs = {
        readTextFile: (path: string) => {
          if (path === 'deno.json') {
            return Promise.resolve(JSON.stringify({ workspace: PUBLISHED_PACKAGES }));
          }
          // All manifests return empty exports
          return Promise.resolve('{}');
        },
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      // All manifests return {} → should throw about missing export targets
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
      const cmd = { run: () => Promise.resolve({ code: 1, stdout: '', stderr: diagnostics }) };
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
      const cmd = { run: () => Promise.resolve({ code: 1, stdout: '', stderr: diagnostics }) };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('exceeds baseline'))).toBe(true);
    });

    it('below baseline diagnostics → failure with lower-the-constant hint', async () => {
      const fs = makeFs();
      const diagnostics = `error[missing-jsdoc]: test
  --> packages/runtime/src/index.ts:1:0`;
      const cmd = { run: () => Promise.resolve({ code: 1, stdout: '', stderr: diagnostics }) };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('BELOW baseline'))).toBe(true);
      expect(result.findings.some((f) => f.includes('Update DOC_LINT_BASELINE'))).toBe(true);
    });

    it('fatal nonzero with zero parseable diagnostics → fatal failure surfacing original error', async () => {
      const fs = makeFs();
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'error: Module not found\n' }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed'))).toBe(true);
      expect(result.findings.some((f) => f.includes('Module not found'))).toBe(true);
      // Must NOT report "below baseline"
      expect(result.findings.some((f) => f.includes('BELOW baseline'))).toBe(false);
    });

    it('fatal nonzero with partial parseable diagnostics plus fatal text → fatal failure', async () => {
      const fs = makeFs();
      const stderr = 'error: Module not found\n' +
        'error[missing-jsdoc]: test\n' +
        '  --> packages/runtime/src/index.ts:1:0\n';
      const cmd = { run: () => Promise.resolve({ code: 1, stdout: '', stderr }) };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed'))).toBe(true);
      expect(result.findings.some((f) => f.includes('Module not found'))).toBe(true);
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
      const cmd = { run: () => Promise.resolve({ code: 1, stdout: '', stderr }) };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed'))).toBe(true);
      expect(result.findings.some((f) => f.includes('Module not found'))).toBe(true);
      // Must NOT pass even though diagnostic count equals baseline
      expect(result.code).not.toBe(0);
    });

    it('generation-mode fatal failure remains propagated', async () => {
      // Use a mock fs that returns valid manifests for the generate-mode test
      // so collectApiEntrypoints succeeds and we can test cmd.run failure.
      const { PUBLISHED_PACKAGES } = await import('../scripts/release-packages.ts');
      const fs = {
        readTextFile: (path: string) => {
          if (path === 'deno.json') {
            return Promise.resolve(JSON.stringify({ workspace: PUBLISHED_PACKAGES }));
          }
          // Return valid manifest for published packages
          return Promise.resolve(JSON.stringify({ exports: { '.': './src/index.ts' } }));
        },
        readDir: async function* () {
          yield* [];
        },
        stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 0 } as Deno.FileInfo),
        remove: (_path: string, _options?: { recursive: boolean }) => Promise.resolve(),
        mkdir: (_path: string, _options?: { recursive: boolean }) => Promise.resolve(),
      };
      const cmd = {
        run: () => Promise.resolve({ code: 2, stdout: '', stderr: 'fatal generation error\n' }),
      };
      const result = await runApiDocs('generate', '/tmp/fake-api-docs', fs, cmd);
      expect(result.code).toBe(2);
      expect(result.findings.some((f) => f.includes('deno doc failed'))).toBe(true);
      expect(result.findings.some((f) => f.includes('fatal generation error'))).toBe(true);
    });

    it('clean-package finding in check mode → failure even without fatal text', async () => {
      const fs = makeFs();
      const stderr = 'error[missing-jsdoc]: test\n  --> packages/common/src/index.ts:1:0\n';
      const cmd = { run: () => Promise.resolve({ code: 1, stdout: '', stderr }) };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('CLEAN packages'))).toBe(true);
    });

    it('ANSI-colored fatal on stderr is detected', async () => {
      const fs = makeFs();
      const ansiFatal = '\u001b[31merror: Permission denied\u001b[0m\n';
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr: ansiFatal }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed'))).toBe(true);
      expect(result.findings.some((f) => f.includes('Permission denied'))).toBe(true);
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
      expect(result.findings.some((f) => f.includes('deno doc --lint failed'))).toBe(true);
      expect(result.findings.some((f) => f.includes('Module not found'))).toBe(true);
    });

    it('warning format (not fatal) with non-1 exit is still classified as lint', async () => {
      const fs = makeFs();
      // A warning that doesn't match the fatal pattern
      const output = 'warning: some non-fatal warning\n';
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: output, stderr: '' }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      // Should NOT be treated as fatal - should fall through to ratchet
      expect(result.findings.some((f) => f.includes('deno doc --lint failed'))).toBe(false);
    });

    it('fatal mixed with zero parseable diagnostics fails', async () => {
      const fs = makeFs();
      const stderr = 'error: Fatal error\n';
      const cmd = {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr }),
      };
      const result = await runApiDocs('check', 'docs/api', fs, cmd);
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.includes('deno doc --lint failed'))).toBe(true);
      // Should NOT say "below baseline" since there's a fatal
      expect(result.findings.some((f) => f.includes('BELOW baseline'))).toBe(false);
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
      expect(result.findings.some((f) => f.includes('deno doc --lint failed'))).toBe(true);
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
      expect(result.findings.some((f) => f.includes('deno doc --lint failed'))).toBe(true);
      // Must NOT pass even though diagnostic count equals baseline
      expect(result.code).not.toBe(0);
    });
  });
});
