/**
 * The class-based showcase — a decorated controller and an injected service.
 *
 * The class-based arm of the `rest` recipe emits these first files, so a
 * developer who prefers decorators sees the composition immediately rather
 * than reading about it. It lives in its own module (mirroring
 * `rest-showcase.ts` for the functional arm) so `rest.ts` can reference it in
 * the recipe without importing `class-based.ts` — which builds itself FROM the
 * recipe and would otherwise form a cycle.
 *
 * @module
 */
import type { Showcase } from './style.ts';

/** The artifact name the greeting controller and service are generated under. */
export const CLASS_BASED_SHOWCASE = 'greeting';

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
 * The example controller: routes by decorator, its dependency declared in the
 * class-position `@Inject` list, and its handler arguments in `@Params`.
 */
const CONTROLLER_SOURCE =
  `import { Controller, Get, Inject, Param, Params } from '@setu-ts/decorator-plugin';
import { GreetingService } from '../services/greeting.service.ts';

/**
 * A decorated controller.
 *
 * These are TC39 **standard** decorators, so the project needs no compiler
 * option — and there is no parameter position in the proposal, which is why a
 * dependency is named in the class-level \`@Inject\` list and a handler's
 * arguments in \`@Params\`. Both are positional: the Nth entry binds the Nth
 * argument.
 *
 * The token in \`@Inject\` is required because type-inferred injection needs
 * \`emitDecoratorMetadata\`, which Deno does not support, so the parameter's
 * type cannot be read.
 */
@Controller('/greetings')
@Inject('greeting-service')
export class GreetingController {
  constructor(private readonly greetings: GreetingService) {}

  @Get('/')
  index(): { message: string } {
    return { message: this.greetings.greet('world') };
  }

  @Get('/:name')
  @Params(Param('name'))
  byName(name: string): { message: string } {
    return { message: this.greetings.greet(name) };
  }
}
`;

/**
 * The class-based showcase: the two example source files, seeded into the
 * scaffolded controller and service barrels under {@linkcode CLASS_BASED_SHOWCASE}.
 */
export const CLASS_BASED_SHOWCASE_EXAMPLE: Showcase = {
  files: [
    // In the SEAM directories, under the seam naming convention (E4). A developer
    // following the scaffold's own example puts their next service in the same
    // place `setu generate service` writes.
    { path: `src/services/${CLASS_BASED_SHOWCASE}.service.ts`, contents: SERVICE_SOURCE },
    { path: `src/controllers/${CLASS_BASED_SHOWCASE}.controller.ts`, contents: CONTROLLER_SOURCE },
  ],
  // Seeded, so the scaffolded barrels already list the showcase and the scanner
  // keeps it on every later regeneration because it exports the symbols the
  // barrel imports.
  seeded: { controller: [CLASS_BASED_SHOWCASE], service: [CLASS_BASED_SHOWCASE] },
};
