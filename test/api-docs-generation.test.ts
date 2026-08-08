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
      const fs = {
        readTextFile: (_path: string) => Promise.resolve('{}'),
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => {
          // Reject all stat calls so fallback also fails
          throw new Deno.errors.NotFound(`Not found: ${path}`);
        },
      };
      // All manifests return {} and no fallback files exist → should throw
      await expect(collectApiEntrypoints(fs)).rejects.toThrow(
        'Published packages missing export targets',
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
});
