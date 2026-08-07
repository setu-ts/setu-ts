/**
 * The `nest` project template — the NestJS-familiarity showcase.
 *
 * Emits a project whose first files are a decorated controller and an injected
 * service, so a developer arriving from NestJS sees the composition immediately
 * rather than reading about it. Wiring stays INLINE, like `rest` and
 * `microservice`: this is not the deferred `setu new --starter` path.
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';
import type { LocalImport, TemplateDefinition, Wiring } from './registry.ts';
import { REST_MIDDLEWARE, REST_PLUGINS } from './rest.ts';

/** Where the emitted example classes live in the scaffolded project. */
const SERVICE_PATH = './src/greeting-service.ts';
const CONTROLLER_PATH = './src/greeting-controller.ts';

/**
 * The example service: an `@Injectable` with a capability token, so the
 * controller can name it in `@Inject`.
 */
const SERVICE_SOURCE = `import { Injectable } from '@setu-ts/decorator-plugin';

/**
 * A plain injectable service.
 *
 * \`token\` is the name the DI container registers it under, and the string
 * \`@Inject\` resolves. Without it the token defaults to the class name.
 */
@Injectable({ token: 'greeting-service' })
export class GreetingService {
  greet(name: string): string {
    return \`Hello, \${name}!\`;
  }
}
`;

/**
 * The example controller: routes by decorator, and its dependency declared with
 * parameter-level `@Inject`.
 */
const CONTROLLER_SOURCE =
  `import { Controller, Get, Inject, Param } from '@setu-ts/decorator-plugin';
import { GreetingService } from './greeting-service.ts';

/**
 * A decorated controller.
 *
 * The token in \`@Inject\` is required: type-inferred injection needs
 * \`emitDecoratorMetadata\`, which Deno does not support, so the parameter's type
 * cannot be read. The token binds to THIS argument by position, so reordering
 * the constructor cannot misinject.
 */
@Controller('/greetings')
export class GreetingController {
  constructor(@Inject('greeting-service') private readonly greetings: GreetingService) {}

  @Get('/')
  index(): { message: string } {
    return { message: this.greetings.greet('world') };
  }

  @Get('/:name')
  byName(@Param('name') name: string): { message: string } {
    return { message: this.greetings.greet(name) };
  }
}
`;

/** The two example source files this template emits. */
export const NEST_FILES: readonly GeneratedFile[] = [
  { path: 'src/greeting-service.ts', contents: SERVICE_SOURCE },
  { path: 'src/greeting-controller.ts', contents: CONTROLLER_SOURCE },
];

/** The classes `setu.config.ts` must import to pass them to `DecoratorPlugin`. */
export const NEST_LOCAL_IMPORTS: readonly LocalImport[] = [
  { symbols: ['GreetingService'], from: SERVICE_PATH },
  { symbols: ['GreetingController'], from: CONTROLLER_PATH },
];

/**
 * The REST set, with two changes: `DiPlugin` added, and `DecoratorPlugin`
 * carrying the explicit class lists.
 *
 * `DiPlugin` is what moves every `@Injectable` onto a container provider that
 * honors its `scope` — `DecoratorPlugin` branches on the container's presence.
 * Without it the classes still work, resolved from the kernel's
 * `ServiceRegistry`; the template includes it because a NestJS reader expects
 * scoped providers to be there.
 */
export const NEST_PLUGINS: readonly Wiring[] = REST_PLUGINS.map((wiring) =>
  wiring.pkg === 'decorator-plugin'
    ? {
      ...wiring,
      args: '{ controllers: [GreetingController], services: [GreetingService] }',
    }
    : wiring
).concat([{ pkg: 'di-plugin', symbol: 'DiPlugin' }]);

/**
 * `nest` — the REST set plus a DI container, a decorated controller, and an
 * injected service.
 *
 * `unsupported` is empty: nothing here needs raw sockets, so all four runtime
 * targets work.
 */
export const NEST_TEMPLATE: TemplateDefinition = {
  name: 'nest',
  description: 'NestJS-style — REST set plus DI container, decorated controller, injected service',
  plugins: NEST_PLUGINS,
  middleware: REST_MIDDLEWARE,
  localImports: NEST_LOCAL_IMPORTS,
  files: NEST_FILES,
  unsupported: {},
};
