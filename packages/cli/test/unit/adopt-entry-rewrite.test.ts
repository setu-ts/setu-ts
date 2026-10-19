import { describe, expect, it } from 'vitest';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runAdoptCommand } from '../../src/commands/adopt.ts';
import type { TargetRuntime } from '../../src/constants.ts';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { formatForTarget } from '../../src/utils/prettier-format.ts';
import { DISCOVERY_SPECIFIER, SERVICE_PORT_EXPORT } from '../../src/workspace/discovery-module.ts';
import { rewriteEntryPort } from '../../src/workspace/adopt.ts';

/**
 * The legacy entry shape, complete: the start line and the `createApp` import
 * the rewrite places the port import beside.
 */
const ENTRY =
  `import { createApp } from './setu.config.ts';\n` +
  `\nconst app = await createApp();\n\nawait app.start({ port: 3000 });\n`;
const ENTRY_PATH = '/work/svc/apps/svc/main.ts';

/** The minimal host every standalone entry is rendered from. */
const host = resolveHost(
  { plugins: [{ pkg: 'runtime', symbol: 'RuntimePlugin' }], middleware: [] },
  'deno',
);

/**
 * The `main.ts` the CLI renders for a standalone project.
 *
 * @param runtime - The target runtime
 * @returns Its contents
 */
function standaloneEntry(runtime: TargetRuntime): string {
  const files = projectFiles('svc', runtime, host);
  const main = files.find((file) => file.path === 'main.ts');
  expect(main).toBeDefined();
  return main?.contents ?? '';
}

/**
 * The `main.ts` the CLI renders for a workspace member.
 *
 * @param runtime - The target runtime
 * @returns Its contents
 */
function memberEntry(runtime: TargetRuntime): string {
  const files = projectFiles('svc', runtime, host, {
    symbol: SERVICE_PORT_EXPORT,
    from: DISCOVERY_SPECIFIER,
  });
  const main = files.find((file) => file.path === 'main.ts');
  expect(main).toBeDefined();
  return main?.contents ?? '';
}

/**
 * Non-blank lines, sorted, so two renderings can be compared modulo import position.
 *
 * @param source - The file contents
 * @returns Its non-blank lines, sorted
 */
function lines(source: string): readonly string[] {
  return source
    .split('\n')
    .filter((line) => line !== '')
    .sort();
}

describe('adopt entry rewrite', () => {
  it('reports a failed rewrite, restores a partial write, and never prints success guidance', async () => {
    const fs = createFakeFs({
      '/work/svc/deno.json': '{}',
      '/work/svc/setu.config.ts': 'export function createApp() {}',
      '/work/svc/main.ts': ENTRY,
    });
    const out = createRecorder();
    const err = createRecorder();
    let failed = false;
    const code = await runAdoptCommand(parseArgs([]), {
      fs: {
        ...fs,
        async writeFile(path, bytes) {
          if (
            path === ENTRY_PATH &&
            new TextDecoder().decode(bytes).includes('SERVICE_PORT') &&
            !failed
          ) {
            failed = true;
            await fs.writeFile(path, bytes.slice(0, 5));
            throw new Error('disk full during entry rewrite');
          }
          await fs.writeFile(path, bytes);
        },
      },
      cwd: '/work/svc',
      log: out.sink,
      error: err.sink,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('disk full during entry rewrite');
    expect(err.text()).toContain(ENTRY_PATH);
    expect(fs.read(ENTRY_PATH)).toBe(ENTRY);
    expect(out.text()).not.toContain('Converted into');
    expect(out.text()).not.toContain('does not carry the start line');
  });

  it('keeps an absent entry optional', async () => {
    const fs = createFakeFs({
      '/work/svc/deno.json': '{}',
      '/work/svc/setu.config.ts': 'export function createApp() {}',
    });
    const err = createRecorder();
    expect(
      await runAdoptCommand(parseArgs([]), {
        fs,
        cwd: '/work/svc',
        log: createRecorder().sink,
        error: err.sink,
      }),
    ).toBe(0);
    expect(err.text()).toBe('');
  });
  it('reports an unreadable entry instead of treating it as absent', async () => {
    const fs = createFakeFs({
      '/work/svc/deno.json': '{}',
      '/work/svc/setu.config.ts': 'export function createApp() {}',
      '/work/svc/main.ts': ENTRY,
    });
    const err = createRecorder();
    const out = createRecorder();
    const result = await runAdoptCommand(parseArgs([]), {
      fs: {
        ...fs,
        readFile(path) {
          // Refuse only in the entry-rewrite phase, after the workspace exists;
          // the journal and copy verification also read the destination earlier.
          if (path === ENTRY_PATH && fs.has('/work/svc/setu.workspace.json')) {
            return Promise.reject('read denied');
          }
          return fs.readFile(path);
        },
      },
      cwd: '/work/svc',
      error: err.sink,
      log: out.sink,
    });
    expect(result).toBe(1);
    expect(err.text()).toContain(`Failed to read ${ENTRY_PATH}: read denied`);
    expect(out.text()).not.toContain('Converted into');
  });
});

describe('rewriteEntryPort', () => {
  it('rewrites the entry the CLI renders for every socket runtime', () => {
    for (const runtime of ['deno', 'node', 'bun'] as const) {
      const rewritten = rewriteEntryPort(
        standaloneEntry(runtime),
        SERVICE_PORT_EXPORT,
        DISCOVERY_SPECIFIER,
      );

      expect(rewritten).toBeDefined();
      expect(rewritten).toContain(
        `import { ${SERVICE_PORT_EXPORT} } from '${DISCOVERY_SPECIFIER}';`,
      );
      expect(rewritten).toContain(`await app.start({ port: ${SERVICE_PORT_EXPORT} });`);
      // Same lines as the member rendering, only the import's position differs.
      expect(lines(rewritten ?? '')).toEqual(lines(memberEntry(runtime)));
    }
  });

  it('rewrites the Prettier-formatted entry Node actually writes', async () => {
    const formatted = await formatForTarget(
      [{ path: 'main.ts', contents: standaloneEntry('node') }],
      'node',
      undefined,
      () => {
        // No file is skipped by a parse failure in this fixture.
      },
    );
    const main = formatted[0]?.contents ?? '';

    const rewritten = rewriteEntryPort(main, SERVICE_PORT_EXPORT, DISCOVERY_SPECIFIER);

    expect(rewritten).toBeDefined();
    expect(rewritten).toContain(`await app.start({ port: ${SERVICE_PORT_EXPORT} });`);
  });

  it('rewrites the legacy literal entry too', () => {
    expect(rewriteEntryPort(ENTRY, SERVICE_PORT_EXPORT, DISCOVERY_SPECIFIER)).toContain(
      `await app.start({ port: ${SERVICE_PORT_EXPORT} });`,
    );
  });

  it('accepts double quotes in both pieces, as Prettier may leave them', () => {
    const entry =
      `import { createApp } from "./setu.config.ts";\n` +
      `\nconst app = await createApp();\n\n` +
      `await app.start({ port: Number(runtime.env.PORT ?? "3000") });\n`;

    expect(rewriteEntryPort(entry, SERVICE_PORT_EXPORT, DISCOVERY_SPECIFIER)).toContain(
      `await app.start({ port: ${SERVICE_PORT_EXPORT} });`,
    );
  });

  it('returns undefined when the start line is missing', () => {
    const entry =
      `import { createApp } from './setu.config.ts';\n` +
      `\nconst app = await createApp();\n\nawait app.start({ port: 8080 });\n`;
    expect(rewriteEntryPort(entry, SERVICE_PORT_EXPORT, DISCOVERY_SPECIFIER)).toBeUndefined();
  });

  it('returns undefined when the createApp import is missing', () => {
    const entry = `const app = await makeApp();\nawait app.start({ port: 3000 });\n`;
    expect(rewriteEntryPort(entry, SERVICE_PORT_EXPORT, DISCOVERY_SPECIFIER)).toBeUndefined();
  });

  // The old `import { [^}]+ } from …` regex backtracked quadratically on
  // project-supplied text: 80k repetitions of `import { ` followed by a `}` and a
  // normal entry took ~20 s. The line scan is linear, so this returns almost
  // immediately (F3).
  it('does not backtrack on a line that repeats the import prefix', { timeout: 30_000 }, () => {
    const entry = `${'import { '.repeat(80_000)}}\n${ENTRY}`;

    const started = performance.now();
    const rewritten = rewriteEntryPort(entry, SERVICE_PORT_EXPORT, DISCOVERY_SPECIFIER);
    const elapsed = performance.now() - started;

    expect(rewritten).toBeDefined();
    expect(elapsed).toBeLessThan(1000);
  });

  it('returns undefined when the import line has a } in its middle', () => {
    const entry =
      `import { createApp, nested: { a: 1 } } from './setu.config.ts';\n` +
      `\nconst app = await createApp();\n\nawait app.start({ port: 3000 });\n`;
    expect(rewriteEntryPort(entry, SERVICE_PORT_EXPORT, DISCOVERY_SPECIFIER)).toBeUndefined();
  });

  it('returns undefined when the import line has nothing between its braces', () => {
    const entry =
      `import {  } from './setu.config.ts';\n` +
      `\nconst app = await createApp();\n\nawait app.start({ port: 3000 });\n`;
    expect(rewriteEntryPort(entry, SERVICE_PORT_EXPORT, DISCOVERY_SPECIFIER)).toBeUndefined();
  });
});
