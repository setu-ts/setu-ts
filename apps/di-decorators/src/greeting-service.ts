import { Injectable } from '@setu-ts/decorator-plugin';

/** Greets the caller named by the decorated controller. */
@Injectable({ token: 'greeting-service' })
export class GreetingService {
  greet(name: string): string {
    return `Hello, ${name}!`;
  }
}
