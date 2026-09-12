/**
 * A view engine supplied as an `@Injectable` service, in both modes.
 *
 * Raised in review on the M92 PR and confirmed by probe: the engine was
 * snapshotted from `ctx.services` BEFORE this plugin's own `registerService`
 * loop, so `@Injectable({ token: CAPABILITIES.VIEW })` — a legitimate way to
 * supply an engine without `ViewPlugin` — failed at `start()` with a message
 * telling the author to register the very plugin they had deliberately
 * replaced. The DI arm failed for a second reason: `registerService` puts an
 * `@Injectable` into `ctx.container` when a container is present, where a
 * registry lookup cannot see it at all.
 *
 * Both arms are pinned because they fail independently.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiPlugin } from '@setu-ts/di-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { Component, IPlugin, IViewEngine } from '@setu-ts/common';

import { Controller, DecoratorPlugin, Get, Injectable, Render } from '../../src/index.ts';

@Injectable({ token: CAPABILITIES.VIEW })
class ServiceEngine implements IViewEngine {
  render<P>(component: Component<P>, props: P): string {
    return `ENGINE:${String(component(props))}`;
  }
}

const Page = (props: { readonly title: string }): string => `<p>${props.title}</p>`;

@Controller('/pages')
class PagesController {
  @Render(Page)
  @Get('/one')
  one(): { readonly title: string } {
    return { title: 'hi' };
  }
}

async function serve(plugins: readonly IPlugin[]): Promise<Response> {
  const app = createApplication({
    plugins: [
      ...plugins,
      DecoratorPlugin({ controllers: [PagesController], services: [ServiceEngine] }),
    ],
  });
  await app.start();
  const res = await app.fetch(new Request('http://localhost/pages/one'));
  await app.stop();
  return res;
}

describe('a view engine registered as an @Injectable service', () => {
  it('is found through the registry, though it registers after the plugin starts', async () => {
    const res = await serve([RuntimePlugin()]);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('ENGINE:<p>hi</p>');
  });

  it('is found in the DI container, where a registry lookup cannot see it', async () => {
    const res = await serve([RuntimePlugin(), DiPlugin()]);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ENGINE:<p>hi</p>');
  });
});
