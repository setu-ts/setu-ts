/**
 * A localized string rendered through the REAL `ViewPlugin`: the formatter
 * escapes nothing and the rendering runtime escapes the value, so a catalogue
 * or placeholder value carrying markup arrives as text.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IKernelApplication } from '@setu-ts/kernel';
import { html } from '@hono/hono/html';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createTestApp } from '@setu-ts/testing';
import { renderView, ViewPlugin } from '@setu-ts/view-plugin';

import { LocalizationPlugin, localizerFor } from '../../src/index.ts';
import { CATALOGUES } from '../fixtures/catalogues.ts';

interface GreetingProps {
  readonly greeting: string;
}

const Greeting = (props: GreetingProps) => html`<h1>${props.greeting}</h1>`;

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function page(acceptLanguage: string, name: string): Promise<string> {
  app = await createTestApp({
    plugins: [
      RuntimePlugin(),
      ViewPlugin({ engine: 'hono-html' }),
      LocalizationPlugin({ supportedLocales: ['en', 'de', 'fr'], catalogues: CATALOGUES }),
    ],
  });
  app.router.get(
    '/',
    (ctx) => renderView(ctx, Greeting, { greeting: localizerFor(ctx).t('greeting', { name }) }),
  );
  const response = await app.fetch(
    new Request('http://localhost/', { headers: { 'accept-language': acceptLanguage } }),
  );
  return await response.text();
}

describe('localized view rendering', () => {
  it('renders the German string under Accept-Language: de', async () => {
    expect(await page('de', 'Ada')).toBe('<h1>Hallo Ada</h1>');
  });

  it('control: renders the English string under Accept-Language: en', async () => {
    expect(await page('en', 'Ada')).toBe('<h1>Hello Ada</h1>');
  });

  it('leaves escaping to the renderer: markup in a value arrives as text', async () => {
    expect(await page('en', '<b>Ada</b>')).toBe('<h1>Hello &lt;b&gt;Ada&lt;/b&gt;</h1>');
  });
});
