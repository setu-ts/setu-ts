import { CAPABILITIES } from '@setu-ts/common';
import type { IQueue, IRouterApi, IServiceRegistry } from '@setu-ts/common';
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
 */
export function registerDocumentsRoutes(router: IRouterApi, services?: IServiceRegistry): void {
  if (services === undefined) throw new Error('documents routes need the service registry');
  router.group('/documents', (routes) => {
    routes.post('/', {
      middleware: [tenantHeaders, ingestBody],
      schema: { response: { 202: DocumentsAcceptedResponse } },
      handler: async (ctx) => {
        const body = ingestBody.value(ctx);
        const tenant = documentsDependencies(services).store.scopeFor(ctx);
        await services
          .get<IQueue>(CAPABILITIES.QUEUE)
          .add<IngestDocumentJobData>(INGEST_DOCUMENT_JOB, { ...body, tenant });
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
