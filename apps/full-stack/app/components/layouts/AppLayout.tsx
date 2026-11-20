import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';

import { ThemeToggle } from '~/components/theme-toggle.tsx';
import { APP_NAV, isActive } from '~/lib/nav-utils.ts';
import { cn } from 'cn';

/** Chrome for the signed-in application, with one scrolling content region. */
export default function AppLayout() {
  const { pathname } = useLocation();
  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [pathname]);

  const navigation = APP_NAV.map((item) => (
    <NavLink
      key={item.to}
      to={item.to}
      className={cn(
        'block shrink-0 rounded-md px-3 py-2 text-sm',
        isActive(item, pathname) && 'bg-accent text-accent-foreground',
      )}
    >
      {item.label}
    </NavLink>
  ));

  return (
    <div data-shell="frame" className="flex h-dvh flex-col overflow-hidden">
      <header
        data-shell="header"
        className="flex h-14 shrink-0 items-center justify-between border-b px-6"
      >
        <span className="font-semibold">Setu-TS</span>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          {/* A link, not a form: see app/routes/_app/logout.tsx. */}
          <Link to="/logout" className="text-sm underline-offset-4 hover:underline">
            Sign out
          </Link>
        </div>
      </header>
      <nav
        aria-label="Mobile navigation"
        className="flex shrink-0 overflow-x-auto border-b p-2 md:hidden"
      >
        {navigation}
      </nav>
      <div className="flex min-h-0 flex-1">
        <aside
          data-shell="sidebar"
          className="hidden w-56 shrink-0 overflow-y-auto border-r p-3 md:block"
        >
          <nav aria-label="Application navigation">{navigation}</nav>
        </aside>
        <main ref={content} data-shell="content" className="min-w-0 flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
