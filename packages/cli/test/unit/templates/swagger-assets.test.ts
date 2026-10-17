import { describe, expect, it } from 'vitest';
import { TARGET_RUNTIMES } from '../../../src/constants.ts';
import { listTemplates } from '../../../src/templates/registry.ts';
import { projectFiles, resolveHost } from '../../../src/templates/project-files.ts';

describe('Swagger scaffold wiring', () => {
  for (const template of listTemplates()) {
    for (const host of [
      template,
      ...(template.classBased === undefined ? [] : [template.classBased]),
    ]) {
      for (const runtime of TARGET_RUNTIMES) {
        it(`${template.name} on ${runtime} declares assets and selects the right delivery`, () => {
          const rendered = projectFiles('probe', runtime, resolveHost(host, runtime));
          const manifest = JSON.parse(
            rendered.find((f) => f.path === (runtime === 'deno' ? 'deno.json' : 'package.json'))!
              .contents,
          );
          if (runtime === 'deno') {
            expect(manifest.imports['swagger-ui-dist']).toBe('npm:swagger-ui-dist@^5');
            expect(manifest.tasks.start).toContain('--allow-read');
          } else expect(manifest.dependencies['swagger-ui-dist']).toBe('^5');
          const config = rendered.find((f) => f.path === 'setu.config.ts')!.contents;
          if (runtime === 'cloudflare-workers') {
            expect(config).toContain("swagger: { assets: 'cdn' }");
            if (template.name === 'full-stack')
              expect(config).toContain("openapi: { swagger: { assets: 'cdn' } }");
          } else expect(config).not.toContain("assets: 'cdn'");
        });
      }
    }
  }
});
