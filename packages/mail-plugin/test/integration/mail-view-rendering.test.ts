/**
 * Component mail templates through a REAL kernel application and the REAL
 * `ViewPlugin` (M102). Under the NON-default `'hono-html'` engine so a helper
 * hardcoding a default would fail here; `MailPlugin` is listed BEFORE
 * `ViewPlugin` in `plugins`, so it is the `optionalDependencies` edge — not
 * array order — that puts the engine in the registry in time.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { Component, IMailer } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createElement as h, Suspense } from '@hono/hono/jsx';
import { html } from '@hono/hono/html';
import { UnresolvedSuspenseError, ViewPlugin, ViewRenderError } from '@setu-ts/view-plugin';

import { MailPlugin } from '../../src/index.ts';
import type { OutgoingMail } from '../../src/interfaces/index.ts';

interface WelcomeProps {
  readonly name: string;
}

/** An `html` tagged template: the rendering runtime escapes `name`. */
const WelcomeHtml = (p: WelcomeProps) => html`<h1>Welcome ${p.name}</h1>`;
/** A plain-string component: a valid `Component` whose output is used verbatim. */
const WelcomeText = (p: WelcomeProps) => `Welcome ${p.name}`;
/** A text body authored with the `html` tag — escaped, which the docs warn about. */
const TagText = (p: WelcomeProps) => html`Welcome ${p.name}`;
const Throwing: Component<WelcomeProps> = () => {
  throw new Error('template exploded');
};
/** Resolves after a tick — long after the buffered render has decided. */
async function DelayedChild() {
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  return h('p', null, 'real-content');
}
/** A tree holding a PENDING `<Suspense>` boundary — refused by the engine. */
const Suspended: Component<WelcomeProps> = () =>
  h('div', null, h(Suspense, { fallback: h('p', null, 'wait') }, h(DelayedChild, null)));

async function startApp(sent: OutgoingMail[]) {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      // Listed FIRST on purpose — see the module doc.
      MailPlugin({
        provider: 'log',
        defaults: { from: 'noreply@myapp.com' },
        templates: {
          plain: { html: '<h1>Hi {{ name }}</h1>', text: 'Hi {{ name }}' },
          welcome: { view: WelcomeHtml, text: WelcomeText },
          tagText: { view: WelcomeHtml, text: TagText },
          broken: { view: Throwing },
          suspended: { view: Suspended },
        },
        options: { sink: (m) => sent.push(m) },
      }),
      ViewPlugin({ engine: 'hono-html' }),
    ],
  });
  await app.start();
  return app;
}

describe('Mail component templates through a real kernel app (M102)', () => {
  it('renders an html-tag body (escaped) and a plain-string text body (verbatim)', async () => {
    const sent: OutgoingMail[] = [];
    const app = await startApp(sent);
    const mailer = app.services.get<IMailer>('mail');

    await mailer.sendTemplate('welcome', { to: 'u@example.com', subject: 'Welcome' }, {
      name: '<script>alert(1)</script>',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.from).toBe('noreply@myapp.com');
    expect(sent[0]?.subject).toBe('Welcome');
    // Escaped by the rendering runtime, and NOT re-escaped by this package.
    expect(sent[0]?.html).toBe('<h1>Welcome &lt;script&gt;alert(1)&lt;/script&gt;</h1>');
    // The text body is whatever the component returned.
    expect(sent[0]?.text).toBe('Welcome <script>alert(1)</script>');
    expect(typeof sent[0]?.html).toBe('string');

    await app.stop();
  });

  it('HTML-escapes a text body authored with the html tag (the documented foot-gun)', async () => {
    const sent: OutgoingMail[] = [];
    const app = await startApp(sent);
    const mailer = app.services.get<IMailer>('mail');
    await mailer.sendTemplate('tagText', { to: 'u@example.com', subject: 'x' }, { name: 'A & B' });
    // Pinned so the README/PUBLIC_API/JSDoc warning describes real behaviour.
    expect(sent[0]?.text).toBe('Welcome A &amp; B');
    await app.stop();
  });

  it('serves the string arm unchanged from the same template map', async () => {
    const sent: OutgoingMail[] = [];
    const app = await startApp(sent);
    const mailer = app.services.get<IMailer>('mail');
    await mailer.sendTemplate('plain', { to: 'u@example.com', subject: 'Hi' }, { name: 'A & B' });
    expect(sent[0]?.html).toBe('<h1>Hi A &amp; B</h1>');
    expect(sent[0]?.text).toBe('Hi A & B');
    await app.stop();
  });

  it('propagates ViewRenderError unwrapped and never reaches the provider', async () => {
    const sent: OutgoingMail[] = [];
    const app = await startApp(sent);
    const mailer = app.services.get<IMailer>('mail');
    let caught: unknown;
    await mailer.sendTemplate('broken', { to: 'u@example.com', subject: 'x' }, { name: 'a' })
      .catch((e: unknown) => {
        caught = e;
      });
    expect(caught).toBeInstanceOf(ViewRenderError);
    expect((caught as Error).cause).toBeInstanceOf(Error);
    expect(sent).toHaveLength(0);
    await app.stop();
  });

  it('propagates UnresolvedSuspenseError for a pending <Suspense> boundary', async () => {
    const sent: OutgoingMail[] = [];
    const app = await startApp(sent);
    const mailer = app.services.get<IMailer>('mail');
    await expect(
      mailer.sendTemplate('suspended', { to: 'u@example.com', subject: 'x' }, { name: 'a' }),
    ).rejects.toBeInstanceOf(UnresolvedSuspenseError);
    expect(sent).toHaveLength(0);
    await app.stop();
  });

  it('leaves the mailer reachability answer unchanged (log provider: true)', async () => {
    const app = await startApp([]);
    const mailer = app.services.get<IMailer>('mail');
    expect(await mailer.isHealthy?.()).toBe(true);
    await app.stop();
  });
});
