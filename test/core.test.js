import { LobbyCore, TIME, decodeMove } from '../src/core.js';
const S = globalThis.Shogi;
let fails = 0;
const check = (name, cond, extra) => { if (!cond) { fails++; console.log('NG', name, extra ?? ''); } else console.log('ok', name); };

let clock = 1_000_000;
const timers = [];
const core = new LobbyCore({
  storage: (() => { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); } }; })(),
  now: () => clock, noTick: true,
  setTimeout: (f, ms) => { const h = { f, at: clock + ms }; timers.push(h); return h; },
  clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); }
});
const advance = async (ms) => { clock += ms; for (const h of timers.slice()) if (h.at <= clock) { timers.splice(timers.indexOf(h), 1); h.f(); } await tick(); };
const tick = () => new Promise((r) => setTimeout(r, 5));

function client(id) {
  const inbox = []; const ls = {};
  const ws = { send: (s) => inbox.push(JSON.parse(s)), addEventListener: (t, f) => { ls[t] = f; }, close: () => { ls.close && ls.close(); } };
  core.attach(ws);
  const c = {
    id, inbox, ws,
    say: async (o) => { ls.message({ data: JSON.stringify(o) }); await tick(); },
    last: (t) => [...inbox].reverse().find((m) => m.t === t),
    all: (t) => inbox.filter((m) => m.t === t),
    drop: () => { ls.close(); }
  };
  return c;
}
const rid = (c) => c.padEnd(12, 'x'); const sec = 'S'.repeat(20);
async function login(c, name) { await c.say({ t: 'hello', id: rid(c.id), secret: sec + c.id, name }); }

const A = client('alice'), B = client('bobby');
await login(A, 'アリス'); await login(B, 'ボブ');
check('welcome A', A.last('welcome')?.rating.r === 1000);
// 認証
const evil = client('alice'); await evil.say({ t: 'hello', id: rid('alice'), secret: 'Z'.repeat(20), name: 'x' });
check('bad secret rejected', evil.last('error')?.code === 'auth');
await A.say({ t: 'queue' }); check('queued', !!A.last('queued'));
await B.say({ t: 'queue' });
const mA = A.last('matched'), mB = B.last('matched');
check('matched both', mA && mB && mA.mid === mB.mid && mA.side !== mB.side, [mA, mB]);
check('opp names', mA.oppName === 'ボブ' && mB.oppName === 'アリス');
const pl = [A, B]; const bySide = (s) => (mA.side === s ? A : B);

// 不正手: 手番でない側/不正な手は状態の再送だけ
await bySide(1).say({ t: 'move', m: [60, 51, 0, ''] });
check('wrong turn ignored', B.all('state').length + A.all('state').length >= 1);
await bySide(0).say({ t: 'move', m: [0, 80, 0, ''] });   // 不正
check('illegal ignored', (bySide(0).last('state')?.moves.length ?? 0) === 0);

// 先手 7六歩
let st = S.initialState();
async function play(side, mv) { await bySide(side).say({ t: 'move', m: [mv.from, mv.to, mv.promote ? 1 : 0, mv.drop || ''] }); }
// ランダムに指して決着まで
let ended = null, n = 0;
while (!ended && n < 400) {
  const turn = A.last('state')?.turn ?? 0;
  const g = S.legalMoves(st); const mv = g[(Math.random() * g.length) | 0];
  clock += 1000; await play(st.turn, mv); st = S.play(st, mv); n++;
  ended = A.last('end');
  await tick();
}
const eA = A.last('end'), eB = B.last('end');
check('game ended with check', eA && eB && eA.reason === 'check', eA);
check('winner side consistent', eA.winner === eB.winner && eA.winner === st.winner, [eA.winner, st.winner]);
check('rating moved', eA.rd.to !== eA.rd.from && eA.rating.n === 1);
check('rating zero-sum-ish', (eA.rd.to - eA.rd.from) + (eB.rd.to - eB.rd.from) === 0);
check('clock charged', A.last('state').time[0] < TIME);

// 投了
await A.say({ t: 'queue' }); await B.say({ t: 'queue' });
const m2 = A.last('matched'); check('rematch new mid', m2.mid !== mA.mid);
await A.say({ t: 'resign' });
const rA = A.last('end');
check('resign: B wins', rA.reason === 'resign' && rA.winner === (1 - m2.side), rA);

// 時間切れ (サーバー時計)
await A.say({ t: 'queue' }); await B.say({ t: 'queue' });
const m3 = A.last('matched'); const first = m3.side === 0 ? A : B; const second = first === A ? B : A;
await advance(TIME + 100);
const tA = A.last('end'), tB = B.last('end');
check('timeout: mover loses', tA.reason === 'time' && tA.winner === 1 && tB.winner === 1, tA);

// 切断→再接続でレジューム + 切断中の決着
await A.say({ t: 'queue' }); await B.say({ t: 'queue' });
const m4 = A.last('matched');
await (m4.side === 0 ? A : B).say({ t: 'move', m: [6 * 9 + 2, 5 * 9 + 2, 0, ''] });
A.drop();
const A2 = client('alice'); await login(A2, 'アリス');
const re = A2.last('matched');
check('resume sends moves', re && re.mid === m4.mid && re.moves.length === 1, re);
A2.drop();
await advance(TIME + 100);            // 切断したまま時間切れ
const A3 = client('alice'); await login(A3, 'アリス');
check('pending end delivered', !!A3.last('end'), A3.inbox);

// 重複ログインで古い接続は切断
const A4 = client('alice'); await login(A4, 'アリス');
check('replaced old conn', !!A3.last('error') && A3.last('error').code === 'replaced');

// レート差が大きい相手とは待機中はマッチしない(最初は±150)
const C = client('carol'); await login(C, 'キャロル');
core.recs.get(rid('carol')).r = 1800;
const D = client('dave1'); await login(D, 'デイブ');
await C.say({ t: 'queue' }); await D.say({ t: 'queue' });
check('big rating gap not matched at once', !C.last('matched'));
clock += 30000; core.pair(); await tick();
check('gap widens with wait', !!C.last('matched'));

core.dispose();
console.log(fails ? `FAILED ${fails}` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
