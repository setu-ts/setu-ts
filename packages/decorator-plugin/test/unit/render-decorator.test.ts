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
