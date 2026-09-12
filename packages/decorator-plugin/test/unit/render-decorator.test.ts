/**
 * `@Render(Component)` — the metadata write (M92 §3.7).
 *
 * Components are plain `(props) => string` functions: `Component<P>` is
 * structural, so nothing here needs a JSX runtime — and this package gains no
 * hono dependency to write a fixture (M92 §3.12).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Render } from '../../src/decorators/view.ts';
import { Controller, Get } from '../../src/index.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

interface UserListProps {
  readonly users: readonly string[];
}

/** A plain function — exactly the shape a by-name engine adapts to. */
function UserList(props: UserListProps): string {
  return `<ul>${props.users.map((user) => `<li>${user}</li>`).join('')}</ul>`;
}

@Controller('/pages')
class PagesController {
  @Render(UserList)
  @Get('/users')
  users(): UserListProps {
    return { users: ['ada'] };
  }
}

describe('@Render', () => {
  it('records the component on the route metadata', () => {
    const route = metadataStore.getRoutesFor(PagesController)[0];

    expect(route).toBeDefined();
    expect(route!.view).toBe(UserList);
  });

  it('records nothing on routes that carry no @Render', () => {
    class PlainController {
      @Get('/plain')
      plain(): { readonly ok: boolean } {
        return { ok: true };
      }
    }

    const route = metadataStore.getRoutesFor(PlainController)[0];
    expect(route).toBeDefined();
    expect(route!.view).toBeUndefined();
  });
});

describe('@Render precedence', () => {
  it('the TOPMOST decorator wins when a handler carries two', () => {
    // Raised in review as an untested documented decision. Decorators apply
    // bottom-up, so the replace-scalar write means the one written FIRST in
    // source is the one that survives — the opposite of what "last wins"
    // suggests to a reader, which is exactly why it is pinned here.
    const First = (props: { readonly a: string }) => `<i>${props.a}</i>`;
    const Second = (props: { readonly a: string }) => `<b>${props.a}</b>`;

    @Controller('/precedence')
    class TwoRenders {
      @Render(First)
      @Render(Second)
      @Get('/x')
      handler(): { readonly a: string } {
        return { a: 'z' };
      }
    }

    const routes = [...metadataStore.getRoutesFor(TwoRenders)];

    expect(routes).toHaveLength(1);
    expect(routes[0]?.view).toBe(First);
    expect(routes[0]?.view).not.toBe(Second);
  });
});
