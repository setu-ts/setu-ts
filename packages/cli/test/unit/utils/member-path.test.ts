import { describe, expect, it } from 'vitest';
import { memberPath } from '../../../src/utils/member-path.ts';

describe('memberPath', () => {
  it.each([
    ['/ws/apps\\x///', '/ws/apps\\x'],
    ['apps\\x', 'apps\\x'],
    ['C:\\ws\\apps\\x\\', 'C:/ws/apps/x'],
    ['C:\\ws/apps/x/', 'C:/ws/apps/x'],
    ['C:/ws/apps/x', 'C:/ws/apps/x'],
    ['\\\\server\\share\\apps\\x\\', '//server/share/apps/x'],
    ['/ws/apps/x/', '/ws/apps/x'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(memberPath(input)).toBe(expected);
  });
});
