import { Injectable } from '@setu-ts/decorator-plugin';

/** The DI token `GreetingService` is registered under. */
export const GREETING_SERVICE = 'greeting-service';

/** Builds greetings for the controller that injects it. */
@Injectable({ token: GREETING_SERVICE })
export class GreetingService {
  greet(name: string): string {
    return `Hello, ${name}!`;
  }
}
