import type { CreateTodoBody, TodoResponse } from './todos.schemas.ts';

/** Stores todos. A real service would use a repository from `DatabasePlugin`. */
export interface TodoStore {
  create(id: string, body: CreateTodoBody): TodoResponse;
  get(id: string): TodoResponse | undefined;
}

/** Creates an in-memory store owned by one application. */
export function createTodoStore(): TodoStore {
  const todos = new Map<string, TodoResponse>();
  return {
    create(id, body) {
      const todo = { ...body, id };
      todos.set(id, todo);
      return todo;
    },
    get: (id) => todos.get(id),
  };
}
