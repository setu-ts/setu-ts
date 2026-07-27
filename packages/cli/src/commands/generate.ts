/**
 * Implementation of the `honoe generate` command — code generation.
 *
 * @module
 */

import { deriveNames } from '../utils/names.ts';
import { detectPlugins } from '../utils/plugin-detector.ts';
import { createWriter } from '../utils/file-writer.ts';
import { getSchematic, type Schematic, type SchematicOptions } from '../schematics/registry.ts';
import { loadCustomSchematic } from '../schematics/custom.ts';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, PROGRAM_NAME } from '../constants.ts';
import { parseArgs } from '../args.ts';
import type { IFileSystem, IRuntimeServices } from '@hono-enterprise/common';

/**
 * Handles the `honoe generate` command.
 *
 * Generates a file (or multiple files) based on the specified schematic.
 * Schematics can be built-in or custom (from .hono-enterprise/schematics/).
 *
 * @param args - Array of command-line arguments (excluding command name)
 * @param options - Optional configuration (dir, runtime, dryRun)
 * @returns Exit code (0 for success, 1 for error, 2 for usage)
 */
interface GenerateCommandOptions {
  runtime?: IRuntimeServices;
  dir?: string;
  dryRun?: boolean;
}

export async function runGenerateCommand(
  args: readonly string[],
  options: GenerateCommandOptions = {},
): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.positionals.length < 2) {
    console.error(`Usage: ${PROGRAM_NAME} generate <schematic> <name>`);
    return EXIT_USAGE;
  }

  const schematicName = parsed.positionals[0];
  const name = parsed.positionals[1];
  const names = deriveNames(name);

  // Get schematic - built-in or custom
  let schematic: Schematic;
  if (schematicName === 'custom') {
    if (parsed.positionals.length < 3) {
      console.error('Usage: honoe generate custom <name>');
      return EXIT_USAGE;
    }
    const customName = parsed.positionals[2];
    const fs = options.runtime?.fs || ({} as IFileSystem);
    try {
      schematic = await loadCustomSchematic(customName, {
        fs,
        ...(options.dir ? { dir: options.dir } : {}),
        runtime: options.runtime!,
      });
    } catch (e) {
      console.error(`Error loading custom schematic: ${(e as Error).message}`);
      return EXIT_ERROR;
    }
  } else {
    const metadata = getSchematic(schematicName);
    if (!metadata) {
      console.error(`Unknown built-in schematic: ${schematicName}`);
      return EXIT_USAGE;
    }
    schematic = metadata.factory;

    if (metadata.requiresPlugin) {
      const fsForDetect = options.runtime?.fs;
      if (!fsForDetect) {
        console.error('File system access required for plugin detection');
        return EXIT_ERROR;
      }
      const plugins = await detectPlugins(fsForDetect, options.dir);
      if (!plugins.has(metadata.requiresPlugin)) {
        console.error(
          `Schematic "${schematicName}" requires the "${metadata.requiresPlugin}" plugin. Please install it and try again.`,
        );
        return EXIT_ERROR;
      }
    }
  }

  const fsForPlugins = options.runtime?.fs;
  if (!fsForPlugins) {
    console.error('File system access required');
    return EXIT_ERROR;
  }
  const pluginSet = await detectPlugins(fsForPlugins, options.dir);
  const schematicOptions: SchematicOptions = {
    runtime: options.runtime!,
    plugins: pluginSet,
  };

  // The schematic returns a readonly array; we only iterate over it
  const generatedFiles = schematic(names, schematicOptions);

  // Overwrite check before writing
  const existingPaths: string[] = [];
  for (const file of generatedFiles) {
    try {
      const stat = await options.runtime!.fs!.stat(file.path);
      if (stat.isFile) {
        existingPaths.push(file.path);
      }
    } catch {
      // File doesn't exist or is inaccessible - continue checking other files
    }
  }

  if (existingPaths.length > 0) {
    console.error(
      `The following files already exist and would be overwritten:\n${
        existingPaths.map((p) => `  ${p}`).join('\n')
      }`,
    );
    return EXIT_ERROR;
  }

  if (options.dryRun) {
    for (const file of generatedFiles) {
      console.log(`would create ${file.path}`);
    }
    return EXIT_OK;
  }

  const writer = createWriter({
    fs: options.runtime!.fs!,
    dryRun: false,
  });

  try {
    await writer(generatedFiles);
    return EXIT_OK;
  } catch (e) {
    console.error(`Error writing files: ${(e as Error).message}`);
    return EXIT_ERROR;
  }
}
