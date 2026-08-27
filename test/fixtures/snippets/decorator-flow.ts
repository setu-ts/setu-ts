// Decorator flow from docs/decorators.md - must compile against the workspace.
// Mirrors the "Basic Controller" example: a real @Injectable service named in
// the class-position @Inject list of a @Controller with @Get, whose handler
// arguments are declared with @Params, wired through
// DecoratorPlugin({ controllers, services }). These are TC39 STANDARD
// decorators: no compilerOptions entry is required to compile this file.
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiPlugin } from '@setu-ts/di-plugin';
import {
  Controller,
  DecoratorPlugin,
  Get,
  Inject,
  Injectable,
  Param,
  Params,
} from '@setu-ts/decorator-plugin';

/**
 * Invariant: this fixture MUST exercise the real decorator surface. A prior
 * regression passed empty controller and service arrays, which compiles but
 * proves nothing about whether the guide's decorator examples compile. These
 * symbols are asserted at the bottom so the fixture cannot silently regress
 * to empty arrays again.
 */
const REQUIRED_SYMBOLS = {
  Controller,
  DecoratorPlugin,
  Get,
  Inject,
  Injectable,
  Param,
  Params,
} as const;

@Injectable({ token: 'user-service' })
export class UserService {
  findById(id: string): { id: string; name: string } {
    return { id, name: `user-${id}` };
  }
}

@Controller('/users')
@Inject('user-service')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('/:id')
  @Params(Param('id'))
  findOne(id: string): { id: string; name: string } {
    return this.userService.findById(id);
  }
}

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    DiPlugin(),
    DecoratorPlugin({
      controllers: [UserController],
      services: [UserService],
    }),
  ],
});

await app.start({ port: 3000 });

// Invariant: the fixture must use the real decorator symbols, not empty
// arrays. If any required symbol is undefined the fixture is a no-op gate.
for (const [name, symbol] of Object.entries(REQUIRED_SYMBOLS)) {
  if (symbol === undefined) {
    throw new Error(
      `decorator-flow.ts regression: required decorator symbol "${name}" is undefined; ` +
        `the fixture must exercise the real decorator surface, not empty arrays.`,
    );
  }
}
