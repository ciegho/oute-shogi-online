// Cloudflare Workers の入口。画面(public/)は静的配信され、/ws だけここで処理する。
import { LobbyCore } from './core.js';
import { originOk } from './guard.js';

// 全員が同じ1つの Durable Object につながる(マッチングと対局を1か所で扱う)
export class Lobby {
  constructor(state, env) {
    this.core = new LobbyCore({ storage: state.storage, rateSameIp: env && env.RATE_SAME_IP === '1' });
  }
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocketでつないでください', { status: 426 });
    }
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.core.attach(server, { ip });
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      // 他のサイトのページから勝手につながれないよう、ブラウザのOriginを確認する
      const origin = request.headers.get('Origin');
      if (!originOk(origin, url.host)) return new Response('Forbidden', { status: 403 });
      const id = env.LOBBY.idFromName('main');
      return env.LOBBY.get(id).fetch(request);
    }
    return new Response('Not found', { status: 404 });
  }
};
