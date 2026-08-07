/**
 * Pins the structural-compatibility claim.
 *
 * README, PUBLIC_API and the CLAUDE.md entry all state that `DurableObjectLock`
 * satisfies `scheduler-plugin`'s `IDistributedLock` without importing it —
 * §2.2 forbids a plugin importing a plugin, so the compatibility is structural
 * and nothing but a test can hold it. Before this, the claim was true only by
 * luck: a drift in `IDistributedLock` would have broken every consumer with
 * nothing in this package failing.
 *
 * The assertion is the `SchedulerPlugin({ distributedLock: { lock } })` call
 * itself — it does not type-check if the shapes diverge.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import type { IRuntimeServices } from '@setu-ts/common';

import { DurableObjectLock } from '../../../src/index.ts';
import { FakeDurableObjectNamespace } from '../../do-fakes.ts';

describe('DurableObjectLock ↔ SchedulerPlugin', () => {
  it('is accepted by the real distributedLock.lock option', () => {
    const lock = new DurableObjectLock(new FakeDurableObjectNamespace('lock'), {
      runtime: { uuid: () => 'token-1' } as unknown as IRuntimeServices,
    });

    // `enabled: true` is deliberately absent: resolveLock consults `lock`
    // before `enabled`, so an injected lock wins outright.
    const plugin = SchedulerPlugin({ distributedLock: { lock } });

    expect(plugin.name).toBe('scheduler-plugin');
  });
});
