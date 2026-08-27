import { Controller, Get, Inject } from '@setu-ts/decorator-plugin';
import type { GreetingService } from './greeting-service.ts';

/** A decorated controller with positional constructor injection. */
@Controller('/greetings')
@Inject('greeting-service')
export class GreetingController {
  constructor(private readonly greetings: GreetingService) {}

  @Get('/')
  index(): { readonly greeting: string } {
    return { greeting: this.greetings.greet('decorators') };
  }
}
