import { Controller, Get, Inject } from '@hono-enterprise/decorator-plugin';
import type { GreetingService } from './greeting-service.ts';

/** A decorated controller with positional constructor injection. */
@Controller('/greetings')
export class GreetingController {
  constructor(@Inject('greeting-service') private readonly greetings: GreetingService) {}

  @Get('/')
  index(): { readonly greeting: string } {
    return { greeting: this.greetings.greet('decorators') };
  }
}
