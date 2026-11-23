export class ChatRoom {
  constructor(state) {
    this.state = state;
    this.sessions = new Map();
    this.bannedHashes = new Map();
  }

  async fetch(request) {
    const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
    const ipHash = await this.hashIp(ip);

    const banUntil = this.bannedHashes.get(ipHash);
    if (banUntil && Date.now() < banUntil) {
      return new Response('Доступ ограничен', { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const session = { ws: server, nick: '', role: '', isAdmin: false, ipHash, lastMsg: 0 };
    this.sessions.set(server, session);

    server.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'join') {
          const cleanNick = String(data.nick || '').slice(0, 18).trim();
          if (!cleanNick || [...this.sessions.values()].some(s => s.nick === cleanNick)) {
            server.close(1008, 'Ник занят или пуст');
            return;
          }
          session.nick = cleanNick;
          session.role = String(data.role || 'Наблюдатель').slice(0, 20);
          session.isAdmin = data.pass === this.state.env?.ADMIN_PASS;
          server.send(JSON.stringify({ type: 'auth', isAdmin: session.isAdmin }));
          this.broadcastUsers();
        }

        if (data.type === 'msg' && session.nick) {
          if (Date.now() - session.lastMsg < 1200) return;
          session.lastMsg = Date.now();
          const text = String(data.text || '').slice(0, 500).trim();
          if (!text) return;

          const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
          const payload = JSON.stringify({
            type: 'msg',
            room: data.room === 'general' ? 'general' : 'private',
            from: session.nick,
            to: data.to || 'general',
            role: session.role,
            text,
            time
          });

          if (data.room === 'general') {
            this.broadcast(payload);
          } else {
            for (const s of this.sessions.values()) {
              if (s.nick === data.to || s.nick === session.nick) s.ws.send(payload);
            }
          }
        }

        if (data.type === 'kick' && session.isAdmin) {
          for (const [ws, target] of this.sessions.entries()) {
            if (target.nick === data.target && !target.isAdmin) {
              this.bannedHashes.set(target.ipHash, Date.now() + 86400000);
              ws.send(JSON.stringify({ type: 'kicked' }));
              ws.close(1000, 'Kicked');
              this.sessions.delete(ws);
            }
          }
          this.broadcastUsers();
        }
      } catch {}
    });

    server.addEventListener('close', () => {
      this.sessions.delete(server);
      this.broadcastUsers();
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(msg) {
    for (const ws of this.sessions.keys()) {
      try { ws.send(msg); } catch {}
    }
  }

  broadcastUsers() {
    const list = [...this.sessions.values()]
      .filter(s => s.nick)
      .map(s => ({ nick: s.nick, role: s.role }));
    this.broadcast(JSON.stringify({ type: 'users', list }));
  }

  async hashIp(ip) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + '_obitel_salt_2026'));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

   if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const id = env.CHAT_ROOM.idFromName('global-obitel-room');
      const room = env.CHAT_ROOM.get(id);
      return room.fetch(request);
    }
    
    return new Response('Обитель • WebSocket шлюз активен', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
};
