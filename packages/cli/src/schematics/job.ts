/**
 * Job schematic — a job processor usable by the queue or scheduler plugin.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a job module.
 *
 * @param names - Naming forms derived from the user's input
 * @param _options - Unused: jobs are runtime-agnostic
 * @returns One file at `src/jobs/<kebab>.job.ts`
 */
export function generateJob(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `/** Name the queue or scheduler addresses this job by. */
export const ${names.screaming}_JOB = '${names.kebab}';

/** The payload this job accepts. */
export interface ${names.pascal}JobData {
  /** Replace with the job's real payload. */
  readonly id: string;
}

/**
 * Runs the ${names.kebab} job.
 *
 * Register it with \`queue.process(${names.screaming}_JOB, (job) => run${names.pascal}Job(job.data))\`
 * or schedule it with \`scheduler.cron(${names.screaming}_JOB, expression, handler)\`.
 *
 * @param data - The job payload
 */
export async function run${names.pascal}Job(data: ${names.pascal}JobData): Promise<void> {
  // Replace with the job's real work.
  await Promise.resolve(data);
}
`;
  return [{ path: `src/jobs/${names.kebab}.job.ts`, contents }];
}
