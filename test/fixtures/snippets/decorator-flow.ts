// Decorator flow from docs/decorators.md - must compile against the workspace.
// Programmatic equivalent (decorators require experimentalDecorators).
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiPlugin } from '@setu-ts/di-plugin';
import { DecoratorPlugin } from '@setu-ts/decorator-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    DiPlugin(),
    DecoratorPlugin({
      controllers: [],
      services: [],
    }),
  ],
});

await app.start({ port: 3000 });
