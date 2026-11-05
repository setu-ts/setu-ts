import { CAPABILITIES } from '@setu-ts/common';
import type { IQueue, IRouterApi, IRuntimeServices, IServiceRegistry } from '@setu-ts/common';
import { validateBody, validateHeaders, validateQuery } from '@setu-ts/validation-plugin';
import { INGEST_DOCUMENT_JOB } from '../../jobs/ingest-document.job.ts';
import type { IngestDocumentJobData } from '../../jobs/ingest-document.job.ts';
import {
  DocumentsAcceptedResponse,
  DocumentsSearchResponse,
  DocumentsTenantHeaders,
  IngestDocumentsBody,
  SearchDocumentsQuery,
} from './documents.schemas.ts';

import { documentsDependencies, searchDocuments } from './documents.service.ts';

const tenantHeaders = validateHeaders(DocumentsTenantHeaders);
const ingestBody = validateBody(IngestDocumentsBody);
const searchQuery = validateQuery(SearchDocumentsQuery);

/**
 * Registers the documents feature routes. Both routes take the vector-store
 * scope from the request's tenant (`x-tenant-id`), so a tenant only ever
 * indexes and searches its own documents; a request without one is a 400.
 * The header is declared with `validateHeaders`, so it appears in the OpenAPI
 * document and Swagger UI.
 *
 * Each submission carries a version — the time it was accepted, bumped past
 * the previous one so two in one millisecond still order — and the job writes
 * under it, so a late retry of an older submission cannot replace a newer one.
 */
export function registerDocumentsRoutes(router: IRouterApi, services?: IServiceRegistry): void {
  if (services === undefined) throw new Error('documents routes need the service registry');
  let lastVersion = 0;
  const nextVersion = (): number => {
    const now = services.get<IRuntimeServices>(CAPABILITIES.RUNTIME).now();
    lastVersion = Math.max(now, lastVersion + 1);
    return lastVersion;
  };
  router.group('/documents', (routes) => {
    routes.post('/', {
      middleware: [tenantHeaders, ingestBody],
      schema: { response: { 202: DocumentsAcceptedResponse } },
      handler: async (ctx) => {
        const body = ingestBody.value(ctx);
        const tenant = documentsDependencies(services).store.scopeFor(ctx);
        await services
          .get<IQueue>(CAPABILITIES.QUEUE)
          .add<IngestDocumentJobData>(INGEST_DOCUMENT_JOB, {
            ...body,
            tenant,
            version: nextVersion(),
          });
        return ctx.response.status(202).json({ id: body.id, status: 'queued' });
      },
    });
    routes.get('/search', {
      middleware: [tenantHeaders, searchQuery],
      schema: { response: { 200: DocumentsSearchResponse } },
      handler: async (ctx) => {
        const deps = documentsDependencies(services);
        return ctx.response.json(
          await searchDocuments(deps, deps.store.scopeFor(ctx), searchQuery.value(ctx)),
        );
      },
    });
  });
}
