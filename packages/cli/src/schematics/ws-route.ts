/** WebSocket route schematic. */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { INGRESS_SEAM } from '../seams/ingress.ts';
import { PLUGINS_SEAM } from '../seams/plugins.ts';
import { seamNames } from '../seams/seam-spec.ts';
import { generatorMode } from '../utils/generator-mode.ts';

/** Generates a plugin that registers one WebSocket route. */
export function generateWsRoute(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  if (generatorMode(options.plugins) === 'class-based') {
    return [
      {
        path: `${INGRESS_SEAM.dir}/${names.kebab}${INGRESS_SEAM.suffix}`,
        contents:
          `import type { IWebSocketConnection, WebSocketConnectionContext } from '@setu-ts/common';
import { Gateway, OnMessage, OnOpen } from '@setu-ts/decorator-plugin';

/** Decorated WebSocket gateway, registered through the ingress barrel. */
@Gateway('/ws/${names.kebab}')
export class ${names.pascal}Ingress {
  @OnOpen
  open(connection: IWebSocketConnection, context: WebSocketConnectionContext): void {
    connection.data.set('room', context.query['room'] ?? '${names.kebab}');
  }

  @OnMessage
  message(_connection: IWebSocketConnection, _data: string | Uint8Array): void {
    // Replace with the route's real frame handling.
  }
}
`,
      },
      {
        path: INGRESS_SEAM.barrel,
        contents: INGRESS_SEAM.renderBarrel({
          ingress: seamNames(options.artifacts, 'ingress', names.kebab),
        }),
        managed: true,
      },
    ];
  }
  const contents = `import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IPluginContext, IWebSocketService } from '@setu-ts/common';

/** Registers the ${names.kebab} WebSocket route. */
export function ${names.pascal}Plugin(): IPlugin {
  return {
    name: '${names.kebab}-ws-route',
    version: '0.1.0',
    dependencies: ['websocket-plugin'],
    register(ctx: IPluginContext): void {
      const websocket = ctx.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
      websocket.route('/ws/${names.kebab}', {
        onOpen: (connection, context) => {
          const room = context.query['room'] ?? '${names.kebab}';
          connection.data.set('room', room);
          websocket.room(room).add(connection);
        },
        onMessage: (connection, data) => {
          const room = connection.data.get('room');
          if (typeof room === 'string') websocket.room(room).broadcast(data, { except: connection });
        },
      });
    },
  };
}
`;
  return [
    { path: `src/plugins/${names.kebab}.plugin.ts`, contents },
    {
      path: PLUGINS_SEAM.barrel,
      contents: PLUGINS_SEAM.renderBarrel({
        plugin: seamNames(options.artifacts, 'plugin', names.kebab),
      }),
      managed: true,
    },
  ];
}
