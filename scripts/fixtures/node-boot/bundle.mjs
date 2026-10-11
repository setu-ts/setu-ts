import { build } from 'esbuild';
await build({
  entryPoints: ['boot-bundle.mjs'],
  outfile: 'bundled.mjs',
  bundle: true,
  treeShaking: true,
  platform: 'node',
  format: 'esm',
});
