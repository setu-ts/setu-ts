/**
 * The front Worker (framework-free): `wrangler dev` exposes only the first
 * configuration, so this one routes `/a/*` to Worker A, `/b/*` to Worker B,
 * and `/hub-count` to the hub's fixture-only socket count. `/worker-to-worker`
 * opens a socket to Worker A's `/chat` the way one Worker calls another over a
 * service binding — only `Upgrade: websocket`, no key — and answers the status.
 *
 * @module
 */
interface Binding {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

/** The client half workerd puts on a 101 from `fetch`. */
interface UpgradedSocket {
  accept(): void;
  close(code?: number): void;
}

interface FrontEnv {
  readonly A: Binding;
  readonly B: Binding;
  readonly REALTIME: { idFromName(name: string): unknown; get(id: unknown): Binding };
}

export default {
  fetch(request: Request, env: FrontEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/worker-to-worker') {
      return env.A.fetch('https://a/chat', { headers: { Upgrade: 'websocket' } }).then(
        (response) => {
          const socket = (response as Response & { webSocket?: UpgradedSocket | null }).webSocket;
          if (socket) {
            socket.accept();
            socket.close(1000);
          }
          return new Response(String(response.status));
        },
      );
    }
    if (url.pathname === '/hub-count') {
      return env.REALTIME.get(env.REALTIME.idFromName('chat')).fetch('https://hub/count');
    }
    const [, target, ...rest] = url.pathname.split('/');
    const worker = target === 'a' ? env.A : target === 'b' ? env.B : undefined;
    if (worker === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    url.pathname = `/${rest.join('/')}`;
    return worker.fetch(new Request(url, request));
  },
};
