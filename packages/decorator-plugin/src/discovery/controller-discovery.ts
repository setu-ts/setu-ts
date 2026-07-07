/**
 * Controller discovery — auto-discovers decorated controller and service
 * classes from the file system, eliminating manual class lists.
 *
 * All file operations go through `IRuntimeServices.fs` (no `Deno`/`fs`/`process`
 * imports); dynamic module loading uses `await import(specifier)` (no
 * `require()`, `eval()`, or `new Function()`). Discovery failures never crash
 * the application — they are reported as warnings and skipped.
 *
 * @module
 */
import type { Constructor, IFileSystem, IRuntimeServices } from '@hono-enterprise/common';

import { metadataStore } from '../metadata/metadata-store.ts';
import type { MetadataStore } from '../metadata/metadata-store.ts';

/**
 * Discovery configuration.
 *
 * @since 0.1.0
 */
export interface DiscoveryOptions {
  /** Directory path to scan (relative or absolute). */
  readonly path: string;
  /** File extensions to include (default: `['.ts', '.mts', '.js', '.mjs']`). */
  readonly extensions?: readonly string[];
  /** Glob patterns to exclude (default: test/spec files). */
  readonly exclude?: readonly string[];
}

/**
 * Result of a discovery scan.
 *
 * @since 0.1.0
 */
export interface DiscoveryResult {
  /** Discovered controller classes. */
  readonly controllers: readonly Constructor[];
  /** Discovered service classes. */
  readonly services: readonly Constructor[];
  /** Files that failed to import, with error messages. */
  readonly errors: ReadonlyArray<{ readonly file: string; readonly error: string }>;
}

/**
 * Loads a module from a specifier. Defaults to the global dynamic `import`;
 * injectable for tests.
 *
 * @since 0.1.0
 */
export type ModuleImporter = (specifier: string) => Promise<unknown>;

/** Default file extensions scanned by discovery. */
const DEFAULT_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs'] as const;

/** Default exclusion globs (test files are not controllers). */
const DEFAULT_EXCLUDE = ['*.test.ts', '*.spec.ts', '*.test.js', '*.spec.js'] as const;

/**
 * Converts an absolute file path to a `file://` URL for dynamic import.
 *
 * @param path - Absolute or `file://` path
 * @returns A `file://` URL
 * @since 0.1.0
 */
export function toFileUrl(path: string): string {
  if (path.startsWith('file://')) {
    return path;
  }
  if (path.startsWith('/')) {
    return 'file://' + path;
  }
  return 'file:///' + path;
}

/**
 * Tests whether a file name matches a glob pattern supporting `*`.
 *
 * @param pattern - Glob pattern (e.g. `*.test.ts`)
 * @param name - File name
 * @returns `true` on match
 * @since 0.1.0
 */
export function globMatch(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$').test(name);
}

/** Joins a directory path and entry name with a single slash. */
function joinPath(dir: string, entry: string): string {
  return dir.endsWith('/') ? dir + entry : dir + '/' + entry;
}

/** Reports whether a name ends with one of the given extensions. */
function matchesExtension(name: string, extensions: readonly string[]): boolean {
  return extensions.some((ext) => name.endsWith(ext));
}

/** Reports whether a name matches any exclusion glob. */
function matchesExclude(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globMatch(p, name));
}

/**
 * Recursively walks a directory, returning the paths of files matching the
 * extension/exclude filters. Directories starting with `.` or named
 * `node_modules` are skipped.
 *
 * @param dir - Directory to walk
 * @param fs - File system abstraction
 * @param extensions - Extensions to include
 * @param exclude - Exclusion globs
 * @returns Matching file paths
 * @throws {Error} If the directory cannot be read
 */
export async function walkDirectory(
  dir: string,
  fs: IFileSystem,
  extensions: readonly string[],
  exclude: readonly string[],
): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(dir);
  for (const entry of entries) {
    const fullPath = joinPath(dir, entry);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      // Skip entries that cannot be stat'd (broken symlinks, permissions).
      continue;
    }
    if (stat.isDirectory) {
      if (!entry.startsWith('.') && entry !== 'node_modules') {
        const sub = await walkDirectory(fullPath, fs, extensions, exclude);
        files.push(...sub);
      }
    } else if (stat.isFile) {
      if (matchesExtension(entry, extensions) && !matchesExclude(entry, exclude)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

/**
 * Discovers decorated classes by scanning a directory and importing files.
 *
 * Before each import, the current controller/service keys are snapshotted;
 * after the import, any newly-appeared keys are attributed to that file. This
 * captures decorator side effects regardless of how the module exports its
 * classes.
 *
 * @param options - Discovery configuration
 * @param runtime - Runtime services for file I/O
 * @param store - Metadata store to diff against (defaults to the singleton)
 * @param importer - Module loader (defaults to the global dynamic `import`)
 * @returns Discovered controllers, services, and any import errors
 * @since 0.1.0
 */
export async function discoverControllers(
  options: DiscoveryOptions,
  runtime: IRuntimeServices,
  store: MetadataStore = metadataStore,
  importer: ModuleImporter = (specifier: string): Promise<unknown> => import(specifier),
): Promise<DiscoveryResult> {
  const fs = runtime.fs;
  if (fs === undefined) {
    return {
      controllers: [],
      services: [],
      errors: [{ file: options.path, error: 'File system not available on this runtime' }],
    };
  }

  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;

  let files: string[];
  try {
    files = await walkDirectory(options.path, fs, extensions, exclude);
  } catch (error) {
    return {
      controllers: [],
      services: [],
      errors: [
        {
          file: options.path,
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const beforeControllers = new Set(store.controllers.keys());
  const beforeServices = new Set(store.services.keys());
  const controllers = new Set<Constructor>();
  const services = new Set<Constructor>();
  const errors: { file: string; error: string }[] = [];

  for (const file of files) {
    try {
      await importer(toFileUrl(file));
      for (const key of store.controllers.keys()) {
        if (!beforeControllers.has(key)) {
          controllers.add(key);
        }
      }
      for (const key of store.services.keys()) {
        if (!beforeServices.has(key)) {
          services.add(key);
        }
      }
    } catch (error) {
      errors.push({
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    controllers: [...controllers],
    services: [...services],
    errors,
  };
}
