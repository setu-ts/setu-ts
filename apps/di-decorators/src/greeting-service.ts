import { Injectable } from '@hono-enterprise/decorator-plugin';

/** Greets the caller named by the decorated controller. */
@Injectable({ token: 'greeting-service' })
export class GreetingService {
  greet(name: string): string {
    return `Hello, ${name}!`;
  }
}
