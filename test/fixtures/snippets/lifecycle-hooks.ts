// deno-lint-ignore-file no-console -- documentation snippet fixtures mirror guide examples
// Lifecycle hooks from docs/plugin-architecture.md - must compile against the workspace.
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IPluginContext } from '@setu-ts/common';

const lifecyclePlugin = {
  name: 'lifecycle-demo',
  version: '1.0.0',
  register(ctx: IPluginContext) {
    ctx.lifecycle.onInit(() => {
      console.log('Init');
    });

    ctx.lifecycle.onBootstrap(() => {
      console.log('Bootstrap');
    });

    ctx.lifecycle.onRequest((ctx) => {
      console.log('Request:', ctx.request.url);
    });

    ctx.lifecycle.onResponse((ctx) => {
      console.log('Response:', ctx.response.snapshot().status);
    });

    ctx.lifecycle.onError((error) => {
      console.error('Error:', error);
    });

    ctx.lifecycle.onStopping(() => {
      console.log('Stopping');
    });

    ctx.lifecycle.onShutdown(() => {
      console.log('Shutdown');
    });

    ctx.lifecycle.onClose(() => {
      console.log('Close');
    });
  },
};

const app = createApplication();
app.register(RuntimePlugin());
app.register(lifecyclePlugin);

await app.start({ port: 3000 });
