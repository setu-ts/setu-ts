/**
 * Controller schematic — a decorator-based controller class.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a controller class.
 *
 * @param names - Naming forms derived from the user's input
 * @param _options - Unused: the controller shape is runtime-agnostic
 * @returns One file at `src/controllers/<kebab>.controller.ts`
 */
export function generateController(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `import { Controller, Get, Post } from '@hono-enterprise/decorator-plugin';
import type { HandlerResult, IRequestContext } from '@hono-enterprise/common';

/**
 * HTTP controller for the ${names.kebab} resource.
 *
 * Register it through the DecoratorPlugin's \`controllers\` option or
 * \`discoverControllers\`.
 */
@Controller('/${names.kebab}')
export class ${names.pascal}Controller {
  /**
   * Lists ${names.kebab} records.
   *
   * @param ctx - The request context
   * @returns The response
   */
  @Get('/')
  list(ctx: IRequestContext): HandlerResult {
    return ctx.response.json({ items: [] });
  }

  /**
   * Creates a ${names.kebab} record.
   *
   * @param ctx - The request context
   * @returns The response
   */
  @Post('/')
  create(ctx: IRequestContext): HandlerResult {
    return ctx.response.status(201).json({ created: true });
  }
}
`;
  return [{ path: `src/controllers/${names.kebab}.controller.ts`, contents }];
}
