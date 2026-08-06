import type { Config } from '@react-router/dev/config';

/**
 * React Router build configuration.
 *
 * `ssr: true` is what makes this a server-rendered app: the build emits
 * `build/server/index.js`, which `honoe.config.ts` hands to the SSR plugin as
 * its `serverBuildPath`. Changing the output directory means changing that
 * option too.
 */
export default {
  appDirectory: 'app',
  ssr: true,
} satisfies Config;
