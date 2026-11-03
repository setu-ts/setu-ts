/**
 * `setu g module <name>` in a full-stack project (M130 §3.6, §3.8).
 *
 * The module owns its business logic: a request-bound service factory over an
 * in-memory store, a typed token, `/api/<name>` routes that resolve the service
 * with `resolveRequestService`, and a managed index that registers the token
 * (derived from the module-service family, so `setu sync` keeps it). `--page`
 * adds a React Router page whose loader reads the SAME service with
 * `getService`, importing only the type and the token through `~kernel/*`.
 *
 * The generated tests sign a session first: the full-stack template runs session
 * CSRF on every unsafe route, so a POST without the session cookie and token is
 * 403 by design (X91-2). `test/support/session.ts` obtains both from `/login`.
 *
 * @module
 */

import type { TargetRuntime } from '../constants.ts';
import type { DerivedNames } from '../utils/names.ts';
import type { GeneratedFile } from '../utils/file-writer.ts';
import { MODULES_DIR } from '../utils/module-scanner.ts';
import {
  MODULE_SERVICE_ARTIFACTS,
  renderFunctionalModuleBarrel,
  renderFunctionalModuleIndex,
} from '../seams/modules.ts';
import { routeRegistrarSymbol } from '../seams/http.ts';
import { renderEquals, renderTestServer, testHarnessFor } from './test-harness.ts';

/** The page route `--page` writes for a module. */
export function modulePagePath(names: DerivedNames): string {
  return `app/routes/_app/${names.kebab}._index.tsx`;
}

/** Path of the session helper the full-stack module tests import. */
export const SESSION_SUPPORT_PATH = 'test/support/session.ts';

function types(names: DerivedNames): string {
  const p = names.pascal;
  return `/**
 * The ${names.kebab} module's data. Plain types: a page imports them with
 * \`import type\` through \`~kernel/modules/${names.kebab}/${names.kebab}.types.ts\`.
 */

/** One ${names.kebab} record. */
export interface ${p} {
  /** Stable identifier. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
}

/** The fields a client may set. */
export interface ${p}Input {
  /** Display name. */
  readonly name: string;
}
`;
}

function service(names: DerivedNames): string {
  const p = names.pascal;
  return `import type { IRequestContext } from '@setu-ts/common';

import type { ${p}, ${p}Input } from './${names.kebab}.types.ts';

/**
 * Sample storage: replace it with a repository before deploying.
 *
 * This \`Map\` lives in process memory with no size limit. Add authentication to
 * the routes and a real store before the module serves real traffic.
 */
const records = new Map<string, ${p}>();

/** What the ${names.kebab} module offers to pages and to its API routes. */
export interface ${p}Service {
  /** Every record, ordered by name. */
  list(): Promise<readonly ${p}[]>;
  /** One record, or undefined. */
  get(id: string): Promise<${p} | undefined>;
  /** Creates a record. */
  create(input: ${p}Input): Promise<${p}>;
  /** Updates a record, or answers undefined when it does not exist. */
  update(id: string, input: Partial<${p}Input>): Promise<${p} | undefined>;
}

/**
 * Builds the service for one request.
 *
 * Registered with \`requestService\` in this module's \`index.ts\`, so it runs at
 * most once per request and a page loader and an API route in that request
 * share the instance. Read the tenant, the principal or \`ctx.signal\` here; a
 * page never receives \`ctx\`.
 *
 * @param ctx - The kernel request context
 * @returns The request's ${names.kebab} service
 */
export function ${names.camel}Service(ctx: IRequestContext): ${p}Service {
  void ctx;
  return {
    list: () => {
      const all = [...records.values()];
      return Promise.resolve(all.sort((a, b) => a.name.localeCompare(b.name)));
    },
    get: (id) => Promise.resolve(records.get(id)),
    create: (input) => {
      const record: ${p} = { id: crypto.randomUUID(), name: input.name };
      records.set(record.id, record);
      return Promise.resolve(record);
    },
    update: (id, input) => {
      const current = records.get(id);
      if (current === undefined) return Promise.resolve(undefined);
      const record: ${p} = { ...current, ...input, id };
      records.set(id, record);
      return Promise.resolve(record);
    },
  };
}
`;
}

function token(names: DerivedNames): string {
  return `import { serviceToken } from '@setu-ts/common';

import type { ${names.pascal}Service } from './${names.kebab}.service.ts';

/**
 * The ${names.kebab} service's token. Pages import this module by value, so it
 * holds nothing else: \`setu check\` admits \`*.token.ts\` imports from \`~kernel/*\`
 * and refuses every other value import (setu.E017).
 */
export const ${names.screaming} = serviceToken<${names.pascal}Service>('module.${names.kebab}');
`;
}

function controller(names: DerivedNames): string {
  const p = names.pascal;
  return `import { type IRouterApi, type IServiceRegistry, resolveRequestService } from '@setu-ts/common';

import type { ${p}Input } from './${names.kebab}.types.ts';
import { ${names.screaming} } from './${names.kebab}.token.ts';

/** Reads a client's input, refusing a body without a string \`name\`. */
function inputOf(body: unknown): ${p}Input | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const name = (body as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? { name } : undefined;
}

/**
 * The ${names.kebab} API, under \`/api\` so a kernel route never shadows a page.
 * Every unsafe request passes the session's CSRF check: browser code sends the
 * page's token in \`x-csrf-token\`.
 */
export function ${routeRegistrarSymbol(names)}(router: IRouterApi, services?: IServiceRegistry): void {
  void services;
  router.group('/api/${names.kebab}', (routes) => {
    routes.get('/', async (ctx) => {
      const service = resolveRequestService(ctx, ${names.screaming});
      return ctx.response.json({ items: await service.list() });
    });
    routes.get('/:id', async (ctx) => {
      const service = resolveRequestService(ctx, ${names.screaming});
      const record = await service.get(ctx.params['id'] ?? '');
      return record === undefined
        ? ctx.response.status(404).json({ title: 'Not Found', status: 404 })
        : ctx.response.json(record);
    });
    routes.post('/', async (ctx) => {
      const input = inputOf(await ctx.request.json<unknown>());
      if (input === undefined) {
        return ctx.response.status(400).json({ title: 'Bad Request', status: 400 });
      }
      const service = resolveRequestService(ctx, ${names.screaming});
      return ctx.response.status(201).json(await service.create(input));
    });
    routes.patch('/:id', async (ctx) => {
      const input = inputOf(await ctx.request.json<unknown>());
      if (input === undefined) {
        return ctx.response.status(400).json({ title: 'Bad Request', status: 400 });
      }
      const service = resolveRequestService(ctx, ${names.screaming});
      const record = await service.update(ctx.params['id'] ?? '', input);
      return record === undefined
        ? ctx.response.status(404).json({ title: 'Not Found', status: 404 })
        : ctx.response.json(record);
    });
  });
}
`;
}

function page(names: DerivedNames): string {
  const p = names.pascal;
  return `import { useLoaderData } from 'react-router';
import { getService } from '@setu-ts/react-router-plugin';

import { Card, CardContent } from '~/components/ui/card.tsx';
import type { AppLoadContext } from '~/lib/load-context.ts';
import { requireUser } from '~/server/require-user.server.ts';
import type { ${p} } from '~kernel/modules/${names.kebab}/${names.kebab}.types.ts';
import { ${names.screaming} } from '~kernel/modules/${names.kebab}/${names.kebab}.token.ts';

/** Only a signed-in user reaches this page. */
export const middleware = [requireUser];

/**
 * Reads the ${names.kebab} module's service for THIS request: the same instance
 * \`/api/${names.kebab}\` uses. Only the type and the token are imported from
 * \`~kernel/*\`; \`setu check\` refuses any other value import (setu.E017).
 */
export async function loader({ context }: { context: AppLoadContext }) {
  const items: readonly ${p}[] = await getService(context, ${names.screaming}).list();
  return { items };
}

export default function ${p}Page() {
  const { items } = useLoaderData<typeof loader>();
  return (
    <Card>
      <CardContent className='grid gap-4'>
        <h1 className='text-2xl font-semibold'>${p} ({items.length})</h1>
        <ul className='list-disc space-y-1 pl-5'>
          {items.map((item) => <li key={item.id}>{item.name}</li>)}
        </ul>
      </CardContent>
    </Card>
  );
}
`;
}

/**
 * The session helper the full-stack module tests use (§3.8): GETs `/login`,
 * keeps the session cookie and the `_csrf` field, and returns headers that
 * carry both on every unsafe request.
 *
 * @returns The `test/support/session.ts` contents
 */
export function renderSessionSupport(): string {
  return `/**
 * A signed session for tests: the full-stack template runs session CSRF on every
 * unsafe route, so a POST needs the session cookie and its token (X91-2).
 *
 * \`/login\` renders the token into its form, and the response sets the cookie.
 * Both are kept and sent as headers, the way browser code sends them.
 */
export async function signedSession(baseUrl: string): Promise<{
  readonly headers: (extra?: Record<string, string>) => Record<string, string>;
}> {
  const page = await fetch(baseUrl + '/login');
  const html = await page.text();
  const token = /name="_csrf"\\s+value="([^"]+)"/.exec(html)?.[1];
  if (token === undefined) throw new Error('GET /login rendered no _csrf field.');
  const cookie = page.headers
    .getSetCookie()
    .map((line) => line.split(';', 1)[0])
    .join('; ');
  return {
    headers: (extra = {}) => ({ cookie, 'x-csrf-token': token, ...extra }),
  };
}
`;
}

function moduleTest(names: DerivedNames, runtime: TargetRuntime, e2e: boolean): string {
  const eq = (actual: string, expected: string): string => renderEquals(runtime, actual, expected);
  const base = `/api/${names.kebab}`;
  return `${testHarnessFor(runtime).imports}
import { startTestServer } from '../../../test/support/server.ts';
import { signedSession } from '../../../test/support/session.ts';

describe('${names.kebab} ${e2e ? 'e2e' : 'module'}', () => {
  it('creates a record with the session token and reads it back', async () => {
    const server = await startTestServer();
    try {
      const session = await signedSession(server.baseUrl);
      const created = await fetch(server.baseUrl + '${base}', {
        method: 'POST',
        headers: session.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ name: 'Example' }),
      });
      ${eq('created.status', '201')}
      const record: { id: string; name: string } = await created.json();
      ${eq('record.name', "'Example'")}
      const read = await fetch(server.baseUrl + '${base}/' + record.id);
      ${eq('read.status', '200')}
      ${eq('await read.json()', 'record')}${
        e2e
          ? `
      // Without the session token the CSRF check answers 403, by design.
      const refused = await fetch(server.baseUrl + '${base}', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Refused' }),
      });
      ${eq('refused.status', '403')}
      await refused.text();`
          : ''
      }
    } finally {
      await server.stop();
    }
  });
});
`;
}

/** Options for {@linkcode generateFullStackModule}. */
export interface FullStackModuleOptions {
  readonly runtime: TargetRuntime;
  /** Already-admitted module names, for the activation barrel. */
  readonly modules?: readonly string[];
  /** Also write the module's page route. */
  readonly page?: boolean;
}

/**
 * The files `setu g module <name>` writes in a full-stack project.
 *
 * @param names - The module's derived names
 * @param options - Runtime, existing modules and `--page`
 * @returns The generated files
 */
export function generateFullStackModule(
  names: DerivedNames,
  options: FullStackModuleOptions,
): readonly GeneratedFile[] {
  const dir = `${MODULES_DIR}/${names.kebab}`;
  return [
    { path: `${dir}/${names.kebab}.types.ts`, contents: types(names) },
    { path: `${dir}/${names.kebab}.service.ts`, contents: service(names) },
    { path: `${dir}/${names.kebab}.token.ts`, contents: token(names) },
    { path: `${dir}/${names.kebab}.controller.ts`, contents: controller(names) },
    {
      path: `${dir}/index.ts`,
      managed: true,
      contents: renderFunctionalModuleIndex(names, {
        controller: [names.kebab],
        [MODULE_SERVICE_ARTIFACTS]: [names.kebab],
      }),
    },
    {
      path: `${MODULES_DIR}/index.ts`,
      managed: true,
      contents: renderFunctionalModuleBarrel([...(options.modules ?? []), names.kebab]),
    },
    ...(options.page === true ? [{ path: modulePagePath(names), contents: page(names) }] : []),
    { path: `${dir}/${names.kebab}.test.ts`, contents: moduleTest(names, options.runtime, false) },
    {
      path: `${dir}/${names.kebab}.e2e.test.ts`,
      contents: moduleTest(names, options.runtime, true),
    },
    { path: 'test/support/server.ts', managed: true, contents: renderTestServer(options.runtime) },
    { path: SESSION_SUPPORT_PATH, managed: true, contents: renderSessionSupport() },
  ];
}
