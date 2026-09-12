/**
 * Compile-time control for `@Render`'s props checking (M92 §3.7).
 *
 * Correct sync, async and parameterised handlers check clean; a wrong props
 * bag fails compilation with `TS1241`, naming the exact mismatch. The
 * directive is self-validating — an unused `@ts-expect-error` is itself a
 * compile error, so this file fails `deno check` the moment the decorator
 * stops checking.
 *
 * The file is `.tsx` with NO JSX elements and NO pragma: the decorator works
 * in a `.tsx` authoring context without a JSX runtime, because
 * `Component<P>` is structural (M92 §3.12 — this package imports no
 * rendering dependency).
 *
 * @module
 */
import { Controller, Get, Render } from '../../src/index.ts';

interface UserListProps {
  readonly users: readonly string[];
}

const UserList = (props: UserListProps): string =>
  `<ul>${props.users.map((user) => `<li>${user}</li>`).join('')}</ul>`;

@Controller('/type-pages')
class TypePagesController {
  @Render(UserList)
  @Get('/sync')
  sync(): UserListProps {
    return { users: ['ada'] };
  }

  @Render(UserList)
  @Get('/async')
  async asyncHandler(): Promise<UserListProps> {
    await Promise.resolve();
    return { users: ['grace'] };
  }

  @Render(UserList)
  @Get('/users/:id')
  parameterised(id: string): UserListProps {
    return { users: [id] };
  }

  // @ts-expect-error — the handler returns the wrong props bag; the compiler
  // names the exact mismatch (TS1241) instead of accepting a checked nothing.
  @Render(UserList)
  @Get('/wrong')
  wrong(): { readonly totallyWrong: number } {
    return { totallyWrong: 1 };
  }
}

// Exported so the decorated class is read (noUnusedLocals), not discarded.
export const _typePagesController: typeof TypePagesController = TypePagesController;
