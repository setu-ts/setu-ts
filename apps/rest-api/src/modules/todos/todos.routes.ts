import type { IRouterApi } from '@setu-ts/common';
import { requireAuth } from '@setu-ts/auth-plugin';
import { notFound } from '@setu-ts/exceptions';
import { validateBody } from '@setu-ts/validation-plugin';
import { ProblemDetails } from '../../shared/schemas/problem-details.schemas.ts';
import { CreateTodoBody, TodoResponse } from './todos.schemas.ts';
import { createTodo, getTodo } from './todos.service.ts';

const createBody = validateBody(CreateTodoBody);

/**
 * Registers the authenticated todo routes.
 *
 * The request body is documented from `validateBody`, and the `:id` path
 * parameter is documented as a string without a `params` schema.
 */
export function registerTodosRoutes(router: IRouterApi): void {
  router.group('/todos', (routes) => {
    routes.post('/', {
      middleware: [requireAuth(), createBody],
      schema: {
        tags: ['Todos'],
        summary: 'Create a todo',
        response: { 201: TodoResponse, 401: ProblemDetails },
      },
      handler: (ctx) => ctx.response.status(201).json(createTodo(createBody.value(ctx))),
    });

    routes.get('/:id', {
      middleware: [requireAuth()],
      schema: {
        tags: ['Todos'],
        summary: 'Read a todo',
        response: { 200: TodoResponse, 401: ProblemDetails, 404: ProblemDetails },
      },
      handler: (ctx) => {
        const todo = getTodo(ctx.params.id);
        if (todo === undefined) throw notFound(`Todo ${ctx.params.id} was not found.`);
        return ctx.response.json(todo);
      },
    });
  });
}
