/**
 * Job schematic — a job processor usable by the queue or scheduler plugin.
 *
 * Functional projects with queue-plugin emit a processor factory and jobs barrel.
 * Without queue-plugin the transport-agnostic function remains standalone.
 * Class-based projects emit a decorated processor through the ingress seam.
 *
 * Class-based projects require queue-plugin; the command refuses before writing
 * when that provider is absent. Functional projects keep the standalone function.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { ingressNames, INGRESS_SEAM } from '../seams/ingress.ts';
import { JOBS_SEAM } from '../seams/jobs.ts';
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
    const ingress = ingressNames(names, 'job');
    return [
      {
        path: `${INGRESS_SEAM.dir}/${ingress.kebab}${INGRESS_SEAM.suffix}`,
        contents: `import type { IJob } from '@setu-ts/common';
import { Processor } from '@setu-ts/decorator-plugin';

/** Name the queue address this job consumes. */
export const ${names.screaming}_JOB = '${names.kebab}';

/** Payload accepted by the ${names.kebab} job. */
export interface ${names.pascal}JobData {
  readonly id: string;
}

/** Decorated queue processor, registered through the ingress barrel. */
export class ${ingress.pascal}Ingress {
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
          ingress: seamNames(options.artifacts, 'ingress', ingress.kebab),
        }),
        managed: true,
      },
    ];
  }
  if (options.plugins.has('queue-plugin')) {
    return [
      {
        path: `${JOBS_SEAM.dir}/${names.kebab}${JOBS_SEAM.suffix}`,
        contents: `import type { IServiceRegistry } from '@setu-ts/common';
import type { QueueProcessorDefinition } from '@setu-ts/queue-plugin';

/** Name the queue address this job consumes. */
export const ${names.screaming}_JOB = '${names.kebab}';

/** Payload accepted by the ${names.kebab} job. */
export interface ${names.pascal}JobData {
  readonly id: string;
}

/** Builds the processor at onInit, after every plugin has registered its services. */
export function create${names.pascal}JobProcessor(
  services: IServiceRegistry,
): QueueProcessorDefinition<${names.pascal}JobData> {
  // Resolve dependencies from services here, before processing begins.
  void services;
  return {
    name: ${names.screaming}_JOB,
    async processor(job): Promise<void> {
      // Replace with the job's real work.
      await Promise.resolve(job.data.id);
    },
  };
}
`,
      },
      {
        path: JOBS_SEAM.barrel,
        contents: JOBS_SEAM.renderBarrel({ job: seamNames(options.artifacts, 'job', names.kebab) }),
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
 * choice only you can make. Register it in \`setu.config.ts\` with ONE of:
 *
 * \`\`\`typescript
 * import {
 *   ${names.screaming}_JOB,
 *   run${names.pascal}Job,
 *   type ${names.pascal}JobData,
 * } from './src/jobs/${names.kebab}.job.ts';
 *
 * // Queue work — a producer calls queue.add(${names.screaming}_JOB, data) elsewhere.
 * QueuePlugin({
 *   processors: [
 *     {
 *       name: ${names.screaming}_JOB,
 *       processor: (job) => run${names.pascal}Job(job.data as ${names.pascal}JobData),
 *     },
 *   ],
 * }),
 *
 * // Scheduled work — the expression is yours; this one is every day at 02:00 UTC.
 * SchedulerPlugin({
 *   jobs: [
 *     {
 *       trigger: 'cron',
 *       name: ${names.screaming}_JOB,
 *       expression: '0 2 * * *',
 *       handler: () => run${names.pascal}Job({ id: '' }),
 *     },
 *   ],
 * }),
 * \`\`\`
 *
 * Replace the existing \`QueuePlugin()\` or \`SchedulerPlugin()\` call rather than
 * adding a second one: the kernel refuses a duplicate plugin name.
 * \`SchedulerPlugin\` is unavailable on Cloudflare Workers (it refuses to start
 * there); use a Cron Trigger through \`@setu-ts/cloudflare-plugin\` instead.
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
