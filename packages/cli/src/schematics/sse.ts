/** SSE controller and application-local React hook schematic. */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import {
  CONTROLLERS_SEAM,
  FUNCTIONAL_CONTROLLERS_SEAM,
  HTTP_SEAM_DIR,
  routeRegistrarSymbol,
  withControllerArtifact,
} from '../seams/http.ts';
import { generatorMode } from '../utils/generator-mode.ts';
import { renderModuleIndex } from '../seams/modules.ts';
import { deriveNames } from '../utils/names.ts';

/**
 * Generates an SSE controller and a React hook in application source.
 *
 * With `--module` the controller is written into the module, served under
 * `/<module>/sse/<name>`, and registered like any other module controller.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the artifacts already present, for the barrel
 * @returns The controller, the optional hook and the managed registration file
 */
export function generateSse(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const classBased = generatorMode(options.plugins) === 'class-based';
  const seam = classBased ? CONTROLLERS_SEAM : FUNCTIONAL_CONTROLLERS_SEAM;
  const hook =
    options.plugins.has('react-router-plugin') && options.plugins.has('sdk')
      ? [{ path: `src/hooks/use-${names.kebab}.ts`, contents: renderHook(names) }]
      : [];
  const module = options.targetModule;
  const path = `/${module === undefined ? '' : `${module}/`}sse/${names.kebab}`;
  const controller = classBased
    ? renderClassController(names, path)
    : renderFunctionalController(names, path);
  if (module !== undefined)
    return [
      { path: `src/modules/${module}/${names.kebab}.controller.ts`, contents: controller },
      ...hook,
      {
        path: `src/modules/${module}/index.ts`,
        managed: true,
        contents: renderModuleIndex(
          classBased ? 'class-based' : 'functional',
          deriveNames(module),
          withControllerArtifact(
            options.moduleArtifacts,
            names.kebab,
            classBased ? 'class' : 'function',
          ),
        ),
      },
    ];
  return [
    {
      path: `${HTTP_SEAM_DIR}/${names.kebab}.controller.ts`,
      contents: controller,
    },
    ...hook,
    {
      path: seam.barrel,
      contents: seam.renderBarrel(
        withControllerArtifact(options.artifacts, names.kebab, classBased ? 'class' : 'function'),
      ),
      managed: true,
    },
  ];
}

function renderFunctionalController(names: DerivedNames, path: string): string {
  return `import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, IServiceRegistry, ISseService } from '@setu-ts/common';

/** Registers the ${names.kebab} SSE endpoint. */
export function ${routeRegistrarSymbol(names)}(
  router: IRouterApi,
  services?: IServiceRegistry,
): void {
  if (services === undefined) {
    throw new Error('The SSE route needs the service registry: pass app.services.');
  }
  router.get('${path}', (ctx) => {
    const sse = services.get<ISseService>(CAPABILITIES.SSE);
    return sse.open(ctx).result;
  });
}
`;
}

function renderClassController(names: DerivedNames, path: string): string {
  return `import { CAPABILITIES } from '@setu-ts/common';
import type { IRequestContext, ISseService } from '@setu-ts/common';
import { Controller, Ctx, Get, Params } from '@setu-ts/decorator-plugin';

/** SSE controller for ${names.kebab}. */
@Controller('${path}')
export class ${names.pascal}Controller {
  /** Opens the event stream. */
  @Get('/')
  @Params(Ctx())
  open(ctx: IRequestContext): unknown {
    return ctx.services.get<ISseService>(CAPABILITIES.SSE).open(ctx).result;
  }
}
`;
}

function renderHook(names: DerivedNames): string {
  return `import { useEffect, useState } from 'react';
import { createSseClient } from '@setu-ts/sdk';

/** Connects to the ${names.kebab} SSE endpoint and returns its latest event payload. */
export function use${names.pascal}Sse<TData = unknown>(url: string): TData | undefined {
  const [value, setValue] = useState<TData>();
  useEffect(() => {
    const client = createSseClient({
      url,
      onEvent: (event) => setValue(event.data as TData),
    });
    return () => client.close();
  }, [url]);
  return value;
}
`;
}
