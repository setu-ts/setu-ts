/**
 * Controller decorators — mark classes as controllers and assign a base path
 * prefix / API version.
 *
 * @module
 */
import { classDecorator } from '../metadata/context-bridge.ts';
import type { SetuClassDecorator } from '../metadata/context-bridge.ts';

/**
 * Marks a class as a controller and assigns a base path prefix for all its
 * routes.
 *
 * @param path - Base path prefix (e.g. `'/users'`)
 * @returns A class decorator
 * @example
 * ```typescript
 * @Controller('/users')
 * class UserController {
 *   @Get('/')
 *   list() { … }
 * }
 * ```
 * @since 0.1.0
 */
export function Controller(path: string): SetuClassDecorator {
  return classDecorator((store, target) => {
    store.mergeController(target, { path });
  });
}

/**
 * Assigns an API version prefix to a controller. Combined with `@Controller`,
 * the effective path is `version + basePath + routePath`
 * (e.g. `'/v1/users'`).
 *
 * @param version - Version prefix (e.g. `'v1'`, `'api/v1'`)
 * @returns A class decorator
 * @example
 * ```typescript
 * @Controller('/users')
 * @Version('v1')
 * class UserController { … }
 * ```
 * @since 0.1.0
 */
export function Version(version: string): SetuClassDecorator {
  return classDecorator((store, target) => {
    store.mergeController(target, { version });
  });
}
