/**
 * Controller schematic — the mode-default shape for an HTTP resource.
 *
 * Ungated since M70h. It used to require `decorator-plugin` and refuse in a bare
 * project, pointing the developer at `g route` in another directory; with both
 * kinds sharing `src/controllers/` there is no other directory to point at, so
 * the schematic branches on generator mode the way `service` already does.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import {
  APP_CONTROLLERS_EXPORT,
  CONTROLLERS_SEAM,
  FUNCTIONAL_CONTROLLERS_SEAM,
  HTTP_SEAM_DIR,
} from '../seams/http.ts';
import { seamNames } from '../seams/seam-spec.ts';
import { generatorMode } from '../utils/generator-mode.ts';
import { renderHttpModule } from './http-module.ts';

/**
 * Renders the decorated controller class.
 *
 * @param names - Naming forms derived from the user's input
 * @returns The module contents
 */
function renderControllerClass(names: DerivedNames): string {
  return `import { Body, Controller, Ctx, Get, Params, Post } from '@setu-ts/decorator-plugin';
import type { IRequestContext } from '@setu-ts/common';

/**
 * HTTP controller for the ${names.kebab} resource.
 *
 * Registered through the \`${APP_CONTROLLERS_EXPORT}\` barrel in
 * \`${HTTP_SEAM_DIR}/index.ts\`, which \`setu.config.ts\` passes to \`DecoratorPlugin\` —
 * so this class needs no further wiring.
 *
 * A decorated handler receives ONLY the arguments its \`@Params(...)\` names, in
 * that order: the plugin builds the argument list from that declaration alone
 * and never passes the request context positionally, so an undeclared \`ctx\`
 * parameter would arrive \`undefined\`. Return a plain value and the plugin
 * serializes it as JSON, or declare \`Ctx()\` when the handler needs the context
 * itself — to set a status code or stream.
 *
 * A resource this shape cannot express — a wildcard, a proxy, a route table
 * built in a loop — belongs in a \`.routes.ts\` module in this same directory.
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
   * @param ctx - The live request context, for the 201
   * @returns The created record, serialized as JSON
   */
  @Post('/')
  @Params(Body<Record<string, unknown>>(), Ctx())
  create(body: Record<string, unknown>, ctx: IRequestContext): unknown {
    return ctx.response.status(201).json({ created: body });
  }
}
`;
}

/**
 * Generates a controller and regenerates the shared HTTP barrel.
 *
 * The barrel carries both kinds, so it is rendered from BOTH artifact lists —
 * regenerating it after adding a controller must not drop the route modules
 * beside it.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the artifacts already present, for the barrel
 * @returns The controller at `src/controllers/<kebab>.controller.ts`, plus the
 *   managed `src/controllers/index.ts` barrel
 */
export function generateController(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const classBased = generatorMode(options.plugins) === 'class-based';
  const seam = classBased ? CONTROLLERS_SEAM : FUNCTIONAL_CONTROLLERS_SEAM;

  return [
    {
      path: `${HTTP_SEAM_DIR}/${names.kebab}.controller.ts`,
      contents: classBased ? renderControllerClass(names) : renderHttpModule(names, 'controller'),
    },
    {
      path: seam.barrel,
      // Union rather than append: regenerating over an existing controller must
      // list it exactly once, so the barrel is idempotent even though the
      // command refuses on the controller's own file.
      contents: seam.renderBarrel({
        controller: seamNames(options.artifacts, 'controller', names.kebab),
        route: seamNames(options.artifacts, 'route'),
      }),
      managed: true,
    },
  ];
}
