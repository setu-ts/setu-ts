/** Read-only project facts. Rendering never opens a project file. */
import type { IFileSystem } from '@setu-ts/common';
import type { TargetRuntime } from '../constants.ts';
import { VERSION } from '../constants.ts';
import { detectPlugins } from '../utils/plugin-detector.ts';
import { generatorMode, type GeneratorMode } from '../utils/generator-mode.ts';
import { detectTargetRuntime } from '../utils/runtime-detector.ts';
import { detectProject } from '../utils/project-detector.ts';
import { readJsonManifest } from '../utils/manifest-reader.ts';
import { joinPath } from '../utils/file-writer.ts';
import { isMissingPath } from '../utils/filesystem-errors.ts';
import { seamsFor } from '../templates/seam.ts';
import { availableSchematics } from '../commands/generate.ts';

/** Everything needed to render one standalone or workspace-member brief. */
export type ProjectFacts = {
  readonly version: string;
  readonly installed: ReadonlySet<string>;
  readonly style: GeneratorMode;
  readonly runtime: TargetRuntime;
  readonly commands: readonly string[];
  readonly schematics: readonly string[];
  readonly seams: readonly string[];
  readonly directories: readonly string[];
};

/** Gather facts without importing or booting application code. */
export async function gatherFacts(fs: IFileSystem, dir: string): Promise<ProjectFacts> {
  const project = await detectProject(fs, dir);
  if (project.kind === 'unreadable')
    throw new Error(`Cannot read ${project.path}: ${project.reason}`);
  if (project.kind !== 'project') throw new Error(`${dir}: not a project`);
  const runtime = await detectTargetRuntime(fs, dir);
  const installed = await detectPlugins(fs, dir);
  const commands = new Set<string>();
  for (const manifest of project.manifests) {
    const read = await readJsonManifest(fs, manifest.path);
    if (read.kind !== 'ok') throw new Error(`Cannot read ${manifest.path}`);
    if (typeof read.value !== 'object' || read.value === null || Array.isArray(read.value)) {
      throw new Error(`Cannot read ${manifest.path}: expected an object`);
    }
    const record = read.value as Record<string, unknown>;
    const entries = record[runtime === 'deno' ? 'tasks' : 'scripts'];
    if (typeof entries === 'object' && entries !== null) {
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value === 'string') commands.add(key);
      }
    }
  }
  const directories: string[] = [];
  for (const path of ['src/modules', 'src/shared']) {
    try {
      if ((await fs.stat(joinPath(dir, path))).isDirectory) directories.push(path);
    } catch (cause) {
      if (!isMissingPath(cause)) throw cause;
    }
  }
  return {
    version: VERSION,
    installed,
    style: generatorMode(installed),
    runtime,
    commands: ['start', 'check', 'test', 'test:e2e', 'dev', 'build', 'db:migrate'].filter((key) =>
      commands.has(key),
    ),
    schematics: availableSchematics(installed).map((entry) => entry.name),
    // A project with modules keeps its controllers and services there, so the
    // flat homes are not part of its map.
    seams: [...new Set(seamsFor(installed).map((seam) => seam.dir))].filter(
      (path) =>
        !directories.includes('src/modules') ||
        (path !== 'src/controllers' && path !== 'src/services'),
    ),
    directories,
  };
}
