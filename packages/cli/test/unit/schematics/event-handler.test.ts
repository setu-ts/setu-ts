/**
 * Unit tests for the event-handler schematic (gated on events-plugin).
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateEventHandler } from '../../../src/schematics/event-handler.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateEventHandler', () => {
  it('emits an event handler file implementing IEventHandler', () => {
    const names = deriveNames('user-created');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateEventHandler(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/events/user-created.event-handler.ts');
    expect(files[0].contents).toContain('implements IEventHandler');
  });

  it('handles the event type correctly', () => {
    const names = deriveNames('order-placed');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateEventHandler(names, options);

    expect(files[0].contents).toContain('OrderPlacedEvent');
  });
});
