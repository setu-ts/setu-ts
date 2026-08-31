import { exerciseRealtimeClients } from './driver.ts';

export default {
  async fetch(request: Request): Promise<Response> {
    const baseUrl = new URL(request.url).searchParams.get('baseUrl');
    if (baseUrl === null) {
      return new Response('missing baseUrl', { status: 400 });
    }
    await exerciseRealtimeClients(baseUrl);
    return new Response('ok');
  },
};
