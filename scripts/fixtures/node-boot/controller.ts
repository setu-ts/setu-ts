/**
 * A decorated controller compiled by the repository's `tsc` (M111a plan
 * §3.10, step 2). tsc's TC39 decorator emit creates decorator metadata only
 * when `Symbol.metadata` exists, which Node and Bun do not define; serving
 * this route proves `@setu-ts/decorator-plugin` installed the carrier (§3.4).
 *
 * @module
 */
import { Controller, Get } from '@setu-ts/decorator-plugin';

/** One route, so a served `200` can only come from the decorator path. */
@Controller('/decorated')
export class DecoratedController {
  /** Answers the fixed body the boot script asserts. */
  @Get('/')
  hello(): { decorated: boolean } {
    return { decorated: true };
  }
}
