import { CAPABILITIES, isNone } from '@setu-ts/common';
import type { ILogger, IMultiTenancyService, IServiceRegistry } from '@setu-ts/common';
import type { QueueProcessorDefinition } from '@setu-ts/queue-plugin';
import { documentsDependencies, indexDocument } from '../modules/documents/documents.service.ts';
import type { IngestDocumentsBody } from '../modules/documents/documents.schemas.ts';

/** Name the queue address this job consumes. */
export const INGEST_DOCUMENT_JOB = 'ingest-document';

/** Payload accepted by the ingest-document job. */
export interface IngestDocumentJobData extends IngestDocumentsBody {
  /** The tenant the request resolved; re-checked here, since a job runs later. */
  readonly tenant: string;
}

/** Builds the processor at onInit, after every plugin has registered its services. */
export function createIngestDocumentJobProcessor(
  services: IServiceRegistry,
): QueueProcessorDefinition<IngestDocumentJobData> {
  const deps = documentsDependencies(services);
  const tenancy = services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
  const logger = services.get<ILogger>(CAPABILITIES.LOGGER);
  return {
    name: INGEST_DOCUMENT_JOB,
    async processor(job): Promise<void> {
      const { tenant, ...document } = job.data;
      // A tenant removed after the request was queued gets nothing written.
      const found = await tenancy.lookupTenant(tenant);
      if (isNone(found)) {
        logger.warn('ingest-document: tenant no longer exists; job dropped', {
          documentId: document.id,
        });
        return;
      }
      const chunks = await indexDocument(deps, found.value.id, document);
      logger.info('ingest-document: indexed', { documentId: document.id, chunks });
    },
  };
}
