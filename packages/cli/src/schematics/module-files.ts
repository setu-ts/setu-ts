/** Feature-module source bodies, shared with the REST showcase. @module */
import type { DerivedNames } from './registry.ts';
import { routeRegistrarSymbol } from '../seams/http.ts';
import { renderImport, renderSeamImports } from '../seams/seam-spec.ts';

function schemaImport(names: DerivedNames, symbols: readonly string[], typeOnly = false): string {
  return renderImport(symbols, `./${names.kebab}.schemas.ts`, typeOnly);
}

function cleanSource(source: string): string {
  return source
    .replace(/^[ \t]+\n/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimStart();
}

/** Request and response shapes emitted only with validation installed. */
export function moduleSchemas(names: DerivedNames): string {
  const p = names.pascal;
  return cleanSource(`import { z } from 'zod';

/** Input for a new ${names.kebab} record. */
export const Create${p}Body = z.object({ name: z.string().min(1) });
export type Create${p}Body = z.infer<typeof Create${p}Body>;
export const Update${p}Body = Create${p}Body.partial();
export type Update${p}Body = z.infer<typeof Update${p}Body>;
export const List${p}Query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type List${p}Query = z.infer<typeof List${p}Query>;
export const ${p}Params = z.object({ id: z.string().min(1) });
export type ${p}Params = z.infer<typeof ${p}Params>;
export const ${p}Response = Create${p}Body.extend({ id: z.string() });
export type ${p}Response = z.infer<typeof ${p}Response>;
export const ${p}ListResponse = z.object({ items: z.array(${p}Response) });
export type ${p}ListResponse = z.infer<typeof ${p}ListResponse>;
`);
}

/** In-memory CRUD service; replace the store with a repository. */
export function moduleService(
  names: DerivedNames,
  validation: boolean,
  classBased = false,
): string {
  const p = names.pascal;
  const record = validation ? `${p}Response` : 'Record<string, unknown>';
  const create = validation ? `Create${p}Body` : 'Record<string, unknown>';
  const update = validation ? `Update${p}Body` : 'Record<string, unknown>';
  const query = validation
    ? `List${p}Query`
    : '{ readonly limit?: number; readonly offset?: number }';
  return cleanSource(`${validation ? `${schemaImport(names, [`Create${p}Body`, `Update${p}Body`, `List${p}Query`, `${p}Response`], true)}\n` : ''}${classBased ? "import { Injectable } from '@setu-ts/decorator-plugin';\n" : ''}
/**
 * Sample storage: replace it with a repository before deploying.
 *
 * This \`Map\` lives in process memory with no size limit, and the generated
 * routes that write to it are public — anyone who can reach the application can
 * fill it until the process restarts. Add authentication to the routes and a
 * real store before the module serves real traffic.
 */
const records = new Map<string, ${record}>();

/** Lists records with pagination. */
export function list${p}(
  query: ${query} = ${validation ? '{ limit: 20, offset: 0 }' : '{}'},
): readonly ${record}[] {
  const offset = query.offset ?? 0;
  return [...records.values()].slice(offset, offset + (query.limit ?? 20));
}

/** Reads one record. */
export function get${p}(id: string): ${record} | undefined {
  return records.get(id);
}

/** Creates a record. */
export function create${p}(body: ${create}): ${record} {
  const record = { ...body, id: crypto.randomUUID() };
  records.set(record.id, record);
  return record;
}

/** Updates an existing record. */
export function update${p}(
  id: string,
  body: ${update},
): ${record} | undefined {
  const current = records.get(id);
  if (current === undefined) return undefined;
  const record = { ...current, ...body, ${validation ? 'name: body.name ?? current.name, ' : ''}id };
  records.set(id, record);
  return record;
}
${
  classBased
    ? `
/** Domain service for ${names.kebab}. */
@Injectable({ token: '${names.kebab}-service' })
export class ${p}Service {
  list(
    query?: ${query},
  ): readonly ${record}[] {
    return list${p}(query);
  }
  get(id: string): ${record} | undefined {
    return get${p}(id);
  }
  create(body: ${create}): ${record} {
    return create${p}(body);
  }
  update(id: string, body: ${update}): ${record} | undefined {
    return update${p}(id, body);
  }
}
`
    : ''
}`);
}

/**
 * The statement a generated handler runs when a record is missing.
 *
 * With `@setu-ts/exceptions` installed the handler throws `notFound(...)`, so
 * the application's `errorHandler` answers in its configured format (RFC 9457
 * in every REST-based template). Without it a thrown error would reach the
 * kernel as an unhandled 500, so the handler answers the kernel's own default
 * error shape, `{ error, detail }`, directly.
 */
function notFoundStatement(pascal: string, exceptions: boolean): string {
  // A fixed detail: the caller-supplied id reached the Problem Details body and
  // the warn log, so a hostile value was rendered back to its sender. The
  // request logger already records the path.
  const detail = `'${pascal} not found.'`;
  return exceptions
    ? `throw notFound(${detail});`
    : `return ctx.response.status(404).json({ error: 'Not Found', detail: ${detail} });`;
}

/** Functional CRUD routes with sibling service and schema imports. */
export function moduleRoutes(
  names: DerivedNames,
  validation: boolean,
  exceptions: boolean,
): string {
  const p = names.pascal;
  const schemas = [
    `Create${p}Body`,
    `Update${p}Body`,
    `List${p}Query`,
    `${p}Params`,
    `${p}Response`,
    `${p}ListResponse`,
  ];
  const options = (validator: string, response: string, status = 200): string =>
    validation
      ? `middleware: [${validator}],\n      schema: { response: { ${status}: ${response} } },`
      : '';
  return cleanSource(`import type { IRouterApi, IServiceRegistry } from '@setu-ts/common';
${exceptions ? "import { notFound } from '@setu-ts/exceptions';\n" : ''}${validation ? `import { validateBody, validateParams, validateQuery } from '@setu-ts/validation-plugin';\n${schemaImport(names, schemas)}\n` : ''}
${renderSeamImports(
  [names.kebab],
  () => [`list${p}`, `get${p}`, `create${p}`, `update${p}`],
  (name) => `./${name}.service.ts`,
)}

${validation ? `const createBody = validateBody(Create${p}Body);\nconst updateBody = validateBody(Update${p}Body);\nconst listQuery = validateQuery(List${p}Query);\nconst params = validateParams(${p}Params);\n` : ''}
/** Registers the ${names.kebab} feature routes. */
export function ${routeRegistrarSymbol(names)}(router: IRouterApi, services?: IServiceRegistry): void {
  void services;
  router.group('/${names.kebab}', (routes) => {
    routes.get('/', {
      ${options('listQuery', `${p}ListResponse`)}
      handler: (ctx) =>
        ctx.response.json({
          items: list${p}(${validation ? 'listQuery.value(ctx)' : ''}),
        }),
    });
    routes.get('/:id', {
      ${options('params', `${p}Response`)}
      handler: (ctx) => {
        const id = ${validation ? 'params.value(ctx).id' : "ctx.params['id'] ?? ''"};
        const record = get${p}(id);
        if (record === undefined) ${notFoundStatement(p, exceptions)}
        return ctx.response.json(record);
      },
    });
    routes.post('/', {
      ${options('createBody', `${p}Response`, 201)}
      handler: ${validation ? '' : 'async '}(ctx) =>
        ctx.response.status(201).json(
          create${p}(${validation ? 'createBody.value(ctx)' : 'await ctx.request.json<Record<string, unknown>>()'}),
        ),
    });
    routes.patch('/:id', {
      ${validation ? `middleware: [params, updateBody],\n      schema: { response: { 200: ${p}Response } },` : ''}
      handler: ${validation ? '' : 'async '}(ctx) => {
        const id = ${validation ? 'params.value(ctx).id' : "ctx.params['id'] ?? ''"};
        const record = update${p}(id, ${validation ? 'updateBody.value(ctx)' : 'await ctx.request.json<Record<string, unknown>>()'});
        if (record === undefined) ${notFoundStatement(p, exceptions)}
        return ctx.response.json(record);
      },
    });
  });
}
`);
}

/** Decorated CRUD controller reading the same schema-backed values. */
export function moduleController(
  names: DerivedNames,
  validation: boolean,
  exceptions: boolean,
): string {
  const p = names.pascal;
  const responseDecorator = p === 'Api' ? 'apiResponse' : 'ApiResponse';
  const record = validation ? `${p}Response` : 'Record<string, unknown>';
  const create = validation ? `Create${p}Body` : 'Record<string, unknown>';
  const update = validation ? `Update${p}Body` : 'Record<string, unknown>';
  return cleanSource(`${renderSeamImports(
    [names.kebab],
    () => [
      'Body',
      'Controller',
      'Ctx',
      'Get',
      'Inject',
      'Params',
      'Patch',
      'Param',
      'Post',
      ...(validation
        ? [
            p === 'Api' ? 'ApiResponse as apiResponse' : 'ApiResponse',
            'Query',
            'ValidateBody',
            'ValidateQuery',
            'ValidateParams',
          ]
        : []),
    ],
    () => '@setu-ts/decorator-plugin',
  )}
${exceptions ? "import { notFound } from '@setu-ts/exceptions';\n" : ''}import type { IRequestContext } from '@setu-ts/common';
import type { ${p}Service } from './${names.kebab}.service.ts';
${validation ? schemaImport(names, [`Create${p}Body`, `Update${p}Body`, `List${p}Query`, `${p}Params`, `${p}Response`, `${p}ListResponse`]) : ''}

/** HTTP controller for the ${names.kebab} feature. */
@Controller('/${names.kebab}')
@Inject('${names.kebab}-service')
export class ${p}Controller {
  constructor(private readonly service: ${p}Service) {}

  @Get('/')
  ${validation ? `@ValidateQuery(List${p}Query)\n  @${responseDecorator}({ status: 200, schema: ${p}ListResponse })\n  @Params(Query<List${p}Query>())` : ''}
  list(${validation ? `query: List${p}Query` : ''}): { readonly items: readonly ${record}[] } {
    return { items: this.service.list(${validation ? 'query' : ''}) };
  }

  @Get('/:id')
  ${validation ? `@ValidateParams(${p}Params)\n  @${responseDecorator}({ status: 200, schema: ${p}Response })` : ''}
  @Params(Param('id'), Ctx())
  get(id: string, ctx: IRequestContext): unknown {
    const record = this.service.get(id);
    if (record === undefined) ${notFoundStatement(p, exceptions)}
    return ctx.response.json(record);
  }

  @Post('/')
  ${validation ? `@ValidateBody(Create${p}Body)\n  @${responseDecorator}({ status: 201, schema: ${p}Response })` : ''}
  @Params(Body<${create}>(), Ctx())
  create(body: ${create}, ctx: IRequestContext): unknown {
    return ctx.response.status(201).json(this.service.create(body));
  }

  @Patch('/:id')
  ${validation ? `@ValidateParams(${p}Params)\n  @ValidateBody(Update${p}Body)\n  @${responseDecorator}({ status: 200, schema: ${p}Response })` : ''}
  @Params(Param('id'), Body<${update}>(), Ctx())
  update(id: string, body: ${update}, ctx: IRequestContext): unknown {
    const record = this.service.update(id, body);
    if (record === undefined) ${notFoundStatement(p, exceptions)}
    return ctx.response.json(record);
  }
}
`);
}
