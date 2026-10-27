/** Production bundles for individual Node services. Never loads the application. @module */
import { build } from 'esbuild';
import type { BuildOptions, BuildResult, Metafile } from 'esbuild';
import type { IFileSystem } from '@setu-ts/common';
import { stringFlag, type ParsedArgs } from '../args.ts';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../constants.ts';
import type { ICheckDependencies } from './check.ts';
import { runCheckCommand } from './check.ts';
import {
  assertInsideProject,
  joinPath,
  readExistingText,
  resolveDir,
} from '../utils/file-writer.ts';
import { isMissingPath } from '../utils/filesystem-errors.ts';
import { detectProject, findWorkspaceMarker } from '../utils/project-detector.ts';
import { detectTargetRuntime } from '../utils/runtime-detector.ts';
import { escapeTerminalControls } from '../utils/names.ts';

/** The external tool boundary, injectable without replacing production resolution. */
export interface IBuildDependencies extends ICheckDependencies {
  readonly bundle?: (options: BuildOptions) => Promise<BuildResult>;
}

type Manifest = Readonly<Record<string, unknown>>;
interface ILibraryOwner {
  readonly dir: string;
  readonly manifest: Manifest;
}

function record(value: unknown): Manifest {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Manifest)
    : {};
}

/** Manifest packages remain external; workspace library names are bundled. */
export function bundleExternals(project: Manifest, libraries: readonly Manifest[] = []): string[] {
  const names = new Set<string>();
  for (const manifest of [project, ...libraries]) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const name of Object.keys(record(manifest[field]))) names.add(name);
    }
  }
  for (const library of libraries) {
    if (typeof library['name'] === 'string') names.delete(library['name']);
  }
  return [...names].sort();
}

async function manifestAt(fs: IFileSystem, dir: string): Promise<Manifest> {
  const source = await readExistingText(fs, joinPath(dir, 'package.json'));
  if (source === undefined) throw new Error(`Missing ${dir}/package.json.`);
  return record(JSON.parse(source));
}

async function exists(fs: IFileSystem, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (cause) {
    if (isMissingPath(cause)) return false;
    throw cause;
  }
}

async function libraryOwners(fs: IFileSystem, dir: string): Promise<ILibraryOwner[]> {
  const root = resolveDir(dir, '../..');
  if ((await findWorkspaceMarker(fs, root)) === undefined) return [];
  await assertInsideProject(fs, root, dir);
  const libs = joinPath(root, 'libs');
  if (!(await exists(fs, libs))) return [];
  await assertInsideProject(fs, root, libs);
  const owners: ILibraryOwner[] = [];
  for (const name of await fs.readdir(libs)) {
    const path = joinPath(libs, name);
    await assertInsideProject(fs, root, path);
    if (!(await fs.stat(path)).isDirectory || !(await exists(fs, joinPath(path, 'package.json'))))
      continue;
    owners.push({ dir: path, manifest: await manifestAt(fs, path) });
  }
  return owners;
}

function packageName(path: string): string {
  return path.startsWith('@') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0]!;
}

function developmentImports(
  meta: Metafile,
  dir: string,
  project: Manifest,
  libraries: readonly ILibraryOwner[],
): string[] {
  const errors: string[] = [];
  for (const [file, input] of Object.entries(meta.inputs)) {
    const absolute = resolveDir(dir, file);
    const owner =
      libraries.find((library) => absolute.startsWith(`${library.dir}/`))?.manifest ?? project;
    const dev = record(owner['devDependencies']);
    // Only what `npm ci --omit=dev` installs counts as production: a package in
    // both devDependencies and peerDependencies is omitted (measured, npm 11.19.1;
    // M120 audit F7), so a peer listing does not clear a dev one.
    const production = new Set(
      ['dependencies', 'optionalDependencies'].flatMap((field) =>
        Object.keys(record(owner[field])),
      ),
    );
    for (const imported of input.imports) {
      const name = packageName(imported.path);
      if (imported.external && name in dev && !production.has(name)) {
        errors.push(
          `${file}: runtime import of devDependency "${name}"; move it to dependencies before building.`,
        );
      }
    }
  }
  return errors;
}

/** Runs the wiring gate, plans entries, and writes a checked production bundle. */
export async function runBuildCommand(args: ParsedArgs, deps: IBuildDependencies): Promise<number> {
  if (args.flags.help === true || args.flags.h === true) {
    deps.log('Usage: setu build [--dir <path>] [--dry-run]');
    deps.log('  --dir <path>  Build this Node project or workspace member');
    deps.log('  --dry-run     Check wiring and print the bundle plan without writing');
    return EXIT_OK;
  }
  const dir = resolveDir(deps.cwd, stringFlag(args.flags, 'dir'));
  try {
    const project = await detectProject(deps.fs, dir);
    if (project.kind === 'workspace-root') {
      deps.error('setu build requires a workspace member; use setu build --dir apps/<member>.');
      return EXIT_USAGE;
    }
    if (project.kind === 'none') {
      deps.error(
        `${dir} holds no deno.json, deno.jsonc or package.json — run this inside a project, or pass --dir.`,
      );
      return EXIT_ERROR;
    }
    if (project.kind === 'unreadable') {
      deps.error(escapeTerminalControls(`Cannot read ${project.path}: ${project.reason}`));
      return EXIT_ERROR;
    }
    const runtime = await detectTargetRuntime(deps.fs, dir);
    if (runtime !== 'node') {
      const instead = {
        bun: 'bun run main.ts',
        deno: 'deno task start',
        'cloudflare-workers': 'wrangler deploy',
      };
      deps.error(`setu build supports Node projects; for ${runtime}, run ${instead[runtime]}.`);
      return EXIT_USAGE;
    }
    if ((await runCheckCommand({ positionals: [], flags: { dir } }, deps)) !== EXIT_OK)
      return EXIT_ERROR;
    const entries = ['main.ts'];
    if (await exists(deps.fs, joinPath(dir, 'src/migrations/run.ts')))
      entries.push('src/migrations/run.ts');
    const manifest = await manifestAt(deps.fs, dir);
    const libraries = await libraryOwners(deps.fs, dir);
    const external = bundleExternals(
      manifest,
      libraries.map((library) => library.manifest),
    );
    const outputs = entries.map((entry) => `dist/${entry.replace(/\.ts$/, '.js')}`);
    if (args.flags['dry-run'] === true) {
      for (const [index, entry] of entries.entries()) deps.log(`${entry} -> ${outputs[index]}`);
      deps.log(`externals: ${external.join(', ')}`);
      return EXIT_OK;
    }
    const dist = joinPath(dir, 'dist');
    await assertInsideProject(deps.fs, dir, dist);
    if ((await exists(deps.fs, dist)) && !(await deps.fs.stat(dist)).isDirectory)
      throw new Error(`${dist} is not a real directory.`);
    // Bundled in memory (`write: false`) and gated BEFORE the previous dist/ is
    // touched, so a refused build or a failed bundle leaves the last good output in
    // place (a write that fails after the removal can leave dist/ incomplete)
    // — Vite's emptyOutDir empties on write the same way (M120 audit F5).
    const result = await (deps.bundle ?? build)({
      absWorkingDir: dir,
      entryPoints: entries,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: true,
      outdir: 'dist',
      outbase: '.',
      logLevel: 'silent',
      external,
      metafile: true,
      write: false,
    });
    const errors = developmentImports(result.metafile!, dir, manifest, libraries);
    if (errors.length > 0) {
      for (const error of errors) deps.error(escapeTerminalControls(error));
      return EXIT_ERROR;
    }
    if (await exists(deps.fs, dist)) await deps.fs.rm(dist, { recursive: true });
    for (const file of result.outputFiles!) {
      await assertInsideProject(deps.fs, dir, file.path);
      await deps.fs.mkdir(resolveDir(file.path, '..'), { recursive: true });
      await deps.fs.writeFile(file.path, file.contents);
    }
    for (const output of outputs) deps.log(`built ${output}`);
    return EXIT_OK;
  } catch (cause) {
    const error = record(cause);
    if (Array.isArray(error['errors'])) {
      for (const item of error['errors']) {
        const message = record(item);
        const location = record(message['location']);
        deps.error(
          escapeTerminalControls(
            `${location['file'] ?? ''}:${location['line'] ?? ''}: ${message['text']}`,
          ),
        );
      }
    } else {
      deps.error(escapeTerminalControls(cause instanceof Error ? cause.message : String(cause)));
    }
    return EXIT_ERROR;
  }
}
