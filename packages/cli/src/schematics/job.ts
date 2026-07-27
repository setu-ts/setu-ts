/**
 * Job schematic — generates a job class (ungated).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a job file.
 */
export function generateJob(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const jobName = names.pascal + 'Job';
  const fileName = `src/jobs/${names.kebab}.job.ts`;
  const contents = `export class ${jobName} {\n  async execute() {\n    // Job logic\n  }\n}\n`;
  return [{ path: fileName, contents }];
}
