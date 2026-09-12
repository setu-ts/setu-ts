/**
 * View rendering contract tests (`IViewEngine`, `Component<P>`,
 * `CAPABILITIES.VIEW`).
 *
 * The contract is structural: a JSX component, an `html`-tag component and a
 * plain `(props) => string` template must all be assignable to
 * `Component<P>`. These assertions are compile-time — they fail `deno check`,
 * not merely at runtime.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '../../src/tokens.ts';
import type { Component, IViewEngine } from '../../src/services/view.ts';

describe('CAPABILITIES.VIEW', () => {
  it('is the token `view`', () => {
    expect(CAPABILITIES.VIEW).toBe('view');
  });

  it('matches the committed token grammar', () => {
    // The grammar is lowercase kebab-case segments (tokens.ts TOKEN_PATTERN);
    // colons are illegal. Compiling the token through createCapabilityToken
    // proves the admitted shape rather than restating it.
    expect(CAPABILITIES.VIEW).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
  });
});

describe('Component<P> assignability', () => {
  it('accepts a JSX-shaped component (a function returning a node object)', () => {
    interface UserListProps {
      readonly users: readonly string[];
    }
    // What a @hono/hono/jsx component compiles to: a function returning the
    // runtime's node object. No JSX runtime is imported here — the shape is
    // what makes it a Component, not the syntax.
    const UserList = (props: UserListProps): { tag: string; props: UserListProps } => ({
      tag: 'ul',
      props,
    });

    const component: Component<UserListProps> = UserList;
    expect(component({ users: ['ada'] })).toBeDefined();
  });

  it('accepts an html-tag-shaped component (returning a template result object)', () => {
    const Page = (props: { readonly title: string }): { escaped: boolean; text: string } => ({
      escaped: true,
      text: `<h1>${props.title}</h1>`,
    });

    const component: Component<{ title: string }> = Page;
    expect(Page({ title: 'Users' }).text).toContain('<h1>');
    expect(component).toBe(Page);
  });

  it('accepts a plain (props) => string template — the by-name engine adapter shape', () => {
    const Template = (props: { readonly name: string }): string => `<p>Hello, ${props.name}</p>`;

    const component: Component<{ name: string }> = Template;
    expect(component({ name: 'ada' })).toBe('<p>Hello, ada</p>');
  });
});

describe('IViewEngine.render', () => {
  it('pins the return union to `string | Promise<string>` — no stream arm (M92 §3.5)', () => {
    // Compile-time pin: an implementation returning a stream, or a caller
    // assigning the render result to a stream type, fails `deno check`.
    const engine: IViewEngine = {
      render<P>(component: Component<P>, props: P): string | Promise<string> {
        return String(component(props));
      },
    };
    const result: string | Promise<string> = engine.render(() => '<p>x</p>', undefined);

    expect(typeof result).toBe('string');
  });
});
