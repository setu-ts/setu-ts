import type { CreateTodoBody, TodoResponse } from './todos.schemas.ts';

/** In-memory storage. A real service would use a repository from `DatabasePlugin`. */
const todos = new Map<string, TodoResponse>();

/** Stores a new todo and returns it with its id. */
export function createTodo(body: CreateTodoBody): TodoResponse {
  const todo = { ...body, id: crypto.randomUUID() };
  todos.set(todo.id, todo);
  return todo;
}

/** Reads one todo, or `undefined` when no todo has that id. */
export function getTodo(id: string): TodoResponse | undefined {
  return todos.get(id);
}
