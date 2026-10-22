import { z } from 'zod';

export const CreateNoteBody = z.object({ id: z.string().min(1), text: z.string().min(1) });
export type CreateNoteBody = z.infer<typeof CreateNoteBody>;

export const UpdateNoteBody = CreateNoteBody.pick({ text: true });
export type UpdateNoteBody = z.infer<typeof UpdateNoteBody>;

export type Note = CreateNoteBody;
