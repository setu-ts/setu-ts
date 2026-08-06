import { Outlet } from 'react-router';

/** Chrome for unauthenticated pages. */
export default function LoginLayout() {
  return (
    <div className='auth-shell'>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
