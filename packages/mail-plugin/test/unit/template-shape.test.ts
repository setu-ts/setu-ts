/**
 * The `MailTemplate` union's arms do not mix (M102 §3.2): a template carrying
 * both `view` and `html` is a COMPILE error, not a precedence rule. The
 * `@ts-expect-error` directives are self-validating — an unused one is itself
 * a compile error — so a widening of either arm fails `deno check` here.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { Component } from '@setu-ts/common';

import type {
  MailComponentTemplate,
  MailStringTemplate,
  MailTemplate,
} from '../../src/interfaces/index.ts';

interface Props {
  readonly name: string;
}
const Typed: Component<Props> = (p) => `<p>${p.name}</p>`;

// Positive controls: each arm accepts its own shape, and a TYPED component is
// assignable to the `Component<never>` the arm declares.
const componentArm: MailComponentTemplate = { view: Typed, text: Typed };
const stringArm: MailStringTemplate = { html: '<b>{{ name }}</b>', text: '{{ name }}' };
const viaUnion: MailTemplate[] = [componentArm, stringArm, { view: Typed }, { text: 'x' }];

// Mixed literals are refused in BOTH orders.
// @ts-expect-error — `html` is `never` on the component arm.
const mixedA: MailTemplate = { view: Typed, html: '<b>x</b>' };
// @ts-expect-error — `view` is `never` on the string arm.
const mixedB: MailTemplate = { html: '<b>x</b>', view: Typed };

describe('MailTemplate union shape (M102)', () => {
  it('admits each arm and refuses a mix (the refusals are compile-time)', () => {
    expect(viaUnion).toHaveLength(4);
    expect('view' in mixedA).toBe(true);
    expect('view' in mixedB).toBe(true);
  });
});
