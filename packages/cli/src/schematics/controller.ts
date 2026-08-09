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
  const contents = `import { Body, Controller, Get, Post } from '@setu-ts/decorator-plugin';

/**
 * HTTP controller for the ${names.kebab} resource.
 *
 * Register it through the DecoratorPlugin's \`controllers\` option or
 * \`discoverControllers\`.
 *
 * A decorated handler receives ONLY its decorated parameters: the plugin builds
 * the argument list from parameter metadata alone and never passes the request
 * context positionally, so a \`ctx\` parameter would arrive \`undefined\`. Return a
 * plain value and the plugin serializes it as JSON. Reach for
 * \`app.router.get(...)\` (see \`setu generate route\`) when a handler needs the
 * context itself — to set a status code or stream a response.
 */
@Controller('/${names.kebab}')
export class ${names.pascal}Controller {
  /**
   * Lists ${names.kebab} records.
   *
   * @returns The records, serialized as JSON
   */
  @Get('/')
  list(): { readonly items: readonly Record<string, unknown>[] } {
    return { items: [] };
  }

  /**
   * Creates a ${names.kebab} record.
   *
   * @param body - The parsed request body
   * @returns The created record, serialized as JSON
   */
  @Post('/')
  create(@Body() body: Record<string, unknown>): { readonly created: Record<string, unknown> } {
    return { created: body };
  }
}
`;
  return [{ path: `src/controllers/${names.kebab}.controller.ts`, contents }];
}
