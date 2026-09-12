/**
 * Compile-time control for `ViewPluginOptions` — a union discriminated on
 * `engine`, so a missing per-arm field is a compile error rather than a
 * startup throw (M92 §3.13). Self-validating: an unused `@ts-expect-error` is
 * itself a compile error, so this file fails `deno check` if the union stops
 * discriminating.
 *
 * @module
 */
import type { IViewEngine } from '@setu-ts/common';
import type { ViewPluginOptions } from '../../src/plugin/options.ts';

const supplied: IViewEngine = { render: () => '' };

// Control arms check clean.
const defaultArm: ViewPluginOptions = {};
const jsxArm: ViewPluginOptions = { engine: 'hono-jsx' };
const htmlArm: ViewPluginOptions = { engine: 'hono-html' };
const customArm: ViewPluginOptions = { engine: 'custom', view: supplied };

// The 'custom' arm requires `view` — a compile error, not a startup throw.
// @ts-expect-error — the 'custom' arm requires `view`
const missingView: ViewPluginOptions = { engine: 'custom' };

// Exported so the controls are read (noUnusedLocals), not discarded.
export const arms: readonly ViewPluginOptions[] = [
  defaultArm,
  jsxArm,
  htmlArm,
  customArm,
  missingView,
];
