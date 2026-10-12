/**
 * Loading of user-authored schematics from `.setu-ts/schematics/`.
 *
 * @module
 */

import type { Schematic } from './registry.ts';
import { joinPath, toFileUrl } from '../utils/file-writer.ts';
import { importProjectModule } from '../utils/ts-loader.ts';
import { escapeName } from '../utils/names.ts';

/** Directory, relative to the project root, holding custom schematics. */
export const CUSTOM_SCHEMATIC_DIR = '.setu-ts/schematics';

/**
 * Loads an ES module by absolute URL.
 *
 * This is the seam unit tests replace. The default implementation performs a
 * REAL import (through `tsx`), so the production path is the one exercised by
 * `test/integration/custom-schematic-real-import.test.ts`.
 *
 * @param url - Absolute module URL to import
 * @param root - The project the module belongs to (absolute). The default
 * loader looks for configuration no higher than this, so a file planted above
 * the project cannot redirect the module's imports; a loader may ignore it.
 * @returns The module's exports
 */
export type ModuleLoader = (url: string, root?: string) => Promise<Record<string, unknown>>;

/**
 * The default {@linkcode ModuleLoader}: a real import of the project's
 * TypeScript through `tsx`, with the project's own configuration.
 *
 * @param url - Absolute module URL to import
 * @returns The module's exports
 */
export const importModule: ModuleLoader = importProjectModule;

/**
 * Whether `name` can name a custom schematic: one file name under
 * {@linkcode CUSTOM_SCHEMATIC_DIR}, never a path.
 *
 * A separator, a dot segment or a percent escape would let
 * `setu g custom ../../x` import — and execute — a module outside the project's
 * schematics directory, because the URL builder normalises `..`.
 *
 * @param name - The requested schematic name
 * @returns `true` for letters, digits, `-` and `_`, starting alphanumerically
 */
export function isCustomSchematicName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name);
}

/**
 * Resolves the module URL a custom schematic is loaded from.
 *
 * @param dir - The project root the CLI is operating on (absolute)
 * @param name - The schematic name
 * @returns An absolute `file:` URL
 */
export function customSchematicUrl(dir: string, name: string): string {
  return toFileUrl(joinPath(dir, CUSTOM_SCHEMATIC_DIR, `${name}.ts`));
}

/**
 * Loads a custom schematic and validates its exported shape.
 *
 * The module must export a `schematic` function (or a default export that is a
 * function) matching {@linkcode Schematic}.
 *
 * @param dir - The project root the CLI is operating on (absolute)
 * @param name - The schematic name, without the `.ts` extension
 * @param load - The module loader; defaults to a real import through `tsx`
 * @returns The loaded schematic function
 * @throws {Error} If the module cannot be imported, or exports no `schematic`
 * function — the message names the expected path and export
 */
export async function loadCustomSchematic(
  dir: string,
  name: string,
  load: ModuleLoader = importModule,
): Promise<Schematic> {
  if (!isCustomSchematicName(name)) {
    throw new Error(
      `Invalid custom schematic name "${escapeName(name)}": use letters, digits, "-" and "_"`,
    );
  }
  const url = customSchematicUrl(dir, name);

  let module: Record<string, unknown>;
  try {
    module = await load(url, dir);
  } catch (cause) {
    throw new Error(
      `Cannot load custom schematic "${escapeName(name)}" from ${url}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }

  const exported = module['schematic'] ?? module['default'];
  if (typeof exported !== 'function') {
    throw new Error(
      `Custom schematic "${escapeName(name)}" (${url}) must export a 'schematic' function ` +
        `of type (names, options) => GeneratedFile[]; found ${typeof exported}.`,
    );
  }

  return exported as Schematic;
}
