/**
 * Detection of a project still using the pre-E8 HTTP layout.
 *
 * E8 merged `src/routes/` into `src/controllers/`: one directory and one barrel
 * for both generator shapes. That is a breaking change to already-published
 * generated output, and the interesting case is not a fresh scaffold — it is a
 * project that already has `src/routes/`.
 *
 * Nothing else can see that project. The artifact scanner reads
 * `src/controllers/`, so a file under `src/routes/` is not scanned, not skipped,
 * and not reported; `setu.config.ts` still imports `./src/routes/index.ts`,
 * because it is the developer's file and the CLI does not rewrite it. Measured
 * against a real scaffold: `setu g route billing` printed two `created` lines
 * and exited `0`, leaving a NEW `src/controllers/index.ts` that nothing imports
 * beside the developer's still-wired `src/routes/index.ts` — so the route was
 * generated, reported as created, and unreachable.
 *
 * That is the M60 defect class (an artifact that compiles and does nothing),
 * reintroduced for upgrading projects by the very change meant to remove it.
 *
 * This reports rather than refuses. The consequence is real but not corrupting,
 * and refusing would leave the developer unable to run the generator inside the
 * project they are trying to migrate.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

import { joinPath } from './file-writer.ts';
import { HTTP_SEAM_BARREL, HTTP_SEAM_DIR, REGISTER_ROUTES_EXPORT } from '../seams/http.ts';

/** Where HTTP artifacts lived before E8, relative to the project root. */
export const LEGACY_HTTP_DIR = 'src/routes';

/**
 * Lists the files in a project's pre-E8 `src/routes/` directory.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project directory to scan
 * @returns The file names present, or an empty list when the directory is absent
 * or holds nothing — both of which mean there is nothing to migrate
 */
export async function readLegacyHttpFiles(
  fs: IFileSystem,
  dir: string,
): Promise<readonly string[]> {
  try {
    const entries = await fs.readdir(joinPath(dir, LEGACY_HTTP_DIR));
    return entries.filter((entry) => entry.endsWith('.ts')).sort();
  } catch {
    // Absent, which is the normal case: every project scaffolded since E8.
    return [];
  }
}

/**
 * Renders the migration notice for a project still on the old layout.
 *
 * Pure, so the wording is unit-testable without a filesystem, and one caller
 * decides where it is written.
 *
 * @param files - The files found under the legacy directory
 * @returns The lines to report, or an empty list when there is nothing to say
 */
export function legacyLayoutNotice(files: readonly string[]): readonly string[] {
  if (files.length === 0) return [];

  return [
    `${LEGACY_HTTP_DIR}/ still holds ${files.length} file(s): ${files.join(', ')}.`,
    `  That directory was merged into ${HTTP_SEAM_DIR}/. Until you move them, ` +
    `${HTTP_SEAM_BARREL} is`,
    `  imported by nothing and everything generated into it is unreachable.`,
    `  Move them, delete ${LEGACY_HTTP_DIR}/, and point setu.config.ts at ` +
    `./${HTTP_SEAM_BARREL}.`,
  ];
}

/** The application file that wires the generated barrel into the app. */
export const CONFIG_MODULE = 'setu.config.ts';

/**
 * Reads a project's `setu.config.ts`.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project directory
 * @returns The source, or an empty string when the file is absent
 */
export async function readConfigModule(fs: IFileSystem, dir: string): Promise<string> {
  try {
    return new TextDecoder().decode(await fs.readFile(joinPath(dir, CONFIG_MODULE)));
  } catch {
    // Absent: a bare directory, or a project that keeps its wiring elsewhere.
    return '';
  }
}

/**
 * Renders the migration notice for a config still calling the registrar with
 * only a router.
 *
 * The registry parameter is optional precisely so such a project keeps
 * compiling, which means nothing else reports it: a generated SSE controller
 * resolves its capability from that registry and throws at startup instead.
 * Pure, so the wording is unit-testable without a filesystem.
 *
 * @param source - The contents of the project's `setu.config.ts`
 * @returns The lines to report, or an empty list when the call is current
 */
export function legacyRegistrarNotice(source: string): readonly string[] {
  const legacyCall = new RegExp(`${REGISTER_ROUTES_EXPORT}\\(\\s*app\\.router\\s*\\)`);
  if (!legacyCall.test(source)) return [];

  return [
    `${CONFIG_MODULE} calls ${REGISTER_ROUTES_EXPORT}(app.router) without the service registry.`,
    `  Generated artifacts that resolve a capability — an SSE controller does — receive`,
    `  \`undefined\` and throw at startup.`,
    `  Change the call to ${REGISTER_ROUTES_EXPORT}(app.router, app.services).`,
  ];
}
