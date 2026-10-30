/** Shared logger selection and host overlay for standalone projects and workspace members. */
import type { ParsedArgs } from '../args.ts';
import type { TargetRuntime } from '../constants.ts';
import { escapeName } from '../utils/names.ts';
import type { ResolvedHost } from './project-files.ts';
import { withClientDependencies } from './client-dependencies.ts';
import { mergeObjectArgs, rewritePluginArgs } from './plugin-args.ts';

/** Logger transports supported by generated applications. @since 0.11.0 */
export type ScaffoldLogger = 'console' | 'pino';

/** Returns the default logger for the target runtime. @since 0.11.0 */
export function defaultLogger(runtime: TargetRuntime): ScaffoldLogger {
  return runtime === 'cloudflare-workers' ? 'console' : 'pino';
}

/** Whether a host registers logging directly or through a starter. @since 0.11.0 */
export function hasLogger(host: ResolvedHost): boolean {
  return (
    host.plugins.some((plugin) => plugin.pkg === 'logger-plugin') ||
    (host.appFactory?.composes?.includes('logger-plugin') ?? false)
  );
}

/** Reads and refuses logger flags before rendering or writing. @since 0.11.0 */
export function resolveLoggerChoice(
  args: ParsedArgs,
  runtime: TargetRuntime,
  host: ResolvedHost,
):
  | { readonly ok: true; readonly logger?: ScaffoldLogger }
  | { readonly ok: false; readonly message: string } {
  const raw = args.flags['logger'];
  if (raw !== undefined && raw !== 'console' && raw !== 'pino') {
    return {
      ok: false,
      message:
        typeof raw === 'string'
          ? `Unknown --logger "${escapeName(raw)}". Expected console | pino.`
          : '--logger needs a value: console | pino.',
    };
  }
  if (!hasLogger(host)) {
    return raw === undefined
      ? { ok: true }
      : {
          ok: false,
          message:
            '--logger has nothing to configure: this host registers no logger. Select --template rest, microservice, class-based, or full-stack.',
        };
  }
  if (runtime === 'cloudflare-workers' && raw === 'pino') {
    return {
      ok: false,
      message:
        '--logger pino is unavailable on Cloudflare Workers. Use --logger console, or select --runtime node, deno, or bun.',
    };
  }
  return { ok: true, logger: raw ?? defaultLogger(runtime) };
}

/** Applies one logger choice through the existing plugin and dependency renderers. @since 0.11.0 */
export function withLogger(host: ResolvedHost, logger: ScaffoldLogger): ResolvedHost {
  if (!hasLogger(host)) return host;
  const configured =
    host.appFactory === undefined
      ? rewritePluginArgs(
          host,
          'logger-plugin',
          () => {
            const args = (
              host.plugins.find((plugin) => plugin.pkg === 'logger-plugin')!.args ?? '{}'
            ).replace(/\btransport:\s*'(?:pino|console)',?\s*/, '');
            return mergeObjectArgs(args, `{ transport: '${logger}' }`);
          },
          '',
        )
      : { ...host, appFactoryContext: { ...host.appFactoryContext, logger } };
  if (logger === 'pino') return withClientDependencies(configured, ['pino']);
  const dependencies = { ...configured.extraDependencies };
  const imports = { ...configured.extraImports };
  delete dependencies['pino'];
  delete imports['pino'];
  return { ...configured, extraDependencies: dependencies, extraImports: imports };
}
