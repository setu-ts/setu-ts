/**
 * `setu g module <name>` in a full-stack project.
 *
 * The module owns its business logic: a request-bound service factory over an
 * in-memory store, shared input parsing, a typed token and a managed index that
 * registers it (the module-service family survives `setu sync`). Without
 * `--page`, `/api/<name>` routes resolve the service with `resolveRequestService`.
 * `--page` writes a guarded React Router loader, action and form using
 * `getService`; add `--api` for outside callers to reach the same service.
 *
 * Generated page tests sign in through the template's placeholder login and
 * re-read the rotated CSRF token. API tests keep an anonymous signed session.
 *
 * @module
 */

import { moduleRouteBase } from './module-route-base.ts';
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

/** Path of the application-owned sign-in step for full-stack module tests. */
export const SIGN_IN_SUPPORT_PATH = 'test/support/sign-in.ts';

/** Shared refusal for command and schematic callers. */
export const API_REQUIRES_PAGE =
  '--api applies with --page: a module without a page is already reached through its /api routes.';

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
  /** Parses a client's name, trimming it or returning a validation message. */
  parse(value: { readonly name?: unknown }): ${p}Input | string;
  /** Every record, ordered by name. */
  list(): Promise<readonly ${p}[]>;
  /** One record, or undefined. */
  get(id: string): Promise<${p} | undefined>;
  /** Creates a record from parsed input. */
  create(input: ${p}Input): Promise<${p}>;
  /** Updates from parsed input, or answers undefined when the record does not exist. */
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
    parse: (value) => {
      const name = typeof value.name === 'string' ? value.name.trim() : '';
      return name.length > 0 ? { name } : 'A non-empty name is required.';
    },
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
  return `import { requestServiceToken } from '@setu-ts/common';

import type { ${names.pascal}Service } from './${names.kebab}.service.ts';

/**
 * The ${names.kebab} service's token. Pages import this module by value, so it
 * holds nothing else: \`setu check\` admits \`*.token.ts\` imports from \`~kernel/*\`
 * and refuses every other value import (setu.E017), except in React Router .server modules.
 */
export const ${names.screaming} = requestServiceToken<${names.pascal}Service>('module.${names.kebab}');
`;
}

function controller(names: DerivedNames): string {
  const p = names.pascal;
  return `import { type IRouterApi, type IServiceRegistry, resolveRequestService } from '@setu-ts/common';
import { badRequest, notFound } from '@setu-ts/exceptions';

import { ${names.screaming} } from './${names.kebab}.token.ts';

/**
 * The ${names.kebab} API, under \`/api\` so a kernel route never shadows a page.
 * For callers outside the app; pages write through their own action.
 * Unsafe requests need a session cookie and its token in \`x-csrf-token\`.
 *
 * Not behind sign-in: the page's \`requireUser\` guard covers the page only.
 * Add authentication here before these routes serve or accept real data.
 */
export function ${routeRegistrarSymbol(names)}(router: IRouterApi, services?: IServiceRegistry): void {
  void services;
  router.group('${moduleRouteBase(names.kebab, new Set(['react-router-plugin']))}', (routes) => {
    routes.get('/', async (ctx) => {
      const service = resolveRequestService(ctx, ${names.screaming});
      return ctx.response.json({ items: await service.list() });
    });
    routes.get('/:id', async (ctx) => {
      const service = resolveRequestService(ctx, ${names.screaming});
      const record = await service.get(ctx.params['id'] ?? '');
      if (record === undefined) throw notFound('${p} not found.');
      return ctx.response.json(record);
    });
    routes.post('/', async (ctx) => {
      const service = resolveRequestService(ctx, ${names.screaming});
      const body = await ctx.request.json<unknown>();
      const input = service.parse(typeof body === 'object' && body !== null ? body : {});
      if (typeof input === 'string') throw badRequest(input);
      return ctx.response.status(201).json(await service.create(input));
    });
    routes.patch('/:id', async (ctx) => {
      const service = resolveRequestService(ctx, ${names.screaming});
      const body = await ctx.request.json<unknown>();
      const input = service.parse(typeof body === 'object' && body !== null ? body : {});
      if (typeof input === 'string') throw badRequest(input);
      const record = await service.update(ctx.params['id'] ?? '', input);
      if (record === undefined) throw notFound('${p} not found.');
      return ctx.response.json(record);
    });
  });
}
`;
}

function page(names: DerivedNames): string {
  const p = names.pascal;
  return `import { Form, redirect, useActionData, useLoaderData } from 'react-router';
import { getService } from '@setu-ts/react-router-plugin';

import { Card, CardContent } from '~/components/ui/card.tsx';
import type { AppLoadContext } from '~/lib/load-context.ts';
import { requireUser } from '~/server/require-user.server.ts';
import { getCsrfToken } from '~/server/session.server.ts';
import type { ${p} } from '~kernel/modules/${names.kebab}/${names.kebab}.types.ts';
import { ${names.screaming} } from '~kernel/modules/${names.kebab}/${names.kebab}.token.ts';

/** Only a signed-in user reaches this page. */
export const middleware = [requireUser];

/**
 * Reads the ${names.kebab} module's service for THIS request, shared with the
 * action. Only the type and the token are imported from
 * \`~kernel/*\`; \`setu check\` refuses any other value import (setu.E017), except in React Router .server modules.
 */
export async function loader({ context }: { context: AppLoadContext }) {
  const items: readonly ${p}[] = await getService(context, ${names.screaming}).list();
  return { items, csrfToken: getCsrfToken(context) };
}

/**
 * Creates through the request-bound service. For a rate limit, upload check or
 * other guard, use pagePolicies in setu.config.ts with the literal key
 * 'routes/_app/${names.kebab}._index' and on: 'action'.
 */
export async function action({ request, context }: { request: Request; context: AppLoadContext }) {
  const form = await request.formData();
  const service = getService(context, ${names.screaming});
  const input = service.parse({ name: form.get('name') });
  if (typeof input === 'string') return { error: input };
  await service.create(input);
  return redirect('/${names.kebab}', 303);
}

export default function ${p}Page() {
  const { items, csrfToken } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <Card>
      <CardContent className='grid gap-4'>
        <h1 className='text-2xl font-semibold'>${p} ({items.length})</h1>
        <ul className='list-disc space-y-1 pl-5'>
          {items.map((item) => <li key={item.id}>{item.name}</li>)}
        </ul>
        <Form method='post'>
          <input type='hidden' name='_csrf' value={csrfToken} />
          <label>
            Name
            <input name='name' />
          </label>
          <button type='submit'>Create</button>
          {result?.error && <p role='alert'>{result.error}</p>}
        </Form>
      </CardContent>
    </Card>
  );
}
`;
}

/**
 * Session helpers for generated API and page tests. The page helper signs in
 * and reads the rotated token; both retain the cookie for unsafe requests.
 *
 * @returns The `test/support/session.ts` contents
 */
export function renderSessionSupport(): string {
  return `// Regenerated by setu g module; do not edit this file.
import { signIn } from './sign-in.ts';

/**
 * A signed session for tests: the full-stack template runs session CSRF on every
 * unsafe route, so a POST needs the session cookie and its token (X91-2).
 *
 * \`/login\` renders the token into its form, and the response sets the cookie.
 * Both are kept and sent as headers, the way browser code sends them.
 */
export async function signedSession(baseUrl: string): Promise<{
  readonly cookie: string;
  readonly token: string;
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
    cookie,
    token,
    headers: (extra = {}) => ({ cookie, 'x-csrf-token': token, ...extra }),
  };
}

/**
 * The sign-in step lives in test/support/sign-in.ts, which the application owns.
 * This session.ts is regenerated by setu. Sign-in rotates the session and its CSRF token.
 */
export async function signedInSession(
  baseUrl: string,
  email?: string,
): Promise<{
  readonly cookie: string;
  readonly token: string;
  readonly headers: (extra?: Record<string, string>) => Record<string, string>;
}> {
  const anonymous = await signedSession(baseUrl);
  let cookie = await signIn(baseUrl, anonymous, email);
  const page = await fetch(baseUrl + '/login', { headers: { cookie } });
  const token = /name="_csrf"\\s+value="([^"]+)"/.exec(await page.text())?.[1];
  if (token === undefined) throw new Error('GET /login rendered no signed-in _csrf field.');
  const cookies = page.headers.getSetCookie();
  cookie = cookies.map((line) => line.split(';', 1)[0]).join('; ') || cookie;
  return { cookie, token, headers: (extra = {}) => ({ cookie, 'x-csrf-token': token, ...extra }) };
}
`;
}

/**
 * Renders the application-owned placeholder sign-in step for generated tests.
 *
 * @returns The create-only `test/support/sign-in.ts` contents
 */
export function renderSignInSupport(): string {
  return `/**
 * This file belongs to the application: setu writes it once and never overwrites it.
 * When the app replaces the placeholder sign-in, change signIn to sign in the way
 * the app does, returning the signed-in session cookie.
 */

/** Signs in through the template's placeholder login and returns the rotated cookie. */
export async function signIn(
  baseUrl: string,
  session: { readonly cookie: string; readonly token: string },
  email = 'e2e@example.test',
): Promise<string> {
  const signedIn = await fetch(baseUrl + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, _csrf: session.token }),
  });
  await signedIn.text();
  if (signedIn.status !== 302 && signedIn.status !== 303) {
    throw new Error('POST /login did not redirect after sign-in.');
  }
  const cookies = signedIn.headers.getSetCookie();
  const cookie = cookies.map((line) => line.split(';', 1)[0]).join('; ');
  if (cookie.length === 0) throw new Error('POST /login returned no rotated session cookie.');
  return cookie;
}
`;
}

type Eq = (actual: string, expected: string) => string;

function pageCase(names: DerivedNames, eq: Eq): string {
  const url = `server.baseUrl + '/${names.kebab}'`;
  const actionUrl = `server.baseUrl + '/${names.kebab}?index'`;
  return `  it('creates through the page action and checks validation, CSRF and sign-in', async () => {
    const server = await startTestServer();
    try {
      const session = await signedInSession(server.baseUrl);
      const headers = {
        cookie: session.cookie,
        'content-type': 'application/x-www-form-urlencoded',
      };
      const created = await fetch(${actionUrl}, {
        method: 'POST',
        redirect: 'manual',
        headers,
        body: new URLSearchParams({ name: 'Example', _csrf: session.token }),
      });
      ${eq('created.status', '303')}
      ${eq("created.headers.get('location')", `'/${names.kebab}'`)}
      await created.text();
      const read = await fetch(${url}, {
        headers: { cookie: session.cookie },
      });
      ${eq('read.status', '200')}
      ${eq("(await read.text()).includes('Example')", 'true')}
      const invalid = await fetch(${actionUrl}, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ name: '', _csrf: session.token }),
      });
      ${eq('invalid.status', '200')}
      const invalidHtml = await invalid.text();
      ${eq("invalidHtml.includes('A non-empty name is required.')", 'true')}
      const refused = await fetch(${actionUrl}, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ name: 'Refused' }),
      });
      ${eq('refused.status', '403')}
      await refused.text();
      const anonymous = await signedSession(server.baseUrl);
      const unsigned = await fetch(${actionUrl}, {
        method: 'POST',
        redirect: 'manual',
        headers: anonymous.headers({ 'content-type': 'application/x-www-form-urlencoded' }),
        body: new URLSearchParams({ name: 'Anonymous refusal', _csrf: anonymous.token }),
      });
      ${eq('unsigned.status', '302')}
      ${eq("unsigned.headers.get('location')", "'/login'")}
      await unsigned.text();
      const afterUnsigned = await fetch(${url}, {
        headers: { cookie: session.cookie },
      });
      ${eq('afterUnsigned.status', '200')}
      ${eq("(await afterUnsigned.text()).includes('Anonymous refusal')", 'false')}
      // React Router targets the index route's <Form> through .data?index with JavaScript.
      const data = await fetch(server.baseUrl + '/${names.kebab}.data?index', {
        method: 'POST',
        redirect: 'manual',
        headers,
        body: new URLSearchParams({ name: 'Data example', _csrf: session.token }),
      });
      ${eq('data.status < 400', 'true')}
      await data.text();
      const afterData = await fetch(${url}, {
        headers: { cookie: session.cookie },
      });
      ${eq('afterData.status', '200')}
      ${eq("(await afterData.text()).includes('Data example')", 'true')}
    } finally {
      await server.stop();
    }
  });
`;
}

function apiCase(base: string, eq: Eq): string {
  return `  it('creates a record with the session token and reads it back', async () => {
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
      ${eq('await read.json()', 'record')}
      // Without the session token the CSRF check answers 403, by design.
      const refused = await fetch(server.baseUrl + '${base}', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Refused' }),
      });
      ${eq('refused.status', '403')}
      await refused.text();
    } finally {
      await server.stop();
    }
  });
`;
}

function moduleTest(
  names: DerivedNames,
  runtime: TargetRuntime,
  e2e: boolean,
  page: boolean,
  api: boolean,
): string {
  const eq = (actual: string, expected: string): string => renderEquals(runtime, actual, expected);
  if (!e2e)
    return `${testHarnessFor(runtime).imports}
import { createTestContext } from '@setu-ts/testing';
import { ${names.camel}Service } from './${names.kebab}.service.ts';

describe('${names.kebab} module', () => {
  it('parses and trims a name or explains invalid input', () => {
    const service = ${names.camel}Service(createTestContext());
    ${eq("service.parse({ name: '  Example  ' })", "{ name: 'Example' }")}
    for (const value of [{}, { name: null }, { name: 1 }, { name: '' }, { name: '   ' }]) {
      ${eq('service.parse(value)', "'A non-empty name is required.'")}
    }
  });
  it('creates a record and reads it back through the service', async () => {
    const service = ${names.camel}Service(createTestContext());
    const record = await service.create({ name: 'Example' });
    ${eq('record.name', "'Example'")}
    ${eq('await service.get(record.id)', 'record')}
    ${eq('(await service.list()).find((item) => item.id === record.id)', 'record')}
  });
});
`;
  const base = `/api/${names.kebab}`;
  return `${testHarnessFor(runtime).imports}
import { startTestServer } from '../../../test/support/server.ts';
import { ${[...(page ? ['signedInSession'] : []), 'signedSession'].join(', ')} } from '../../../test/support/session.ts';

describe('${names.kebab} e2e', () => {
${[...(page ? [pageCase(names, eq)] : []), ...(api ? [apiCase(base, eq)] : [])].join('')}});
`;
}

/** Options for {@linkcode generateFullStackModule}. */
export interface FullStackModuleOptions {
  readonly runtime: TargetRuntime;
  /** Already-admitted module names, for the activation barrel. */
  readonly modules?: readonly string[];
  /** Also write the module's page route. */
  readonly page?: boolean;
  /** With a page, also write its API controller and test. */
  readonly api?: boolean;
}

/**
 * The files `setu g module <name>` writes in a full-stack project.
 *
 * @param names - The module's derived names
 * @param options - Runtime, existing modules, `--page` and `--api`
 * @returns The generated files
 */
export function generateFullStackModule(
  names: DerivedNames,
  options: FullStackModuleOptions,
): readonly GeneratedFile[] {
  if (options.api === true && options.page !== true) throw new Error(API_REQUIRES_PAGE);
  const hasPage = options.page === true;
  const hasApi = !hasPage || options.api === true;
  const dir = `${MODULES_DIR}/${names.kebab}`;
  return [
    { path: `${dir}/${names.kebab}.types.ts`, contents: types(names) },
    { path: `${dir}/${names.kebab}.service.ts`, contents: service(names) },
    { path: `${dir}/${names.kebab}.token.ts`, contents: token(names) },
    ...(hasApi
      ? [{ path: `${dir}/${names.kebab}.controller.ts`, contents: controller(names) }]
      : []),
    {
      path: `${dir}/index.ts`,
      managed: true,
      contents: renderFunctionalModuleIndex(names, {
        ...(hasApi ? { controller: [names.kebab] } : {}),
        [MODULE_SERVICE_ARTIFACTS]: [names.kebab],
      }),
    },
    {
      path: `${MODULES_DIR}/index.ts`,
      managed: true,
      contents: renderFunctionalModuleBarrel([...(options.modules ?? []), names.kebab]),
    },
    ...(options.page === true ? [{ path: modulePagePath(names), contents: page(names) }] : []),
    ...(options.runtime === 'cloudflare-workers'
      ? []
      : [
          {
            path: `${dir}/${names.kebab}.test.ts`,
            contents: moduleTest(names, options.runtime, false, hasPage, hasApi),
          },
        ]),
    {
      path: `${dir}/${names.kebab}.e2e.test.ts`,
      contents: moduleTest(names, options.runtime, true, hasPage, hasApi),
    },
    { path: 'test/support/server.ts', managed: true, contents: renderTestServer(options.runtime) },
    { path: SESSION_SUPPORT_PATH, managed: true, contents: renderSessionSupport() },
    // Always emitted: the managed session helper imports it even for API-only modules.
    { path: SIGN_IN_SUPPORT_PATH, createOnly: true, contents: renderSignInSupport() },
  ];
}
