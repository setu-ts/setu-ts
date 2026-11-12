/** Shared mount for module-owned routes and page-shadow checks. @module */
import { generatorMode } from '../utils/generator-mode.ts';

/** Returns the module's HTTP base in the project's generation mode. */
export function moduleRouteBase(module: string, plugins: ReadonlySet<string>): string {
  return `${plugins.has('react-router-plugin') && generatorMode(plugins) !== 'class-based' ? '/api' : ''}/${module}`;
}
