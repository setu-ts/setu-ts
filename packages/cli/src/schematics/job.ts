/**
 * Job schematic — a job processor usable by the queue or scheduler plugin.
 *
 * Deliberately NOT wired: the emitted function is transport-agnostic by design, and
 * the CLI cannot pick a transport for it. Registering it as a queue processor starts a
 * worker loop polling for a job name nothing enqueues, while scheduling it needs a
 * cron expression or interval the artifact does not carry — so either guess produces
 * behaviour the developer did not ask for. `QueuePluginOptions` also publishes no
 * `processors` list a barrel could feed. The emitted JSDoc names both real calls.
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
 * The CLI does not wire this one: whether it is queue work or scheduled work is a
 * choice only you can make, and each needs something this module does not carry — a
 * running consumer, or a schedule. Pick ONE:
 *
 * \`\`\`typescript
 * // Queue work — a producer calls queue.add(${names.screaming}_JOB, data) elsewhere.
 * const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
 * await queue.process(${names.screaming}_JOB, (job) => run${names.pascal}Job(job.data));
 *
 * // Scheduled work — the expression is yours; this one is every day at 02:00 UTC.
 * const scheduler = app.services.get<IScheduler>(CAPABILITIES.SCHEDULER);
 * scheduler.cron(${names.screaming}_JOB, '0 2 * * *', () => run${names.pascal}Job({ id: '' }));
 * \`\`\`
 *
 * Both need a capability that exists only after \`app.start()\`, so a plugin's
 * \`register\` — see \`setu generate plugin\` — is the natural home for the call.
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
