/** SSE controller and application-local React hook schematic. */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import {
  CONTROLLERS_SEAM,
  FUNCTIONAL_CONTROLLERS_SEAM,
  HTTP_SEAM_DIR,
  routeRegistrarSymbol,
} from '../seams/http.ts';
import { seamNames } from '../seams/seam-spec.ts';
import { generatorMode } from '../utils/generator-mode.ts';

/** Generates an SSE controller and a React hook in application source. */
export function generateSse(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const classBased = generatorMode(options.plugins) === 'class-based';
  const seam = classBased ? CONTROLLERS_SEAM : FUNCTIONAL_CONTROLLERS_SEAM;
  const hook = options.plugins.has('react-router-plugin') && options.plugins.has('sdk')
    ? [{ path: `src/hooks/use-${names.kebab}.ts`, contents: renderHook(names) }]
    : [];
  return [
    {
      path: `${HTTP_SEAM_DIR}/${names.kebab}.controller.ts`,
      contents: classBased ? renderClassController(names) : renderFunctionalController(names),
    },
    ...hook,
    {
      path: seam.barrel,
      contents: seam.renderBarrel({
        controller: seamNames(options.artifacts, 'controller', names.kebab),
        route: seamNames(options.artifacts, 'route'),
      }),
      managed: true,
    },
  ];
}

function renderFunctionalController(names: DerivedNames): string {
  return `import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, IServiceRegistry, ISseService } from '@setu-ts/common';

/** Registers the ${names.kebab} SSE endpoint. */
export function ${
    routeRegistrarSymbol(names)
  }(router: IRouterApi, services?: IServiceRegistry): void {
  if (services === undefined) {
    throw new Error('registerGeneratedRoutes must provide the service registry.');
  }
  router.get('/sse/${names.kebab}', (ctx) => {
    const sse = services.get<ISseService>(CAPABILITIES.SSE);
    return sse.open(ctx).result;
  });
}
`;
}

function renderClassController(names: DerivedNames): string {
  return `import { CAPABILITIES } from '@setu-ts/common';
import type { IRequestContext, ISseService } from '@setu-ts/common';
import { Controller, Ctx, Get, Params } from '@setu-ts/decorator-plugin';

/** SSE controller for ${names.kebab}. */
@Controller('/sse/${names.kebab}')
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
