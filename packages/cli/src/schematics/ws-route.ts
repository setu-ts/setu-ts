/** WebSocket route schematic. */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { PLUGINS_SEAM } from '../seams/plugins.ts';
import { seamNames } from '../seams/seam-spec.ts';

/** Generates a plugin that registers one WebSocket route. */
export function generateWsRoute(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
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
