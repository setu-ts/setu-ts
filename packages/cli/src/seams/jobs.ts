/** Functional queue processors, built from the application's service registry. */
import { artifactNames } from '../utils/artifact-path.ts';

import type { SeamArtifacts, SeamSpec } from './seam-spec.ts';
import {
  assembleSeamBarrel,
  renderExportedArray,
  renderSeamImports,
  seamHeader,
  seamNames,
} from './seam-spec.ts';
import type { DerivedNames } from '../utils/names.ts';

/** Barrel export consumed by `QueuePlugin({ processors })`. */
export const QUEUE_PROCESSORS_EXPORT = 'QUEUE_PROCESSORS';

function importSymbols(names: DerivedNames): readonly string[] {
  return [`create${names.pascal}JobProcessor`];
}

function renderJobsBarrel(artifacts: SeamArtifacts): string {
  const names = seamNames(artifacts, 'job');
  return assembleSeamBarrel(
    seamHeader('setu generate job', [
      `QueuePlugin({ processors: [...${QUEUE_PROCESSORS_EXPORT}] })`,
    ]),
    [
      `import type { QueueProcessorEntry } from '@setu-ts/queue-plugin';`,
      renderSeamImports(names, importSymbols, (kebab) => `./${kebab}.job.ts`),
    ]
      .filter((line) => line !== '')
      .join('\n\n'),
    [
      renderExportedArray(
        QUEUE_PROCESSORS_EXPORT,
        'QueueProcessorEntry',
        names.map((name) => `create${artifactNames(name).pascal}JobProcessor`),
      ),
    ],
  );
}

/** A processor polls its own job name, just as the decorated ingress processor does. */
export const JOBS_SEAM: SeamSpec = {
  schematic: 'job',
  dir: 'src/jobs',
  suffix: '.job.ts',
  barrel: 'src/jobs/index.ts',
  exports: [QUEUE_PROCESSORS_EXPORT],
  requiresPlugin: 'queue-plugin',
  importSymbols,
  renderBarrel: renderJobsBarrel,
};
