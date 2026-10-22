import { createCapabilityToken } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';

/** The capability token the plugin registers its service under. */
export const GREETING = createCapabilityToken('example.greeting');

/** The service the plugin provides. */
export interface IGreetingService {
  greet(name: string): string;
}

class GreetingService implements IGreetingService {
  greet(name: string): string {
    return `Hello, ${name}!`;
  }
}

/** A complete custom plugin: it provides a capability and a route that resolves it. */
export function GreetingPlugin(): IPlugin {
  return {
    name: 'example-greeting-plugin',
    version: '0.1.0',
    provides: [GREETING],
    register(plugin): void {
      plugin.services.register<IGreetingService>(GREETING, new GreetingService());
      plugin.router.get('/greet/:name', (ctx) => {
        const greetings = ctx.services.get<IGreetingService>(GREETING);
        return ctx.response.json({ message: greetings.greet(ctx.params.name) });
      });
    },
  };
}
