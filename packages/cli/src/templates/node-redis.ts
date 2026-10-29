/**
 * The project-local node-redis helper a `--redis-client node-redis` scaffold
 * writes (M117 §3.8).
 *
 * The client is built in its OWN module rather than inline in `setu.config.ts`:
 * the configuration classifier `setu check`, `setu add` and the devtool read
 * (`devtool/sources.ts`) accepts only framework and relative imports, so a
 * `from 'redis'` line there made every node-redis configuration unclassifiable
 * — false `setu.W001` warnings, and no automatic wiring for a later `setu add`.
 * A relative import of this module keeps the configuration decidable.
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';
import type { LocalImport } from './registry.ts';

/** The line width generated projects format to (`deno.json` `lineWidth`, Prettier `printWidth`). */
const LINE_WIDTH = 100;

/** The helper's path, relative to the project root. */
export const NODE_REDIS_MODULE_PATH = 'src/node-redis.ts';

/** The helper's exported factory, called once per Redis-backed plugin. */
export const NODE_REDIS_FACTORY = 'nodeRedisClient';

/** How `setu.config.ts` imports the helper. */
export const NODE_REDIS_IMPORT: LocalImport = {
  symbols: [NODE_REDIS_FACTORY],
  from: `./${NODE_REDIS_MODULE_PATH}`,
};

/** The import line `setu add` inserts into an existing configuration. */
export const NODE_REDIS_IMPORT_LINE: string = `import { ${NODE_REDIS_FACTORY} } from './${NODE_REDIS_MODULE_PATH}';`;

/**
 * Renders a plugin's `client` value for the node-redis arm.
 *
 * @param connection - The rendered connection-URL expression
 * @returns The call expression, one connection per call
 */
export function nodeRedisClientCall(connection: string): string {
  const lines = connection.split('\n');
  if (lines.length === 1) {
    const call = `${NODE_REDIS_FACTORY}(${connection})`;
    // A single-line read reaches column 10 after `client: ` at its widest site,
    // a full-stack starter option. Past the generated 100-column line width,
    // emit the wrapped call `deno fmt` would (a Deno project is not reformatted
    // at scaffold time); the builders render for a property at 8, and the
    // starter rendering shifts the continuation two columns deeper.
    if (10 + 'client: '.length + call.length + ','.length <= LINE_WIDTH) return call;
    return `${NODE_REDIS_FACTORY}(\n${' '.repeat(10)}${connection},\n${' '.repeat(8)})`;
  }
  // A multi-line read (Deno: `Deno.env.get('X') ??` then the fallback, its
  // continuation indented for a `url:` property) is laid out as `deno fmt` lays
  // out a wrapped call argument: the argument on its own lines one level in,
  // a trailing comma, and the closing parenthesis back at the property's
  // indent. Derived from the read's own continuation indent, so it holds at
  // whatever depth the read was rendered for.
  const continuation = /^ */.exec(lines[1]!)![0].length;
  const property = Math.max(0, continuation - 2);
  const argument = [
    `${' '.repeat(continuation)}${lines[0]!}`,
    ...lines.slice(1).map((line) => `  ${line}`),
  ];
  return `${NODE_REDIS_FACTORY}(\n${argument.join('\n')},\n${' '.repeat(property)})`;
}

/**
 * The helper module's file.
 *
 * @returns The generated `src/node-redis.ts`
 */
export function nodeRedisModuleFile(): GeneratedFile {
  return {
    path: NODE_REDIS_MODULE_PATH,
    contents: `/**
 * node-redis connections for the Redis-backed plugins (\`--redis-client node-redis\`).
 *
 * One connection per plugin: each plugin closes its client when the application
 * stops, so a client shared between plugins would be closed under the others.
 * \`fromNodeRedis\` bounds every command (15 s by default) and keeps an
 * \`'error'\` listener attached, without which node-redis would crash the process
 * on a connection error.
 */
import { fromNodeRedis, type NodeRedisAdapter } from '@setu-ts/common';
import { createClient } from 'redis';

/**
 * Builds one bounded node-redis client for one plugin.
 *
 * @param url - The Redis connection URL
 * @returns The adapter the plugin's \`client\` option takes
 */
export function ${NODE_REDIS_FACTORY}(url: string): NodeRedisAdapter {
  return fromNodeRedis(createClient({ url }));
}
`,
  };
}
