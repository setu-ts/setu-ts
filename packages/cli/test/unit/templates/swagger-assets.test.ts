import { describe, expect, it } from 'vitest';
import { TARGET_RUNTIMES } from '../../../src/constants.ts';
import { listTemplates } from '../../../src/templates/registry.ts';
import { projectFiles, resolveHost } from '../../../src/templates/project-files.ts';
import { SWAGGER_UI_DIST_VERSION } from '../../../src/templates/swagger-version.ts';
import { swaggerUiHtml } from '@setu-ts/openapi-plugin';

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
            expect(manifest.imports['swagger-ui-dist']).toBe(
              `npm:swagger-ui-dist@${SWAGGER_UI_DIST_VERSION}`,
            );
            expect(manifest.tasks.start).toContain('--allow-read');
          } else if (runtime === 'cloudflare-workers') {
            // F4 (M113f audit): a Worker never self-hosts, so it never installs
            // the package — or the analytics hook it pulls in.
            expect(manifest.dependencies['swagger-ui-dist']).toBeUndefined();
            expect(manifest.scarfSettings).toBeUndefined();
          } else {
            expect(manifest.dependencies['swagger-ui-dist']).toBe(SWAGGER_UI_DIST_VERSION);
            expect(manifest.scarfSettings).toEqual({ enabled: false });
          }
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

  // V10-36: the installed copy must be the release the plugin's SRI hashes and
  // CDN URL were computed for, or the `{ baseUrl }` mode renders a blank page.
  it('pins the release the OpenAPI plugin hashes and serves from its CDN', () => {
    expect(SWAGGER_UI_DIST_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const html = swaggerUiHtml({ specUrl: '/openapi.json', assets: 'cdn' });
    expect(html).toContain(`swagger-ui-dist@${SWAGGER_UI_DIST_VERSION}/`);
  });
});
