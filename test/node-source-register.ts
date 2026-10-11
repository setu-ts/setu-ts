/**
 * Registers {@link ./node-source-hooks.ts} in a test subprocess (`node --import`).
 *
 * @module
 */
import { register } from 'node:module';

register(new URL('./node-source-hooks.ts', import.meta.url));
