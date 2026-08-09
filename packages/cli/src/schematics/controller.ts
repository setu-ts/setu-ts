/**
 * Controller schematic — a decorator-based controller class.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { APP_CONTROLLERS_EXPORT, CONTROLLERS_SEAM } from '../seams/controllers.ts';
import { seamNames } from '../seams/seam-spec.ts';

/**
 * Generates a controller class and regenerates the seam barrel that registers it.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the controllers already present, for the barrel
 * @returns The controller at `src/controllers/<kebab>.controller.ts`, plus the managed
 *   `src/controllers/index.ts` barrel
 */
export function generateController(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `import { Body, Controller, Get, Post } from '@setu-ts/decorator-plugin';

/**
 * HTTP controller for the ${names.kebab} resource.
 *
 * Registered through the \`${APP_CONTROLLERS_EXPORT}\` barrel in
 * \`src/controllers/index.ts\`, which \`setu.config.ts\` passes to \`DecoratorPlugin\` —
 * so this class needs no further wiring.
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
  return [
    { path: `src/controllers/${names.kebab}.controller.ts`, contents },
    {
      path: CONTROLLERS_SEAM.barrel,
      // Union rather than append: regenerating over an existing controller must list it
      // exactly once, so the barrel is idempotent even though the command refuses on
      // the controller's own file.
      contents: CONTROLLERS_SEAM.renderBarrel({
        controller: seamNames(options.artifacts, 'controller', names.kebab),
      }),
      managed: true,
    },
  ];
}
