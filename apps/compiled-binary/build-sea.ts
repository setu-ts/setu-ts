/** Build a Node SEA from HEAD source, with all intermediates below the workspace scratch root. */
import { build } from 'esbuild';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sourceExport } from '../../scripts/codemods/workspace-sources.ts';
import { run } from '../../scripts/lib/run.ts';

const out = fileURLToPath(new URL('../../.tmp/compiled-binary/', import.meta.url));
await mkdir(out, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('./sea.ts', import.meta.url))],
  outfile: `${out}/main.cjs`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  plugins: [
    {
      name: 'workspace-source',
      setup(builder) {
        builder.onResolve({ filter: /^@setu-ts\// }, (args) => {
          const path = sourceExport(args.path);
          if (path === null) throw new Error(`Unknown workspace export: ${args.path}`);
          return { path };
        });
      },
    },
  ],
});
const config = `${out}/sea-config.json`;
await writeFile(
  config,
  JSON.stringify({
    main: `${out}/main.cjs`,
    output: `${out}/sea.blob`,
    disableExperimentalSEAWarning: true,
  }),
);
for (const [command, args] of [
  [process.execPath, ['--experimental-sea-config', config]],
] as const) {
  const result = await run(command, args, { inherit: true });
  if (result.code !== 0) throw new Error('Node could not generate the SEA blob.');
}
const binary = `${out}/server`;
await copyFile(process.execPath, binary);
await chmod(binary, 0o755);
const injected = await run(
  'pnpm',
  [
    'exec',
    'postject',
    binary,
    'NODE_SEA_BLOB',
    `${out}/sea.blob`,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { inherit: true },
);
if (injected.code !== 0) throw new Error('postject could not inject the SEA blob.');
