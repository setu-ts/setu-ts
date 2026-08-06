/** Navigation helpers shared by the layouts. */

/** One entry in the application navigation. */
export interface NavItem {
  /** Link target. */
  readonly to: string;
  /** Visible label. */
  readonly label: string;
}

/** The signed-in application navigation. */
export const APP_NAV: readonly NavItem[] = [
  { to: '/products', label: 'Products' },
];

/** Reports whether a nav entry matches the current path. */
export function isActive(item: NavItem, pathname: string): boolean {
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}
