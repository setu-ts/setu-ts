/**
 * The default `'hono-jsx'` arm.
 *
 * The engine test renders a `.tsx` fixture carrying NO pragma, so a manifest
 * whose `jsx` / `jsxImportSource` keys are wrong or dropped fails here loudly
 * instead of silently falling back to a per-file setting (M92 §3.11). The
 * layout case pins §3.4: a layout is an ordinary component taking `children`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { ViewEngine } from '../../src/engines/view-engine.ts';
import { Layout, UserList } from '../fixtures/users.tsx';

describe('ViewEngine (JSX authoring mode)', () => {
  it('renders a .tsx fixture carrying no pragma (proving the manifest config)', async () => {
    const result = await new ViewEngine().render(UserList, {
      users: ['ada', 'grace'],
    });

    expect(typeof result).toBe('string');
    expect(result).toBe('<ul><li>ada</li><li>grace</li></ul>');
  });

  it('a layout composing children produces ONE document', async () => {
    const Page = (props: { readonly users: readonly string[] }) =>
      Layout({
        title: 'Users',
        children: UserList({ users: props.users }),
      });

    const result = await new ViewEngine().render(Page, { users: ['ada'] });

    expect(result).toBe(
      '<html><head><title>Users</title></head><body><ul><li>ada</li></ul></body></html>',
    );
    // One document, exactly once — the layout must not double-wrap.
    expect(result.match(/<html>/g)).toHaveLength(1);
  });
});
