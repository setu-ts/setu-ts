import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { generateWsRoute } from '../../../src/schematics/ws-route.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { options } from './_shared.ts';

describe('ws-route schematic', () => {
  it('emits a websocket-plugin-gated route plugin and its managed barrel', () => {
    const files = generateWsRoute(deriveNames('board'), options(['websocket-plugin']));
    expect(files.map((file) => file.path)).toEqual([
      'src/plugins/board.plugin.ts',
      'src/plugins/index.ts',
    ]);
    expect(files[0]?.contents).toContain("websocket.route('/ws/board'");
    expect(files[0]?.contents).toContain("dependencies: ['websocket-plugin']");
    expect(files[1]?.managed).toBe(true);
  });
});
