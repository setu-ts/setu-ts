/**
 * The class-based project template.
 *
 * Emits a project whose first files are a decorated controller and an injected
 * service, so a developer who prefers decorators sees the composition immediately
 * rather than reading about it. Wiring stays INLINE, like `rest` and
 * `microservice`: this is not the deferred `setu new --starter` path.
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';
import type { LocalImport, TemplateDefinition, Wiring } from './registry.ts';
import { DI_WIRING } from './di.ts';
import { REST_MIDDLEWARE, REST_PLUGINS } from './rest.ts';
import {
  CLASS_BASED_MODULE_MANIFEST,
  MODULE_SEAM_FILES,
  MODULE_SEAM_LOCAL_IMPORT,
  withModuleSeam,
} from './module-seam.ts';
import {
  decoratorSeamExtras,
  seamFiles,
  seamLocalImports,
  seamPluginSpreads,
  seamSetupCalls,
  seamsFor,
  withPluginOptionSeams,
} from './seam.ts';

/** The class-based world adds decorators to the functional REST composition. */
const DECORATOR_WIRING: Wiring = { pkg: 'decorator-plugin', symbol: 'DecoratorPlugin' };

const CLASS_BASED_SEAMS = seamsFor(new Set([...REST_PLUGINS, DECORATOR_WIRING].map((p) => p.pkg)));

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

/**
 * The two example source files this template emits, plus the seam barrels.
 *
 * The class-based template registers the REST plugin set plus its decorator and
 * DI pair. Its seams include the class-oriented controller and service barrels.
 */
export const CLASS_BASED_FILES: readonly GeneratedFile[] = [
  { path: 'src/greeting-service.ts', contents: SERVICE_SOURCE },
  { path: 'src/greeting-controller.ts', contents: CONTROLLER_SOURCE },
  ...MODULE_SEAM_FILES,
  ...seamFiles(CLASS_BASED_SEAMS),
];

/** The classes `setu.config.ts` must import to pass them to `DecoratorPlugin`. */
export const CLASS_BASED_LOCAL_IMPORTS: readonly LocalImport[] = [
  { symbols: ['GreetingService'], from: SERVICE_PATH },
  { symbols: ['GreetingController'], from: CONTROLLER_PATH },
  MODULE_SEAM_LOCAL_IMPORT,
  ...seamLocalImports(CLASS_BASED_SEAMS),
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
 *
 * The wiring comes from `templates/di.ts` rather than a literal here, so this
 * list has one owner: the class-based template. It always installs the
 * decorator and DI pair together, so generated classes are coherent with their
 * registered runtime composition.
 */
export const CLASS_BASED_PLUGINS: readonly Wiring[] = withPluginOptionSeams(
  withModuleSeam(
    [...REST_PLUGINS, DECORATOR_WIRING],
    // The showcase classes come first, then the seam barrels, then the module barrel —
    // so `setu g controller` and `setu g module` both ADD to this registration rather
    // than displacing the template's own example.
    ['GreetingController', ...decoratorSeamExtras(CLASS_BASED_SEAMS).controllers],
    ['GreetingService', ...decoratorSeamExtras(CLASS_BASED_SEAMS).services],
  ),
  CLASS_BASED_SEAMS,
).concat([DI_WIRING]);

/**
 * Class-based — the REST set plus decorators, a DI container, a decorated
 * controller, and an injected service.
 *
 * Nothing here needs raw sockets, so all four runtime targets work.
 */
export const CLASS_BASED_TEMPLATE: TemplateDefinition = {
  name: 'class-based',
  description: 'Class-based API — decorators, constructor injection, and modules',
  plugins: CLASS_BASED_PLUGINS,
  middleware: REST_MIDDLEWARE,
  localImports: CLASS_BASED_LOCAL_IMPORTS,
  files: CLASS_BASED_FILES,
  manifest: CLASS_BASED_MODULE_MANIFEST,
  pluginSpreads: seamPluginSpreads(CLASS_BASED_SEAMS),
  setupCalls: seamSetupCalls(CLASS_BASED_SEAMS),
};
