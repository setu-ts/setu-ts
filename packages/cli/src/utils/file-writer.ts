/**
 * File writing utility that handles overwrite checks and directory creation.
 *
 * @module
 */

import type { IFileSystem } from '@hono-enterprise/common';

/**
 * Represents a generated file with path and contents.
 */
export interface GeneratedFile {
  /** The relative or absolute path where the file should be written. */
  readonly path: string;
  /** The file contents as a string. */
  readonly contents: string;
}

/**
 * Options for the file writer.
 */
interface FileWriterOptions {
  readonly fs: IFileSystem;
  readonly dryRun?: boolean;
}

/**
 * Creates a file writer function.
 *
 * @param options - Configuration including the filesystem and dry-run mode
 * @returns A function that writes generated files in order, creating parent directories
 */
export function createWriter(
  { fs, dryRun = false }: FileWriterOptions,
): (files: readonly GeneratedFile[]) => Promise<void> {
  return async (files: readonly GeneratedFile[]) => {
    // Check for existing files first (prevent overwrites)
    const existingPaths: string[] = [];
    for (const file of files) {
      try {
        const stat = await fs.stat(file.path);
        if (stat.isFile) {
          existingPaths.push(file.path);
        }
      } catch {
        // File doesn't exist, which is fine
      }
    }

    if (existingPaths.length > 0) {
      throw new Error(
        `The following files already exist and would be overwritten:\n${
          existingPaths.map((p) => `  ${p}`).join('\n')
        }`,
      );
    }

    // Collect unique directories to create
    const dirsToCreate = new Set<string>();
    for (const file of files) {
      const parts = file.path.split('/').filter((p) => p !== '');
      for (let i = 1; i < parts.length; i++) {
        dirsToCreate.add(parts.slice(0, i).join('/'));
      }
    }

    // Create directories
    for (const dir of dirsToCreate) {
      if (!dryRun) {
        await fs.mkdir(dir, { recursive: true });
      }
    }

    // Write files (dry run only prints)
    for (const file of files) {
      if (dryRun) {
        console.log(`would create ${file.path}`);
      } else {
        await fs.writeFile(file.path, new TextEncoder().encode(file.contents));
      }
    }
  };
}
