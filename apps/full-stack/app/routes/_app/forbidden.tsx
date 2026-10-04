import { data, type MiddlewareFunction, useRouteError } from 'react-router';

/** Refusal used by the real-build smoke to pin the React Router boundary. */
export const middleware: MiddlewareFunction<Response>[] = [() => {
  throw data(null, { status: 403 });
}];

export default function ForbiddenRoute() {
  return null;
}

/** React Router, not the kernel error responder, renders document refusals. */
export function ErrorBoundary() {
  const error = useRouteError() as { status?: number };
  return <h1>Route boundary refusal: {error.status ?? 'unknown'}</h1>;
}
