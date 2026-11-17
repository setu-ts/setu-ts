import { CAPABILITIES, withRateLimitMetadata, withResponseMetadata } from '@setu-ts/common';
import { requireScopes, rateLimitMiddleware } from '@setu-ts/auth-plugin';
import { idempotent } from '@setu-ts/idempotency-plugin';
import { mcpTool } from '@setu-ts/mcp-plugin';
import type {
  IConfig,
  IRouterApi,
  IRuntimeServices,
  IServiceRegistry,
  MiddlewareFunction,
} from '@setu-ts/common';
import { notFound } from '@setu-ts/exceptions';
import { validateBody, validateParams, validateQuery } from '@setu-ts/validation-plugin';
import {
  CreateItemsBody,
  ArchiveItemsBody,
  ItemsListResponse,
  ItemsParams,
  ItemsResponse,
  ListItemsQuery,
  UpdateItemsBody,
} from './items.schemas.ts';

import { createItemsService } from './items.service.ts';

import { archiveQuota } from './items.quota.ts';

const createBody = validateBody(CreateItemsBody);
const updateBody = validateBody(UpdateItemsBody);
const listQuery = validateQuery(ListItemsQuery);
const params = validateParams(ItemsParams);
const archiveBody = validateBody(ArchiveItemsBody);

// Config is available after bootstrap; each route owns its own limiter. The
// wrapper carries the limiter's brand itself, so the OpenAPI document lists
// the 429 and its headers (the inner limiter's brand never reaches the route).
function toolRateLimit(): MiddlewareFunction {
  let limiter: MiddlewareFunction | undefined;
  return withRateLimitMetadata(
    (ctx, next) => {
      limiter ??= rateLimitMiddleware({
        windowMs: 60_000,
        max: ctx.services.get<IConfig>(CAPABILITIES.CONFIG).getOrThrow<number>('MCP_RATE_MAX'),
      });
      return limiter(ctx, next);
    },
    { standardHeaders: true },
  );
}

/** Registers the items feature routes. */
export function registerItemsRoutes(router: IRouterApi, services?: IServiceRegistry): void {
  void services;
  const { createItems, getItems, listItems, updateItems, archiveItems } = createItemsService();
  const quota = archiveQuota();
  router.group('/items', (routes) => {
    routes.get('/', {
      middleware: [
        requireScopes('items:read'),
        toolRateLimit(),
        listQuery,
        mcpTool({
          name: 'list_items',
          description: 'List items, optionally filtering archived records',
        }),
      ],
      schema: { response: { 200: ItemsListResponse } },
      handler: (ctx) =>
        ctx.response.json({
          items: listItems(listQuery.value(ctx)),
        }),
    });
    routes.get('/:id', {
      middleware: [
        requireScopes('items:read'),
        toolRateLimit(),
        params,
        mcpTool({ name: 'read_item', description: 'Read one item by id' }),
      ],
      schema: { response: { 200: ItemsResponse } },
      handler: (ctx) => {
        const id = params.value(ctx).id;
        const record = getItems(id);
        if (record === undefined) throw notFound('Items not found.');
        return ctx.response.json(record);
      },
    });
    routes.post('/', {
      middleware: [
        requireScopes('items:write'),
        toolRateLimit(),
        createBody,
        idempotent(),
        mcpTool({ name: 'create_item', description: 'Create an item' }),
      ],
      schema: { response: { 201: ItemsResponse } },
      handler: withResponseMetadata(
        (ctx) =>
          ctx.response
            .status(201)
            .json(
              createItems(
                createBody.value(ctx),
                ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME),
              ),
            ),
        { status: 201 },
      ),
    });
    routes.post('/:id/archive', {
      middleware: [
        requireScopes('items:write'),
        toolRateLimit(),
        params,
        archiveBody,
        idempotent(),
        quota,
        mcpTool({ name: 'archive_item', description: 'Archive an item for two daily quota units' }),
      ],
      schema: { response: { 200: ItemsResponse } },
      handler: (ctx) => {
        const id = params.value(ctx).id;
        const record = archiveItems(id, archiveBody.value(ctx));
        if (record === undefined) throw notFound('Items not found.');
        return ctx.response.json(record);
      },
    });
    routes.patch('/:id', {
      middleware: [requireScopes('items:write'), toolRateLimit(), params, updateBody],
      schema: { response: { 200: ItemsResponse } },
      handler: (ctx) => {
        const id = params.value(ctx).id;
        const record = updateItems(id, updateBody.value(ctx));
        if (record === undefined) throw notFound('Items not found.');
        return ctx.response.json(record);
      },
    });
  });
}
