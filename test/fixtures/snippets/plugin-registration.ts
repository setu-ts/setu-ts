// deno-lint-ignore-file require-await -- documentation snippet fixtures mirror guide examples
// Plugin registration from docs/custom-plugins.md - must compile against the workspace.
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export interface MyPluginOptions {
  greeting?: string;
}

export function MyPlugin(options: MyPluginOptions = {}): IPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    provides: ['my-service'],
    async register(ctx: IPluginContext) {
      ctx.services.register('my-service', {
        greet: (name: string) => `${options.greeting ?? 'Hello'}, ${name}!`,
      });
      ctx.router.get('/greet/:name', async (ctx) => {
        const service = ctx.services.get<{ greet: (n: string) => string }>(
          'my-service',
        );
        return ctx.response.json({ message: service.greet(ctx.params.name) });
      });
    },
  };
}

const app = createApplication();
app.register(RuntimePlugin());
app.register(MyPlugin({ greeting: 'Bonjour' }));
await app.start({ port: 3000 });
