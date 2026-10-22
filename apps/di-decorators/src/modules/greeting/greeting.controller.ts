import { Controller, Get, Inject } from '@setu-ts/decorator-plugin';
import { GREETING_SERVICE } from './greeting.service.ts';
import type { GreetingService } from './greeting.service.ts';

/** A decorated controller; `@Inject` lists its constructor dependencies by position. */
@Controller('/greetings')
@Inject(GREETING_SERVICE)
export class GreetingController {
  constructor(private readonly greetings: GreetingService) {}

  @Get('/')
  index(): { readonly greeting: string } {
    return { greeting: this.greetings.greet('decorators') };
  }
}
