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
  return `${NODE_REDIS_FACTORY}(${connection})`;
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
