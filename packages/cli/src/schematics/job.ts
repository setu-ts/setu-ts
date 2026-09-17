/**
 * Job schematic — a job processor usable by the queue or scheduler plugin.
 *
 * Functional projects keep the transport-agnostic function: the CLI cannot choose a
 * queue consumer or schedule. Class-based projects instead emit a decorated queue
 * processor and place it in the ingress seam consumed by `DecoratorPlugin`.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { INGRESS_SEAM } from '../seams/ingress.ts';
import { seamNames } from '../seams/seam-spec.ts';
import { generatorMode } from '../utils/generator-mode.ts';

/**
 * Generates a job module.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Selects the functional or class-based registration shape
 * @returns One file at `src/jobs/<kebab>.job.ts`
 */
export function generateJob(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  if (generatorMode(options.plugins) === 'class-based' && options.plugins.has('queue-plugin')) {
    return [
      {
        path: `${INGRESS_SEAM.dir}/${names.kebab}${INGRESS_SEAM.suffix}`,
        contents: `import type { IJob } from '@setu-ts/common';
import { Processor } from '@setu-ts/decorator-plugin';

/** Name the queue address this job consumes. */
export const ${names.screaming}_JOB = '${names.kebab}';

/** Payload accepted by the ${names.kebab} job. */
export interface ${names.pascal}JobData {
  readonly id: string;
}

/** Decorated queue processor, registered through the ingress barrel. */
export class ${names.pascal}Ingress {
  @Processor(${names.screaming}_JOB)
  async process(job: IJob<${names.pascal}JobData>): Promise<void> {
    await Promise.resolve(job.data.id);
  }
}
`,
      },
      {
        path: INGRESS_SEAM.barrel,
        contents: INGRESS_SEAM.renderBarrel({
          ingress: seamNames(options.artifacts, 'ingress', names.kebab),
        }),
        managed: true,
      },
    ];
  }
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
