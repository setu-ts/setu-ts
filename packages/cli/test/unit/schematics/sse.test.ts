import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { generateSse } from '../../../src/schematics/sse.ts';
import { APP_CONTROLLERS_EXPORT } from '../../../src/seams/http.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { options } from './_shared.ts';

describe('sse schematic', () => {
  it('generates a functional controller, hook, and managed shared barrel', () => {
    const files = generateSse(deriveNames('scores'), options(['sse-plugin']));
    expect(files.map((file) => file.path)).toEqual([
      'src/controllers/scores.controller.ts',
      'src/hooks/use-scores.ts',
      'src/controllers/index.ts',
    ]);
    expect(files[0]?.contents).toContain('services.get<ISseService>(CAPABILITIES.SSE)');
    expect(files[1]?.contents).toContain("import { createSseClient } from '@setu-ts/sdk';");
    expect(files[2]?.contents).toContain('registerScoresRoutes,');
    expect(files[2]?.contents).toContain('register(router, services);');
  });

  it('generates a decorated controller when decorators select class-based mode', () => {
    const files = generateSse(deriveNames('scores'), options(['sse-plugin', 'decorator-plugin']));
    expect(files[0]?.contents).toContain("@Controller('/sse/scores')");
    expect(files[2]?.contents).toContain(APP_CONTROLLERS_EXPORT);
  });
});
