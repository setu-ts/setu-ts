/**
 * Loading of user-authored schematics from `.hono-enterprise/schematics/`.
 *
 * @module
 */

import type { Schematic } from './registry.ts';
import { joinPath } from '../utils/file-writer.ts';

/** Directory, relative to the project root, holding custom schematics. */
export const CUSTOM_SCHEMATIC_DIR = '.hono-enterprise/schematics';

/**
 * Loads an ES module by absolute URL.
 *
 * This is the seam unit tests replace. The default implementation performs a
 * REAL dynamic `import()`, so the production path is the one exercised by
 * `test/integration/custom-schematic-real-import.test.ts`.
 *
 * @param url - Absolute module URL to import
 * @returns The module's exports
 */
export type ModuleLoader = (url: string) => Promise<Record<string, unknown>>;

/**
 * The default {@linkcode ModuleLoader}: a real dynamic import.
 *
 * @param url - Absolute module URL to import
 * @returns The module's exports
 */
export const importModule: ModuleLoader = async (url) =>
  await import(url) as Record<string, unknown>;

/**
 * Resolves the module URL a custom schematic is loaded from.
 *
 * @param dir - The project root the CLI is operating on (absolute)
 * @param name - The schematic name
 * @returns An absolute `file:` URL
 */
export function customSchematicUrl(dir: string, name: string): string {
  const path = joinPath(dir, CUSTOM_SCHEMATIC_DIR, `${name}.ts`);
  return new URL(path.startsWith('/') ? path : `/${path}`, 'file://').href;
}

/**
 * Loads a custom schematic and validates its exported shape.
 *
 * The module must export a `schematic` function (or a default export that is a
 * function) matching {@linkcode Schematic}.
 *
 * @param dir - The project root the CLI is operating on (absolute)
 * @param name - The schematic name, without the `.ts` extension
 * @param load - The module loader; defaults to a real dynamic `import()`
 * @returns The loaded schematic function
 * @throws {Error} If the module cannot be imported, or exports no `schematic`
 * function — the message names the expected path and export
 */
export async function loadCustomSchematic(
  dir: string,
  name: string,
  load: ModuleLoader = importModule,
): Promise<Schematic> {
  const url = customSchematicUrl(dir, name);

  let module: Record<string, unknown>;
  try {
    module = await load(url);
  } catch (cause) {
    throw new Error(
      `Cannot load custom schematic "${name}" from ${url}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }

  const exported = module['schematic'] ?? module['default'];
  if (typeof exported !== 'function') {
    throw new Error(
      `Custom schematic "${name}" (${url}) must export a 'schematic' function ` +
        `of type (names, options) => GeneratedFile[]; found ${typeof exported}.`,
    );
  }

  return exported as Schematic;
}
