/** Ordered application guidance, checked against source exports by the card gate. */
import type { ProjectFacts } from './facts.ts';
import { notInstalledAddables } from './not-installed.ts';

/** A rule's applicability and the packages whose exports its prose uses. */
export interface IRuleBlock {
  readonly id: string;
  readonly packages: readonly string[];
  readonly text: string;
  readonly applies: (facts: ProjectFacts) => boolean;
}

/** Fixed order is the priority order in the generated brief. */
export const RULE_BLOCKS: readonly IRuleBlock[] = [
  {
    id: 'generate',
    packages: [],
    applies: () => true,
    text: 'Generate with setu generate, then edit; follow its printed guidance. Never edit CLI-owned index.ts files. Kernel routes live only in *.controller.ts, in src/controllers/ (services in src/services/); after the first setu g module, only in src/modules/<name>/ (--module). Moved one? setu sync.',
  },
  {
    id: 'services',
    packages: [],
    applies: () => true,
    text: 'Never import one plugin into another. Resolve services through ctx.services.get with a `CAPABILITIES` token and its matching interface from `@setu-ts/common`.',
  },
  {
    id: 'add-first',
    packages: [],
    // Omitted when nothing is listed under Not installed: the rule would point at an empty list.
    applies: (f) => notInstalledAddables(f).length > 0,
    text: 'Never hand-write what a package under Not installed provides (a cache, queue, event bus, auth): setu add it and use it.',
  },
  {
    id: 'functional',
    packages: [],
    applies: (f) => f.style === 'functional',
    text: 'Routes use router.get or a `RouteDefinition` with middleware and handler. Return ctx.response.json(value); status(code) chains. `MiddlewareFunction` receives (ctx, next); await next() to continue, or write a response and return to refuse. Schemas belong in <name>.schemas.ts. With validation, bind once (const body = validateBody(S)), use body as middleware, read body.value(ctx).',
  },
  {
    id: 'class-based',
    packages: ['decorator-plugin', 'di-plugin'],
    applies: (f) => f.style === 'class-based',
    text: 'Use `@Controller` and `@Get` on classes and methods. These are TC39 decorators: no parameter decorators. `@Params(Body(), Param("id"))` names method arguments; class-level `@Inject("token")` names constructor dependencies. `@Injectable({ token })` services are built by `DiPlugin`.',
  },
  {
    id: 'time',
    packages: [],
    applies: () => true,
    text: 'ctx.startTime is a monotonic hrtime() reading in milliseconds. Resolve `IRuntimeServices` with `CAPABILITIES.RUNTIME`; duration is runtime.hrtime() - ctx.startTime. Use runtime.now() for wall-clock time.',
  },
  {
    id: 'errors',
    packages: ['exceptions'],
    applies: () => true,
    text: 'Use exception factories such as `notFound`, `badRequest` and `unauthorized` from `@setu-ts/exceptions`. The registered error handler can render RFC 9457 Problem Details; preserve the project’s error-handler configuration.',
  },
  {
    id: 'config',
    packages: [],
    applies: () => true,
    text: 'Handlers read `IConfig` via `CAPABILITIES.CONFIG`: config.get(key, { default: value }) or config.getOrThrow(key). Plugin options are evaluated before configuration loads; do not resolve loaded configuration while constructing those options.',
  },
  {
    id: 'imports',
    packages: [],
    applies: () => true,
    text: 'Use .ts suffixes for project imports where the runtime needs them; type-only imports use `import type`.',
  },
  {
    id: 'node-tests',
    packages: ['testing'],
    applies: (f) => f.runtime === 'node',
    text: 'Tests use node:test and node:assert. Build the real app with `createTestApp({ app: await createApp() })` from `@setu-ts/testing`; inject requests, read statusCode/body/headers, and await app.stop() in finally.',
  },
  {
    id: 'bun-tests',
    packages: ['testing'],
    applies: (f) => f.runtime === 'bun',
    text: 'Tests use `bun:test`. Build the real app with `createTestApp({ app: await createApp() })` from `@setu-ts/testing`; inject requests and await app.stop() in finally.',
  },
  {
    id: 'deno-tests',
    packages: ['testing'],
    applies: (f) => f.runtime === 'deno',
    text: 'Tests use `@std/testing/bdd` and `@std/expect`. Build the real app with `createTestApp({ app: await createApp() })` from `@setu-ts/testing`; inject requests and await app.stop() in finally.',
  },
  {
    id: 'full-stack',
    packages: ['react-router-plugin'],
    applies: (f) => f.installed.has('react-router-plugin'),
    text: 'Route modules live under app/routes/. Loaders read framework services through the context keys declared by setu.config.ts. Never introduce module-level caches. Build before start.',
  },
  {
    id: 'messaging',
    packages: ['messaging-plugin'],
    applies: (f) => f.installed.has('messaging-plugin'),
    text: 'Publish integration events through `CAPABILITIES.MESSAGING` with versioned topics. Declare consumers in the messaging plugin options.',
  },
  {
    id: 'workers',
    packages: [],
    applies: (f) => f.runtime === 'cloudflare-workers',
    text: 'Cloudflare Workers: no file system and no timers outliving a request. Bindings come from the fetch argument; scheduler-plugin is unavailable.',
  },
];
