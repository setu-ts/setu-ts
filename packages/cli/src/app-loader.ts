/**
 * Loading the target project's application factory.
 *
 * This is the one place the CLI imports user code. It resolves
 * `setu.config.ts` (or `--config <path>`), imports it with a REAL dynamic
 * `import()`, and validates that it exports the factory the contract requires
 * — each failure naming the resolved path and what was expected.
 *
 * @module
 */

import type { IApplication } from '@setu-ts/common';
import { CONFIG_EXPORT, CONFIG_MODULE } from './constants.ts';
import { joinPath, toFileUrl } from './utils/file-writer.ts';
import { importModule, type ModuleLoader } from './schematics/custom.ts';
import type { IFileSystem } from '@setu-ts/common';

/**
 * Loads the project's config module by URL.
 *
 * Shares {@linkcode ModuleLoader}'s shape and default implementation — both
 * import an ES module by absolute URL — so there is one lazy-import mechanism
 * in this package, not two.
 */
export type AppLoader = ModuleLoader;

/**
 * Resolves the path of the module the application factory is loaded from.
 *
 * @param dir - The project root (absolute; see `resolveDir`)
 * @param config - The `--config` override, when supplied
 * @returns The absolute path to the config module
 */
export function configModulePath(dir: string, config?: string): string {
  if (config === undefined || config === '') return joinPath(dir, CONFIG_MODULE);
  return config.startsWith('/') ? joinPath(config) : joinPath(dir, config);
}

/**
 * Reports whether the project has a config module at all.
 *
 * Checked separately from loading so "this project has no `setu.config.ts`"
 * can be a distinct, actionable message rather than an import failure.
 *
 * @param fs - The filesystem to probe
 * @param dir - The project root (absolute)
 * @param config - The `--config` override, when supplied
 * @returns True when the module exists
 */
export async function configModuleExists(
  fs: IFileSystem,
  dir: string,
  config?: string,
): Promise<boolean> {
  try {
    await fs.stat(configModulePath(dir, config));
    return true;
  } catch {
    return false;
  }
}

/**
 * Narrows an unknown value to something usable as an application.
 *
 * Validated where the seam is injected rather than at first use, so a config
 * module that returns the wrong thing fails immediately with a clear message
 * instead of throwing somewhere inside dispatch.
 *
 * @param value - The value `createApp()` resolved to
 * @returns True when it carries the members this command needs
 */
function isApplication(value: unknown): value is IApplication {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<IApplication>;
  return typeof candidate.start === 'function' &&
    typeof candidate.stop === 'function' &&
    typeof candidate.services === 'object' && candidate.services !== null;
}

/**
 * Imports the project's config module and calls its factory.
 *
 * The returned application is NOT started: the caller owns the no-socket boot
 * and the guaranteed teardown (see `commands/plugin-commands.ts`).
 *
 * @param dir - The project root (absolute)
 * @param config - The `--config` override, when supplied
 * @param load - The module loader; defaults to a real dynamic `import()`
 * @returns The unstarted application
 * @throws {Error} If the module cannot be imported, exports no
 * {@linkcode CONFIG_EXPORT} function, or that function does not produce an
 * application
 */
export async function loadApp(
  dir: string,
  config?: string,
  load: AppLoader = importModule,
): Promise<IApplication> {
  const url = toFileUrl(configModulePath(dir, config));

  let module: Record<string, unknown>;
  try {
    module = await load(url);
  } catch (cause) {
    throw new Error(
      `Cannot load ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  const factory = module[CONFIG_EXPORT];
  if (typeof factory !== 'function') {
    throw new Error(
      `${url} must export a '${CONFIG_EXPORT}' function returning the application; ` +
        `found ${typeof factory}.`,
    );
  }

  let app: unknown;
  try {
    app = await (factory as () => unknown)();
  } catch (cause) {
    throw new Error(
      `${CONFIG_EXPORT}() in ${url} threw: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }

  if (!isApplication(app)) {
    throw new Error(
      `${CONFIG_EXPORT}() in ${url} must return the application from ` +
        `createApplication(); got ${app === null ? 'null' : typeof app}.`,
    );
  }

  return app;
}
