import { Controller, Get } from '../../../src/index.ts';

/**
 * Fixture for `controller-discovery.test.ts` — a real on-disk decorated
 * controller exercised by the default (real `import()`) discovery path.
 */
@Controller('/discovered')
export class DiscoveredUserController {
  @Get('/')
  list(): unknown[] {
    return [];
  }
}
