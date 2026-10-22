/**
 * The task modules the pool runs, addressed by specifier.
 *
 * A worker loads its task by module URL, never by closure, so these are URLs
 * rather than imports.
 */
export const SPIN_TASK = new URL('./spin.task.ts', import.meta.url).href;
export const FILL_TASK = new URL('./fill.task.ts', import.meta.url).href;

export type { FillInput } from './fill.task.ts';
