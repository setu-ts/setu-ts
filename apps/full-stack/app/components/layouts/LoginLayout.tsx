import { Outlet } from 'react-router';
import { Card, CardContent } from '~/components/ui/card.tsx';

/** Chrome for unauthenticated pages. */
export default function LoginLayout() {
  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <main className="w-full max-w-sm">
        <Card>
          <CardContent>
            <Outlet />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
