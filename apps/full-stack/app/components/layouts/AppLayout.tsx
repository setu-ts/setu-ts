import { NavLink, Outlet, useLocation } from 'react-router';

import { APP_NAV, isActive } from '~/lib/nav-utils.ts';
import { classNames } from '~/lib/utils.ts';

/** Chrome for the signed-in application. */
export default function AppLayout() {
  const { pathname } = useLocation();

  return (
    <div className='app-shell'>
      <nav>
        {APP_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={classNames('nav-link', isActive(item, pathname) && 'is-active')}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
