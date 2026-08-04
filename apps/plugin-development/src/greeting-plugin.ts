import { createCapabilityToken } from '@hono-enterprise/common';
import type { IPlugin } from '@hono-enterprise/common';

export const GREETING = createCapabilityToken('example.greeting');

export interface IGreetingService {
  greet(name: string): string;
}

class GreetingService implements IGreetingService {
  greet(name: string): string {
    return `Hello, ${name}!`;
  }
}

/** A complete custom plugin: capability registration plus a route that resolves it. */
export function GreetingPlugin(): IPlugin {
  return {
    name: 'example-greeting-plugin',
    version: '0.1.0',
    provides: [GREETING],
    register(ctx): void {
      ctx.services.register<IGreetingService>(GREETING, new GreetingService());
      ctx.router.get('/greet/:name', (request) => {
        const service = request.services.get<IGreetingService>(GREETING);
        return request.response.json({ message: service.greet(request.params.name) });
      });
    },
  };
}
