/** The single owner of flat/modular project layout detection. @module */
import type { IFileSystem } from '@setu-ts/common';
import { scanModules, type ModuleScan } from './module-scanner.ts';
import { generatorMode } from './generator-mode.ts';
import { detectPlugins } from './plugin-detector.ts';
import { walkArtifactFiles } from './artifact-walk.ts';

/** Route and service placement, independent of controller shape. */
export type ProjectLayout = 'flat' | 'modular' | 'mixed';

/**
 * Lists the controllers and services kept in the flat homes, project-relative.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project root
 * @returns `src/controllers/**\/*.controller.ts` and `src/services/**\/*.service.ts`
 */
export async function flatArtifactFiles(fs: IFileSystem, dir: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const [root, suffix] of [
    ['src/controllers', '.controller.ts'],
    ['src/services', '.service.ts'],
  ] as const) {
    const scan = await walkArtifactFiles(fs, dir, root);
    found.push(
      ...scan.files.filter((file) => file.endsWith(suffix)).map((file) => `${root}/${file}`),
    );
  }
  return found.sort();
}

/**
 * Detects layout from admitted declarations and flat controller/service files.
 * Diagnosis supplies its existing module scan so admission is evaluated once.
 */
export async function projectLayout(
  fs: IFileSystem,
  dir: string,
  modules?: ModuleScan,
): Promise<ProjectLayout> {
  const admitted =
    modules ?? (await scanModules(fs, dir, generatorMode(await detectPlugins(fs, dir))));
  const flat = admitted.names.length === 0;
  const stray = flat ? 0 : (await flatArtifactFiles(fs, dir)).length;
  return flat ? 'flat' : stray > 0 ? 'mixed' : 'modular';
}
