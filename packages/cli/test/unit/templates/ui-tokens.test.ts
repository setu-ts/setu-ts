import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  renderThemeScript,
  renderTokenCss,
  TAILWIND_RANGE,
  THEME_STORAGE_KEY,
} from '../../../src/templates/ui-tokens.ts';
import { FULL_STACK_NPM_DEV_DEPENDENCIES } from '../../../src/templates/full-stack-build-files.ts';

const tokens =
  'background foreground card card-foreground popover popover-foreground primary primary-foreground secondary secondary-foreground muted muted-foreground accent accent-foreground destructive border input ring radius'.split(
    ' ',
  );

describe('shared styling', () => {
  it('defines every neutral token in each mode, with Tailwind mappings', () => {
    const css = renderTokenCss();
    const light = css.split(':root {')[1]!.split('}')[0]!;
    const dark = css.split('.dark {')[1]!.split('}')[0]!;
    for (const token of tokens) {
      expect(light).toContain(`--${token}:`);
      expect(dark).toContain(`--${token}:`);
      if (token !== 'radius') expect(css).toContain(`--color-${token}: var(--${token})`);
    }
    for (const size of ['sm', 'md', 'lg', 'xl']) expect(css).toContain(`--radius-${size}:`);
    expect(css).toContain('@custom-variant dark (&:where(.dark, .dark *))');
    expect(css).toContain('@apply bg-background text-foreground');
    expect(FULL_STACK_NPM_DEV_DEPENDENCIES['@tailwindcss/vite']).toBe(TAILWIND_RANGE);
    expect(FULL_STACK_NPM_DEV_DEPENDENCIES['tailwindcss']).toBe(TAILWIND_RANGE);
  });

  for (const stored of ['light', 'dark', null, 'untrusted <img>']) {
    for (const systemDark of [true, false]) {
      for (const throwing of [true, false]) {
        it(`applies ${stored} × system dark ${systemDark} × storage error ${throwing}`, () => {
          let applied: boolean | undefined;
          const style = { colorScheme: '' };
          runInNewContext(renderThemeScript(), {
            localStorage: {
              getItem(key: string) {
                expect(key).toBe(THEME_STORAGE_KEY);
                if (throwing) throw new Error('private mode');
                return stored;
              },
            },
            matchMedia(query: string) {
              expect(query).toBe('(prefers-color-scheme: dark)');
              return { matches: systemDark };
            },
            document: {
              documentElement: {
                style,
                classList: {
                  toggle(name: string, dark: boolean) {
                    expect(name).toBe('dark');
                    applied = dark;
                  },
                },
              },
            },
          });
          const value = throwing ? null : stored;
          const dark = value === 'dark' || (value !== 'light' && systemDark);
          expect(applied).toBe(dark);
          expect(style.colorScheme).toBe(dark ? 'dark' : 'light');
        });
      }
    }
  }
});
