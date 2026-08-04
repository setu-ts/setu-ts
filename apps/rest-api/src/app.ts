import { CAPABILITIES } from '@hono-enterprise/common';
import type { IJwtService } from '@hono-enterprise/common';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import { createRestApp } from '@hono-enterprise/rest-starter';

interface Todo {
  readonly id: string;
  readonly title: string;
}

const DEMO_SECRET = 'rest-api-example-secret';

/** Creates a REST starter application with authentication and documented CRUD routes. */
export function createRestExampleApp(): IKernelApplication {
  const todos = new Map<string, Todo>();
  const app = createRestApp({
    auth: {
      jwt: { secret: DEMO_SECRET },
      rbac: { roles: {} },
    },
    openapi: { title: 'Todo API', version: '1.0.0' },
  });

  app.router.post('/todos', async (ctx) => {
    const input = await ctx.request.json<{ title: string }>();
    const todo = { id: String(todos.size + 1), title: input.title };
    todos.set(todo.id, todo);
    return ctx.response.status(201).json(todo);
  });
  app.router.get('/todos/:id', (ctx) => {
    const todo = todos.get(ctx.params.id);
    return todo ? ctx.response.json(todo) : ctx.response.status(404).json({ error: 'not found' });
  });

  return app;
}

/** Issues the short-lived token used by this self-contained example. */
export async function issueDemoToken(app: IKernelApplication): Promise<string> {
  const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
  return await jwt.sign({ sub: 'example-user' }, { expiresIn: '5m' });
}
