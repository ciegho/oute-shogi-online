// 王手将棋オンライン 対戦サーバーの中身(Cloudflareに依存しない部分)
// ソケットは send(string) / addEventListener('message'|'close'|'error') / close() を持つものなら何でもよい。
import '../public/engine.js';

const S = globalThis.Shogi;
export const TIME = 180000;          // 持ち時間 3分
const FLAG_MARGIN = 30;              // 時間切れ判定の余裕(ms)
const ID_RE = /^[A-Za-z0-9]{10,40}$/;
const SECRET_RE = /^[A-Za-z0-9]{16,64}$/;

function newRecord(secretHash, name) {
  return { secret: secretHash, name, r: 1000, n: 0, w: 0, l: 0, d: 0, created: Date.now() };
}
function cleanName(s) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>&"'`]/g, '').trim();
  return Array.from(s).slice(0, 12).join('') || '名無し';
}
async function sha256(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function eloUpdate(rec, oppRating, score) {
  const e = 1 / (1 + Math.pow(10, (oppRating - rec.r) / 400));
  const k = rec.n < 10 ? 40 : 24;
  const r = Math.max(100, rec.r + Math.round(k * (score - e)));
  return { r, n: rec.n + 1, w: rec.w + (score === 1 ? 1 : 0), l: rec.l + (score === 0 ? 1 : 0), d: rec.d + (score === 0.5 ? 1 : 0) };
}
export function encodeMove(m) { return [m.from, m.to, m.promote ? 1 : 0, m.drop || ''].join(','); }
export function decodeMove(t) {
  const a = String(t).split(',');
  const m = { from: +a[0], to: +a[1], promote: a[2] === '1' };
  if (a[3]) m.drop = a[3];
  return m;
}

export class LobbyCore {
  /**
   * @param {{storage:{get:Function,put:Function}, now?:Function, rand?:Function,
   *          setTimeout?:Function, clearTimeout?:Function, tickMs?:number}} opts
   */
  constructor(opts) {
    this.storage = opts.storage;
    this.now = opts.now || (() => Date.now());
    this.rand = opts.rand || Math.random;
    this.setT = opts.setTimeout || ((f, ms) => setTimeout(f, ms));
    this.clearT = opts.clearTimeout || ((h) => clearTimeout(h));
    this.conns = new Set();
    this.byPid = new Map();       // pid -> conn
    this.recs = new Map();        // pid -> record(キャッシュ)
    this.queue = [];              // {pid, r, since}
    this.games = new Map();       // mid -> game
    this.gameOf = new Map();      // pid -> mid
    this.pendingEnd = new Map();  // pid -> 切断中に終わった対局の結果
    this.tickMs = opts.tickMs || 2000;
    this.tickTimer = opts.noTick ? null : setInterval(() => this.tick(), this.tickMs);
  }
  dispose() { if (this.tickTimer) clearInterval(this.tickTimer); this.games.forEach((g) => g.timer && this.clearT(g.timer)); }

  // ---- 接続 ----
  attach(ws) {
    const conn = { ws, pid: null, open: true };
    this.conns.add(conn);
    ws.addEventListener('message', (ev) => { this.onMessage(conn, ev.data).catch(() => {}); });
    const gone = () => this.onClose(conn);
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    return conn;
  }
  send(conn, obj) {
    if (!conn || !conn.open) return;
    try { conn.ws.send(JSON.stringify(obj)); } catch (e) { /* 切断済み */ }
  }
  onClose(conn) {
    if (!conn.open) return;
    conn.open = false;
    this.conns.delete(conn);
    if (conn.pid && this.byPid.get(conn.pid) === conn) {
      this.byPid.delete(conn.pid);
      this.queue = this.queue.filter((q) => q.pid !== conn.pid);
    }
  }
  async rec(pid) {
    if (this.recs.has(pid)) return this.recs.get(pid);
    const r = (await this.storage.get('p:' + pid)) || null;
    if (r) this.recs.set(pid, r);
    return r;
  }
  async saveRec(pid, r) { this.recs.set(pid, r); await this.storage.put('p:' + pid, r); }

  async onMessage(conn, raw) {
    if (typeof raw !== 'string' || raw.length > 2000) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'ping') { this.send(conn, { t: 'pong' }); return; }
    if (m.t === 'hello') { await this.onHello(conn, m); return; }
    if (!conn.pid) { this.send(conn, { t: 'error', code: 'hello' }); return; }
    switch (m.t) {
      case 'name': await this.onName(conn, m); break;
      case 'queue': this.onQueue(conn); break;
      case 'unqueue': this.queue = this.queue.filter((q) => q.pid !== conn.pid); break;
      case 'move': await this.onMove(conn, m); break;
      case 'resign': await this.onResign(conn); break;
      default: break;
    }
  }

  async onHello(conn, m) {
    if (!ID_RE.test(String(m.id)) || !SECRET_RE.test(String(m.secret))) { this.send(conn, { t: 'error', code: 'auth' }); return; }
    const pid = String(m.id);
    const hash = await sha256(String(m.secret));
    let rec = await this.rec(pid);
    if (!rec) { rec = newRecord(hash, cleanName(m.name)); await this.saveRec(pid, rec); }
    else if (rec.secret !== hash) { this.send(conn, { t: 'error', code: 'auth' }); return; }
    // 同じ人の古い接続は切る
    const old = this.byPid.get(pid);
    if (old && old !== conn) {
      this.send(old, { t: 'error', code: 'replaced' });
      old.pid = null;
      try { old.ws.close(); } catch (e) { /* noop */ }
      old.open = false; this.conns.delete(old);
    }
    conn.pid = pid;
    this.byPid.set(pid, conn);
    this.send(conn, { t: 'welcome', name: rec.name, rating: this.pubRating(rec), online: this.stats() });
    const pe = this.pendingEnd.get(pid);
    if (pe) { this.pendingEnd.delete(pid); this.send(conn, pe); }
    const mid = this.gameOf.get(pid);
    if (mid) this.sendMatched(this.games.get(mid), pid);
  }
  pubRating(rec) { return { r: rec.r, n: rec.n, w: rec.w, l: rec.l, d: rec.d }; }
  stats() { return { players: this.byPid.size, waiting: this.queue.length, playing: this.games.size * 2 }; }

  async onName(conn, m) {
    const rec = await this.rec(conn.pid);
    if (!rec) return;
    const name = cleanName(m.name);
    if (name === rec.name) return;
    rec.name = name;
    await this.saveRec(conn.pid, rec);
  }

  // ---- マッチング ----
  async onQueue(conn) {
    const pid = conn.pid;
    if (this.gameOf.has(pid)) { this.sendMatched(this.games.get(this.gameOf.get(pid)), pid); return; }
    if (!this.queue.some((q) => q.pid === pid)) {
      const rec = await this.rec(pid);
      this.queue.push({ pid, r: rec.r, since: this.now() });
    }
    this.send(conn, { t: 'queued', ...this.stats() });
    this.pair();
  }
  tick() {
    this.pair();
    const st = this.stats();
    this.queue.forEach((q) => this.send(this.byPid.get(q.pid), { t: 'queued', ...st }));
  }
  pair() {
    const now = this.now();
    for (;;) {
      let best = null;
      for (let i = 0; i < this.queue.length; i++) {
        for (let j = i + 1; j < this.queue.length; j++) {
          const a = this.queue[i], b = this.queue[j];
          const diff = Math.abs(a.r - b.r), w = Math.max(now - a.since, now - b.since) / 1000;
          if (diff <= 150 + 40 * w && (!best || diff < best.diff)) best = { a, b, diff };
        }
      }
      if (!best) return;
      this.queue = this.queue.filter((q) => q !== best.a && q !== best.b);
      this.startGame(best.a, best.b);
    }
  }
  startGame(a, b) {
    const [p0, p1] = this.rand() < 0.5 ? [a, b] : [b, a];
    const mid = 'm' + this.now().toString(36) + Math.floor(this.rand() * 1e6).toString(36);
    const st = S.initialState();
    const g = {
      mid, pids: [p0.pid, p1.pid], r: [p0.r, p1.r], st, moves: [], reps: {}, over: false,
      time: [TIME, TIME], turnStart: this.now(), timer: null
    };
    g.reps[S.key(st)] = 1;
    this.games.set(mid, g);
    this.gameOf.set(p0.pid, mid); this.gameOf.set(p1.pid, mid);
    this.armTimer(g);
    this.sendMatched(g, p0.pid); this.sendMatched(g, p1.pid);
  }
  async nameOf(pid) { const r = await this.rec(pid); return r ? r.name : '対戦相手'; }
  sendMatched(g, pid) {
    if (!g) return;
    const side = g.pids.indexOf(pid), opp = g.pids[1 - side];
    const orec = this.recs.get(opp);
    this.send(this.byPid.get(pid), {
      t: 'matched', mid: g.mid, side, oppName: orec ? orec.name : '対戦相手', oppR: g.r[1 - side], myR: g.r[side],
      ...this.stateBody(g)
    });
  }
  stateBody(g) {
    const t = g.time.slice();
    if (!g.over) t[g.st.turn] = Math.max(0, t[g.st.turn] - (this.now() - g.turnStart));
    return { moves: g.moves.slice(), time: t, turn: g.st.turn };
  }
  broadcastState(g) {
    g.pids.forEach((pid) => this.send(this.byPid.get(pid), { t: 'state', mid: g.mid, ...this.stateBody(g) }));
  }

  // ---- 対局 ----
  armTimer(g) {
    if (g.timer) this.clearT(g.timer);
    const left = g.time[g.st.turn] - (this.now() - g.turnStart);
    g.timer = this.setT(() => { g.timer = null; this.checkFlag(g); }, Math.max(0, left) + FLAG_MARGIN);
  }
  checkFlag(g) {
    if (g.over) return;
    const turn = g.st.turn;
    if (g.time[turn] - (this.now() - g.turnStart) <= 0) this.endGame(g, 1 - turn, 'time');
    else this.armTimer(g);
  }
  async onMove(conn, m) {
    const mid = this.gameOf.get(conn.pid);
    const g = mid && this.games.get(mid);
    if (!g || g.over) return;
    const side = g.pids.indexOf(conn.pid);
    if (side !== g.st.turn) { this.send(conn, { t: 'state', mid, ...this.stateBody(g) }); return; }
    const a = m.m;
    if (!Array.isArray(a) || a.length < 3) return;
    const mv = { from: +a[0], to: +a[1], promote: +a[2] === 1 };
    if (a[3]) mv.drop = String(a[3]);
    // 時間切れの後に届いた手は無効
    const used = this.now() - g.turnStart;
    if (g.time[side] - used <= 0) { this.endGame(g, 1 - side, 'time'); return; }
    const ok = S.legalMoves(g.st).some((x) => x.from === mv.from && x.to === mv.to && x.promote === mv.promote && (x.drop || null) === (mv.drop || null));
    if (!ok) { this.send(conn, { t: 'state', mid, ...this.stateBody(g) }); return; }
    g.time[side] -= used;
    g.turnStart = this.now();
    g.st = S.play(g.st, mv);
    g.moves.push(encodeMove(mv));
    this.broadcastState(g);
    if (g.st.winner != null) { await this.endGame(g, g.st.winner, g.st.reason); return; }
    const k = S.key(g.st);
    g.reps[k] = (g.reps[k] || 0) + 1;
    if (g.reps[k] >= 4) { await this.endGame(g, null, 'repetition'); return; }
    this.armTimer(g);
  }
  async onResign(conn) {
    const mid = this.gameOf.get(conn.pid);
    const g = mid && this.games.get(mid);
    if (!g || g.over) return;
    await this.endGame(g, 1 - g.pids.indexOf(conn.pid), 'resign');
  }
  async endGame(g, winnerSide, reason) {
    if (g.over) return;
    g.over = true;
    if (g.timer) { this.clearT(g.timer); g.timer = null; }
    this.games.delete(g.mid);
    g.pids.forEach((pid) => this.gameOf.delete(pid));
    const recs = await Promise.all(g.pids.map((pid) => this.rec(pid)));
    const res = g.pids.map((pid, i) => {
      const score = winnerSide == null ? 0.5 : (winnerSide === i ? 1 : 0);
      const before = recs[i].r;
      const next = eloUpdate(recs[i], g.r[1 - i], score);
      Object.assign(recs[i], next);
      return { pid, from: before, to: next.r, rating: this.pubRating(recs[i]) };
    });
    await Promise.all(g.pids.map((pid, i) => this.saveRec(pid, recs[i])));
    res.forEach((x, i) => {
      const msg = { t: 'end', mid: g.mid, winner: winnerSide, reason, n: g.moves.length, rd: { from: x.from, to: x.to }, rating: x.rating };
      const c = this.byPid.get(x.pid);
      if (c && c.open) this.send(c, msg); else this.pendingEnd.set(x.pid, msg);
    });
  }
}
