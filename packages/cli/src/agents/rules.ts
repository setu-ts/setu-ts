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
    text: 'Use setu generate first, then edit. Follow printed registration guidance, including class-based module membership. Never edit CLI-owned src/*/index.ts barrels: generation rewrites them.',
  },
  {
    id: 'services',
    packages: [],
    applies: () => true,
    text: 'Never import a plugin into another. Use ctx.services.get with matching `CAPABILITIES` token/interface from `@setu-ts/common`.',
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
    text: 'Routes: router.get or `RouteDefinition` (middleware, handler). Return ctx.response.json(value); status(code) chains. `MiddlewareFunction`: (ctx, next); await next() or respond and return. Features: src/modules/<name>/; schemas: <name>.schemas.ts. Bind const body = validateBody(S); use body as middleware, read body.value(ctx).',
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
    text: 'ctx.startTime is monotonic milliseconds. Resolve `IRuntimeServices` via `CAPABILITIES.RUNTIME`; duration: runtime.hrtime() - ctx.startTime; wall clock: runtime.now().',
  },
  {
    id: 'errors',
    packages: ['exceptions'],
    applies: () => true,
    text: 'Use `notFound`, `badRequest`, `unauthorized` factories from `@setu-ts/exceptions`. Preserve the project’s error-handler config; it can render RFC 9457 Problem Details.',
  },
  {
    id: 'config',
    packages: [],
    applies: () => true,
    text: 'Read `IConfig` via `CAPABILITIES.CONFIG`: config.get(key, { default: value }) or config.getOrThrow(key). Options precede config loading; never resolve loaded config in them.',
  },
  {
    id: 'imports',
    packages: [],
    applies: () => true,
    text: 'Use .ts import suffixes where required; `import type` for types.',
  },
  {
    id: 'node-tests',
    packages: ['testing'],
    applies: (f) => f.runtime === 'node',
    text: 'Tests: node:test, node:assert; `createTestApp({ app: await createApp() })` from `@setu-ts/testing`. Inject requests, check statusCode/body/headers; await app.stop() in finally.',
  },
  {
    id: 'bun-tests',
    packages: ['testing'],
    applies: (f) => f.runtime === 'bun',
    text: 'Tests: `bun:test`; `createTestApp({ app: await createApp() })` from `@setu-ts/testing`. Inject requests; await app.stop() in finally.',
  },
  {
    id: 'deno-tests',
    packages: ['testing'],
    applies: (f) => f.runtime === 'deno',
    text: 'Tests: `@std/testing/bdd`, `@std/expect`; `createTestApp({ app: await createApp() })` from `@setu-ts/testing`. Inject requests; await app.stop() in finally.',
  },
  {
    id: 'full-stack',
    packages: ['react-router-plugin'],
    applies: (f) => f.installed.has('react-router-plugin') && f.runtime !== 'cloudflare-workers',
    text: 'Routes: app/routes/. Loaders use service context keys from setu.config.ts; no module-level caches. Dev: start:dev (Vite in-process; no build). Production: built output (Node: build, start; Deno start builds; Bun: frontend build, start). Style: Tailwind, app/components/ui/, cn from cn to merge classes. Kernel routes beat pages (setu generate refuses collisions); prefix APIs /api/.',
  },
  {
    id: 'full-stack-workers',
    packages: ['react-router-plugin'],
    applies: (f) => f.installed.has('react-router-plugin') && f.runtime === 'cloudflare-workers',
    text: 'Routes: app/routes/. Loaders use service context keys from setu.config.ts; no module-level caches. Develop: dev script (wrangler dev builds client and server first; no in-process Vite loop). Ship: deploy script. Style: Tailwind and app/components/ui/; merge classes with cn from cn. Kernel routes beat pages (setu generate refuses collisions); prefix APIs with /api/.',
  },
  {
    id: 'messaging',
    packages: ['messaging-plugin'],
    applies: (f) =>
      ['messaging-plugin', 'full-stack-starter', 'microservice-starter'].some((pkg) =>
        f.installed.has(pkg),
      ),
    text: 'Publish versioned integration-event topics via `CAPABILITIES.MESSAGING`. Consumers: `MessagingPlugin` options, or the starter’s messaging option in setu.config.ts. setu add messaging --broker <name> edits setu.config.ts when it can; otherwise add the line it prints.',
  },
  {
    id: 'workers',
    packages: [],
    applies: (f) => f.runtime === 'cloudflare-workers',
    text: 'Cloudflare Workers: no file system and no timers outliving a request. Bindings come from the fetch argument; scheduler-plugin is unavailable.',
  },
];
