import { expect, it } from 'vitest';
import { RouteRegistrationError } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { Controller, Get, DecoratorPlugin } from '../../../src/index.ts';
import { metadataStore } from '../../../src/metadata/metadata-store.ts';

it('M131b 3.11 enriches a decorated route refusal with controller and method', async () => {
  metadataStore.clear();
  @Controller('/files')
  class FilesController {
    @Get('/*.json')
    list(): string {
      return 'unreachable';
    }
  }
  const app = createApplication({
    plugins: [RuntimePlugin(), DecoratorPlugin({ controllers: [FilesController] })],
  });
  try {
    await app.start();
    throw new Error('expected route refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(RouteRegistrationError);
    expect(error).toMatchObject({
      reason: 'unsupported-pattern',
      method: 'GET',
      path: '/files/*.json',
    });
    expect((error as Error).message).toContain('Route GET /files/*.json (FilesController.list):');
    expect((error as Error).cause).toBeInstanceOf(RouteRegistrationError);
  } finally {
    await app.stop();
    metadataStore.clear();
  }
});
