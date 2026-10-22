import { z } from 'zod';

export const CreateTodoBody = z.object({ title: z.string().min(1) });
export type CreateTodoBody = z.infer<typeof CreateTodoBody>;

export const TodoResponse = CreateTodoBody.extend({ id: z.string() });
export type TodoResponse = z.infer<typeof TodoResponse>;
