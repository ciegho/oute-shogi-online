// 王手将棋オンライン 対戦サーバーの中身(Cloudflareに依存しない部分)
// ソケットは send(string) / addEventListener('message'|'close'|'error') / close() を持つものなら何でもよい。
import '../public/engine.js';
import { cleanName } from './names.js';
import { timingSafeEqual } from './guard.js';
export { cleanName };

const S = globalThis.Shogi;
export const TIME = 180000;          // 持ち時間 3分
export const GOTE_WIN_MULT = 1.5;    // 後手が勝ったとき、レート変動を1.5倍にする
export const LIMITS = {
  MAX_CONNS: 2000,                   // 同時接続の上限
  MAX_CONN_PER_IP: 6,                // 同じIPからの同時接続の上限
  NEW_ACCT_PER_IP_HR: 8,             // 同じIPが1時間に作れるアカウント数
  MAX_ACCOUNTS: 50000,               // 保存するアカウント数の上限
  AUTH_FAIL_LIMIT: 10,               // 同じIPの認証失敗が10分間にこの回数でロック
  MSG_BURST: 30,                     // メッセージ数の瞬間上限
  MSG_RATE: 10,                      // 1秒あたりの補充数
  NAME_COOLDOWN_MS: 10000,           // ニックネーム変更の間隔
  PAIR_RATED_PER_HR: 3,              // 同じ相手とレート対象になる対局数(1時間あたり)
  MIN_PLIES_FOR_WIN_RATING: 6,       // これ未満の手数で投了・時間切れになった勝ちはレートが上がらない
  MAX_PLIES: 400,                    // 最大手数(超えたら引き分け)
  LAG_QUOTA_MAX: 2000,               // 通信遅れの補正の持ち分(ms)
  LAG_REGEN: 100,                    // 1手ごとに回復する補正(ms)
  LAG_RTT_CAP: 1500                  // 1手あたり補正する遅れの上限(ms)
};
const FLAG_MARGIN = 30;              // 時間切れ判定の余裕(ms)
const ID_RE = /^[A-Za-z0-9]{10,40}$/;
const SECRET_RE = /^[A-Za-z0-9]{16,64}$/;
const HOUR = 3600000;

function newRecord(secretHash, name) {
  return { secret: secretHash, name, r: 1000, n: 0, w: 0, l: 0, d: 0, created: Date.now(), nameAt: 0 };
}
async function sha256(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(a, b);
/** レーティング更新。mult は後手勝ちのときの倍率。 */
export function eloUpdate(rec, oppRating, score, mult = 1) {
  const e = 1 / (1 + Math.pow(10, (oppRating - rec.r) / 400));
  const k = rec.n < 10 ? 40 : 24;
  const delta = Math.round(Math.round(k * (score - e)) * mult);
  const r = Math.max(100, rec.r + delta);
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
   * @param {{storage:{get:Function,put:Function,list?:Function}, now?:Function, rand?:Function,
   *          setTimeout?:Function, clearTimeout?:Function, tickMs?:number, noTick?:boolean, rateSameIp?:boolean}} opts
   */
  constructor(opts) {
    this.storage = opts.storage;
    this.now = opts.now || (() => Date.now());
    this.rand = opts.rand || Math.random;
    this.setT = opts.setTimeout || ((f, ms) => setTimeout(f, ms));
    this.clearT = opts.clearTimeout || ((h) => clearTimeout(h));
    this.rateSameIp = !!opts.rateSameIp;
    this.conns = new Set();
    this.byPid = new Map();       // pid -> conn
    this.recs = new Map();        // pid -> record(全アカウントをメモリに保持)
    this.queue = [];              // {pid, r, since}
    this.games = new Map();       // mid -> game
    this.gameOf = new Map();      // pid -> mid
    this.pendingEnd = new Map();  // pid -> 切断中に終わった対局の結果
    this.ipConns = new Map();     // ip -> 接続数
    this.ipNew = new Map();       // ip -> 新規アカウント作成の時刻
    this.ipFail = new Map();      // ip -> {n, at} 認証失敗
    this.pairHist = new Map();    // "a|b" -> 対局終了時刻
    this.boardCache = null;
    this.tickMs = opts.tickMs || 2000;
    this.ready = this.loadAll();
    this.tickTimer = opts.noTick ? null : setInterval(() => this.tick(), this.tickMs);
  }
  dispose() { if (this.tickTimer) clearInterval(this.tickTimer); this.games.forEach((g) => g.timer && this.clearT(g.timer)); }
  async loadAll() {
    if (this.storage.list) {
      const m = await this.storage.list({ prefix: 'p:' });
      for (const [k, v] of m) this.recs.set(k.slice(2), v);
    }
  }

  // ---- 接続 ----
  attach(ws, meta = {}) {
    const ip = meta.ip || 'unknown';
    const conn = { ws, pid: null, open: true, ip, tokens: LIMITS.MSG_BURST, tokAt: this.now(), strikes: 0, rtt: [], spn: 0, spts: 0 };
    const cnt = this.ipConns.get(ip) || 0;
    if (this.conns.size >= LIMITS.MAX_CONNS || cnt >= LIMITS.MAX_CONN_PER_IP) {
      conn.open = true;
      this.send(conn, { t: 'error', code: 'busy' });
      conn.open = false;
      try { ws.close(1013, 'busy'); } catch (e) { /* noop */ }
      return conn;
    }
    this.ipConns.set(ip, cnt + 1);
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
  kick(conn, code) {
    this.send(conn, { t: 'error', code });
    try { conn.ws.close(); } catch (e) { /* noop */ }
    this.onClose(conn);
  }
  onClose(conn) {
    if (conn.closed) return;
    conn.closed = true;
    conn.open = false;
    this.conns.delete(conn);
    const c = (this.ipConns.get(conn.ip) || 1) - 1;
    if (c <= 0) this.ipConns.delete(conn.ip); else this.ipConns.set(conn.ip, c);
    if (conn.pid && this.byPid.get(conn.pid) === conn) {
      this.byPid.delete(conn.pid);
      this.queue = this.queue.filter((q) => q.pid !== conn.pid);
    }
  }
  takeToken(conn, cost) {
    const now = this.now();
    conn.tokens = Math.min(LIMITS.MSG_BURST, conn.tokens + ((now - conn.tokAt) / 1000) * LIMITS.MSG_RATE);
    conn.tokAt = now;
    if (conn.tokens < cost) { conn.strikes++; return false; }
    conn.tokens -= cost;
    return true;
  }

  async onMessage(conn, raw) {
    if (!conn.open) return;
    if (typeof raw !== 'string' || raw.length > 2000) { if (++conn.strikes > 20) this.kick(conn, 'flood'); return; }
    if (!this.takeToken(conn, 1)) { if (conn.strikes > 40) this.kick(conn, 'flood'); return; }
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    await this.ready;
    if (m.t === 'ping') { this.send(conn, { t: 'pong' }); return; }
    if (m.t === 'spong') { this.onSpong(conn, m); return; }
    if (m.t === 'hello') { await this.onHello(conn, m); return; }
    if (!conn.pid) { this.send(conn, { t: 'error', code: 'hello' }); return; }
    switch (m.t) {
      case 'name': await this.onName(conn, m); break;
      case 'queue': await this.onQueue(conn); break;
      case 'unqueue': this.queue = this.queue.filter((q) => q.pid !== conn.pid); break;
      case 'move': await this.onMove(conn, m); break;
      case 'resign': await this.onResign(conn); break;
      case 'board': if (this.takeToken(conn, 5)) this.send(conn, this.board(conn.pid)); break;
      case 'rank': if (this.takeToken(conn, 5)) { const b = this.board(conn.pid); this.send(conn, { t: 'rank', list: b.top, me: b.me, total: b.total, min: 3 }); } break;
      default: break;
    }
  }

  // ---- ログイン ----
  failCount(ip) {
    const f = this.ipFail.get(ip);
    if (!f || this.now() - f.at > 600000) return 0;
    return f.n;
  }
  noteFail(ip) {
    const f = this.ipFail.get(ip);
    const n = f && this.now() - f.at <= 600000 ? f.n + 1 : 1;
    this.ipFail.set(ip, { n, at: this.now() });
  }
  allowNewAccount(ip) {
    const now = this.now();
    const list = (this.ipNew.get(ip) || []).filter((t) => now - t < HOUR);
    if (list.length >= LIMITS.NEW_ACCT_PER_IP_HR) { this.ipNew.set(ip, list); return false; }
    list.push(now); this.ipNew.set(ip, list);
    return true;
  }
  async onHello(conn, m) {
    if (conn.pid) return;
    if (this.failCount(conn.ip) >= LIMITS.AUTH_FAIL_LIMIT) { this.kick(conn, 'locked'); return; }
    if (!ID_RE.test(String(m.id)) || !SECRET_RE.test(String(m.secret))) { this.noteFail(conn.ip); this.kick(conn, 'auth'); return; }
    const pid = String(m.id);
    const hash = await sha256(String(m.secret));
    let rec = this.recs.get(pid);
    if (!rec) {
      if (this.recs.size >= LIMITS.MAX_ACCOUNTS) { this.kick(conn, 'full'); return; }
      if (!this.allowNewAccount(conn.ip)) { this.kick(conn, 'limit'); return; }
      rec = newRecord(hash, cleanName(m.name));
      await this.saveRec(pid, rec);
    } else if (!safeEqual(rec.secret, hash)) {
      this.noteFail(conn.ip);
      this.kick(conn, 'auth');
      return;
    }
    if (!conn.open) return;
    const old = this.byPid.get(pid);
    if (old && old !== conn) {      // 同じ人の古い接続は切る
      this.send(old, { t: 'error', code: 'replaced' });
      old.pid = null;
      try { old.ws.close(); } catch (e) { /* noop */ }
      this.onClose(old);
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
  async saveRec(pid, r) { this.recs.set(pid, r); await this.storage.put('p:' + pid, r); }

  async onName(conn, m) {
    const rec = this.recs.get(conn.pid);
    if (!rec) return;
    if (this.now() - (rec.nameAt || 0) < LIMITS.NAME_COOLDOWN_MS) return;
    const name = cleanName(m.name);
    if (name === rec.name) return;
    rec.name = name; rec.nameAt = this.now();
    this.boardCache = null;
    await this.saveRec(conn.pid, rec);
  }

  // ---- ランキング ----
  board(pid) {
    const now = this.now();
    if (!this.boardCache || now - this.boardCache.at > 30000) {
      const arr = [];
      for (const [id, r] of this.recs) if (r.n >= 3) arr.push({ id, name: r.name, r: r.r, n: r.n });
      arr.sort((a, b) => b.r - a.r || b.n - a.n);
      this.boardCache = { at: now, arr };
    }
    const arr = this.boardCache.arr;
    const idx = arr.findIndex((x) => x.id === pid);
    return {
      t: 'board', total: arr.length,
      top: arr.slice(0, 20).map((x, i) => ({ rank: i + 1, name: x.name, r: x.r, n: x.n })),
      me: idx >= 0 ? { rank: idx + 1, r: arr[idx].r } : null
    };
  }

  // ---- マッチング ----
  async onQueue(conn) {
    const pid = conn.pid;
    if (this.gameOf.has(pid)) { this.sendMatched(this.games.get(this.gameOf.get(pid)), pid); return; }
    if (!this.queue.some((q) => q.pid === pid)) this.queue.push({ pid, r: this.recs.get(pid).r, since: this.now() });
    this.send(conn, { t: 'queued', ...this.stats() });
    this.pair();
  }
  tick() {
    this.pair();
    const now = this.now();
    for (const [k, v] of this.pairHist) { const keep = v.filter((t) => now - t < HOUR); if (keep.length) this.pairHist.set(k, keep); else this.pairHist.delete(k); }
    const st = this.stats();
    this.queue.forEach((q) => this.send(this.byPid.get(q.pid), { t: 'queued', ...st }));
    this.games.forEach((g) => g.pids.forEach((pid) => this.sendSping(this.byPid.get(pid))));
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
    const ipOf = (pid) => { const c = this.byPid.get(pid); return c ? c.ip : 'unknown'; };
    const g = {
      mid, pids: [p0.pid, p1.pid], r: [p0.r, p1.r], ips: [ipOf(p0.pid), ipOf(p1.pid)], st, moves: [], reps: {}, over: false,
      time: [TIME, TIME], turnStart: this.now(), timer: null, quota: [LIMITS.LAG_QUOTA_MAX, LIMITS.LAG_QUOTA_MAX]
    };
    g.reps[S.key(st)] = 1;
    this.games.set(mid, g);
    this.gameOf.set(p0.pid, mid); this.gameOf.set(p1.pid, mid);
    this.armTimer(g);
    this.sendMatched(g, p0.pid); this.sendMatched(g, p1.pid);
    this.sendSping(this.byPid.get(p0.pid)); this.sendSping(this.byPid.get(p1.pid));
  }
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

  // ---- 通信遅れの測定と補正 ----
  sendSping(conn) {
    if (!conn || !conn.open) return;
    conn.spn++; conn.spts = this.now();
    this.send(conn, { t: 'sping', n: conn.spn });
  }
  onSpong(conn, m) {
    if (!conn.spts || m.n !== conn.spn) return;
    const s = Math.min(this.now() - conn.spts, 5000);
    conn.spts = 0;
    conn.rtt.push(s);
    if (conn.rtt.length > 5) conn.rtt.shift();
  }
  // 直近の測定のうち最小値(わざと返事を遅らせても全部遅らせない限り増えない)
  rttOf(pid) {
    const c = this.byPid.get(pid);
    return c && c.rtt.length ? Math.min(...c.rtt, LIMITS.LAG_RTT_CAP) : 0;
  }
  lagCredit(g, side) { return Math.max(0, Math.min(this.rttOf(g.pids[side]), g.quota[side])); }

  // ---- 対局 ----
  armTimer(g) {
    if (g.timer) this.clearT(g.timer);
    const turn = g.st.turn;
    const deadline = g.turnStart + g.time[turn] + this.lagCredit(g, turn);
    g.timer = this.setT(() => { g.timer = null; this.checkFlag(g); }, Math.max(0, deadline - this.now()) + FLAG_MARGIN);
  }
  checkFlag(g) {
    if (g.over) return;
    const turn = g.st.turn;
    if (this.now() >= g.turnStart + g.time[turn] + this.lagCredit(g, turn)) this.endGame(g, 1 - turn, 'time');
    else this.armTimer(g);
  }
  async onMove(conn, m) {
    const mid = this.gameOf.get(conn.pid);
    const g = mid && this.games.get(mid);
    if (!g || g.over) return;
    const side = g.pids.indexOf(conn.pid);
    if (side !== g.st.turn) { this.send(conn, { t: 'state', mid, ...this.stateBody(g) }); return; }
    const a = m.m;
    if (!Array.isArray(a) || a.length < 3 || a.length > 4) return;
    const mv = { from: +a[0], to: +a[1], promote: +a[2] === 1 };
    if (a[3]) mv.drop = String(a[3]);
    const usedRaw = this.now() - g.turnStart;
    const credit = Math.min(this.lagCredit(g, side), usedRaw);
    if (g.time[side] - (usedRaw - credit) <= 0) { await this.endGame(g, 1 - side, 'time'); return; }   // 時間切れの後に届いた手
    const ok = S.legalMoves(g.st).some((x) => x.from === mv.from && x.to === mv.to && x.promote === mv.promote && (x.drop || null) === (mv.drop || null));
    if (!ok) { this.send(conn, { t: 'state', mid, ...this.stateBody(g) }); return; }
    g.time[side] -= usedRaw - credit;
    g.quota[side] = Math.min(LIMITS.LAG_QUOTA_MAX, g.quota[side] - credit + LIMITS.LAG_REGEN);
    g.turnStart = this.now();
    g.st = S.play(g.st, mv);
    g.moves.push(encodeMove(mv));
    this.broadcastState(g);
    if (g.st.winner != null) { await this.endGame(g, g.st.winner, g.st.reason); return; }
    const k = S.key(g.st);
    g.reps[k] = (g.reps[k] || 0) + 1;
    if (g.reps[k] >= 4) { await this.endGame(g, null, 'repetition'); return; }
    if (g.moves.length >= LIMITS.MAX_PLIES) { await this.endGame(g, null, 'maxmoves'); return; }
    this.armTimer(g);
  }
  async onResign(conn) {
    const mid = this.gameOf.get(conn.pid);
    const g = mid && this.games.get(mid);
    if (!g || g.over) return;
    await this.endGame(g, 1 - g.pids.indexOf(conn.pid), 'resign');
  }

  /** 対局終了。レート対象かどうかと変動を決めて両者に通知する。 */
  async endGame(g, winnerSide, reason) {
    if (g.over) return;
    g.over = true;
    if (g.timer) { this.clearT(g.timer); g.timer = null; }
    this.games.delete(g.mid);
    g.pids.forEach((pid) => this.gameOf.delete(pid));

    const now = this.now();
    let rated = true, note = null;
    if (!this.rateSameIp && g.ips[0] !== 'unknown' && g.ips[0] === g.ips[1]) { rated = false; note = 'sameip'; }
    const key = [...g.pids].sort().join('|');
    const hist = (this.pairHist.get(key) || []).filter((t) => now - t < HOUR);
    if (rated && hist.length >= LIMITS.PAIR_RATED_PER_HR) { rated = false; note = 'pair'; }
    hist.push(now); this.pairHist.set(key, hist);
    const quick = winnerSide != null && g.moves.length < LIMITS.MIN_PLIES_FOR_WIN_RATING && (reason === 'resign' || reason === 'time');
    const mult = winnerSide === 1 ? GOTE_WIN_MULT : 1;

    const recs = g.pids.map((pid) => this.recs.get(pid));
    const out = g.pids.map((pid, i) => {
      const before = recs[i].r;
      let next = null, n = null;
      if (rated) {
        if (quick && winnerSide === i) n = 'quick';          // 勝者はレートが上がらない(敗者は下がる)
        else {
          const score = winnerSide == null ? 0.5 : (winnerSide === i ? 1 : 0);
          next = eloUpdate(recs[i], g.r[1 - i], score, mult);
        }
      }
      if (next) Object.assign(recs[i], next);
      return { pid, from: before, to: recs[i].r, note: note || n, applied: !!next };
    });
    this.boardCache = null;
    await Promise.all(g.pids.map((pid, i) => this.saveRec(pid, recs[i])));
    out.forEach((x, i) => {
      const msg = {
        t: 'end', mid: g.mid, winner: winnerSide, reason, n: g.moves.length, rd: { from: x.from, to: x.to },
        rating: this.pubRating(recs[i]), rated: x.applied, note: x.note, why: x.note === 'sameip' ? 'same_ip' : x.note, mult: x.applied ? mult : 1, bonus: x.applied && mult > 1
      };
      const c = this.byPid.get(x.pid);
      if (c && c.open) this.send(c, msg); else this.pendingEnd.set(x.pid, msg);
    });
  }
}
