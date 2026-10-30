import type { IRouterApi } from '@setu-ts/common';
import { registerTodosRoutes } from './todos.controller.ts';
import { createTodoStore } from './todos.service.ts';

/** Registers the todos feature, with a store owned by this application. */
export function registerTodosModule(router: IRouterApi): void {
  registerTodosRoutes(router, createTodoStore());
}
