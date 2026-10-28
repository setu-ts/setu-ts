/** Shared browser assertions for the two generated styling stories. */
import { expect } from 'vitest';
import type { Page } from 'playwright';

/** Adds content beyond the viewport and drives both element and window scrolling. */
export async function assertFixedShell(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(await page.locator('[data-shell=header]').isVisible()).toBe(true);
  expect(await page.locator('[data-shell=sidebar]').isVisible()).toBe(true);
  const before = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('[data-shell=content]')!;
    const filler = document.createElement('div');
    filler.style.height = '6000px';
    content.append(filler);
    return ['header', 'sidebar'].map(
      (name) => document.querySelector(`[data-shell=${name}]`)!.getBoundingClientRect().top,
    );
  });
  expect(before).toEqual([0, 56]);
  await page.locator('[data-shell=content]').evaluate((element) => {
    element.scrollTop = 3000;
  });
  expect(await page.locator('[data-shell=content]').evaluate((element) => element.scrollTop)).toBe(
    3000,
  );
  await page.evaluate(() => globalThis.scrollTo(0, 3000));
  const after = await page.evaluate(() => ({
    windowY: globalThis.scrollY,
    tops: ['header', 'sidebar'].map(
      (name) => document.querySelector(`[data-shell=${name}]`)!.getBoundingClientRect().top,
    ),
  }));
  expect(after.windowY).toBe(0);
  expect(after.tops).toEqual(before);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page
      .locator('[data-shell=header]')
      .evaluate((element) => element.getBoundingClientRect().top),
  ).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  expect(await page.locator('[data-shell=sidebar]').isVisible()).toBe(false);
  expect(await page.getByRole('navigation', { name: 'Mobile navigation' }).isVisible()).toBe(true);
}

/** Records the state at DOMContentLoaded, before any test can repair it. */
export async function recordEarlyTheme(page: Page, stored: 'dark' | 'light' | null): Promise<void> {
  await page.addInitScript((value) => {
    if (value === null) localStorage.removeItem('theme');
    else localStorage.setItem('theme', value);
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        document.documentElement.dataset['themeAtReady'] =
          document.documentElement.classList.contains('dark') ? 'dark' : 'light';
      },
      { once: true },
    );
  }, stored);
}

/** The initial preference must already have affected the document when parsing completes. */
export async function assertEarlyTheme(page: Page, expected: 'light' | 'dark'): Promise<void> {
  expect(await page.locator('html').getAttribute('data-theme-at-ready')).toBe(expected);
}

/** Compares the resolved token against the computed button colour (including browser normalization). */
export async function assertPrimaryButton(page: Page): Promise<void> {
  const colours = await page.evaluate(() => {
    const button = document.querySelector<HTMLElement>(
      '[data-variant=default], button.bg-primary',
    )!;
    const reference = document.createElement('span');
    reference.style.backgroundColor = 'var(--primary)';
    document.body.append(reference);
    const result = [
      getComputedStyle(button).backgroundColor,
      getComputedStyle(reference).backgroundColor,
    ];
    reference.remove();
    return result;
  });
  expect(colours[0]).toBe(colours[1]);
  expect(colours[0]).not.toBe('rgba(0, 0, 0, 0)');
}

/** System → light → dark → system, with storage, reload and live media changes. */
export async function assertThemeCycle(page: Page, url: string): Promise<void> {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Theme: system', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');
  await page.getByRole('button', { name: 'Theme: light', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
  await page.reload({ waitUntil: 'networkidle' });
  expect(await page.locator('html').evaluate((element) => element.classList.contains('dark'))).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Theme: dark', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBeNull();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
}
