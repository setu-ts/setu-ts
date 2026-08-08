import { z } from 'zod';
import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService } from '@setu-ts/common';
import { authMiddleware, requireAuth } from '@setu-ts/auth-plugin';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createRestApp } from '@setu-ts/rest-starter';

interface Todo {
  readonly id: string;
  readonly title: string;
}

const DEMO_SECRET = 'rest-api-example-secret';

/** Request body accepted by `POST /todos`. */
const TodoInputSchema = z.object({ title: z.string().min(1) });
/** A stored todo, as both routes return it. */
const TodoSchema = z.object({ id: z.string(), title: z.string() });
/** The shape every error response on this API uses. */
const ErrorSchema = z.object({ error: z.string(), message: z.string().optional() });

/** Creates a REST starter application with authentication and documented CRUD routes. */
export function createRestExampleApp(): IKernelApplication {
  const todos = new Map<string, Todo>();
  const app = createRestApp({
    auth: {
      jwt: { secret: DEMO_SECRET },
      rbac: { roles: {} },
    },
    openapi: {
      title: 'Todo API',
      version: '1.0.0',
      // Declaring the scheme is what gives Swagger UI its Authorize button;
      // without it the documented routes cannot be exercised from the page.
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      security: [{ bearerAuth: [] }],
      // The starter's probe and metrics endpoints are operational, not part of
      // the todo API a client generates against.
      exclude: ['/health', '/live', '/ready', '/metrics'],
    },
  });
  app.middleware.add(authMiddleware());

  app.router.post('/todos', {
    middleware: [requireAuth()],
    schema: {
      tags: ['Todos'],
      summary: 'Create a todo',
      body: TodoInputSchema,
      response: { 201: TodoSchema, 401: ErrorSchema },
    },
    handler: async (ctx) => {
      const input = await ctx.request.json<{ title: string }>();
      const todo = { id: String(todos.size + 1), title: input.title };
      todos.set(todo.id, todo);
      return ctx.response.status(201).json(todo);
    },
  });
  app.router.get('/todos/:id', {
    middleware: [requireAuth()],
    schema: {
      tags: ['Todos'],
      summary: 'Read a todo',
      // `params` is deliberately NOT declared here: an undescribed path
      // parameter is documented as a string automatically, because every path
      // segment arrives as one. Declaring a `params` schema still wins when a
      // route needs a tighter type (a uuid, an integer) or a description.
      response: { 200: TodoSchema, 401: ErrorSchema, 404: ErrorSchema },
    },
    handler: (ctx) => {
      const todo = todos.get(ctx.params.id);
      return todo ? ctx.response.json(todo) : ctx.response.status(404).json({ error: 'not found' });
    },
  });

  return app;
}

/** Issues the short-lived token used by this self-contained example. */
export async function issueDemoToken(app: IKernelApplication): Promise<string> {
  const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
  return await jwt.sign({ sub: 'example-user' }, { expiresIn: '5m' });
}
