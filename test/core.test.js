import { LobbyCore, TIME, LIMITS, GOTE_WIN_MULT, cleanName, eloUpdate } from '../src/core.js';
const S = globalThis.Shogi;
let fails = 0;
const check = (name, cond, extra) => { if (!cond) { fails++; console.log('NG', name, extra === undefined ? '' : JSON.stringify(extra)); } else console.log('ok', name); };
const tick = () => new Promise((r) => setTimeout(r, 15));

function world(opts = {}) {
  let clock = 1_000_000; const timers = [];
  const mem = new Map();
  const core = new LobbyCore({
    storage: { get: async (k) => mem.get(k), put: async (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); }, list: async ({ prefix }) => new Map([...mem].filter(([k]) => k.startsWith(prefix))) },
    now: () => clock, noTick: true, rand: opts.rand,
    setTimeout: (f, ms) => { const h = { f, at: clock + ms }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    rateSameIp: opts.rateSameIp
  });
  const w = {
    core, mem, get clock() { return clock; }, set clock(v) { clock = v; },
    advance: async (ms) => { clock += ms; for (const h of timers.slice()) if (h.at <= clock) { timers.splice(timers.indexOf(h), 1); h.f(); } await tick(); },
    client(id, ip) {
      const inbox = []; const ls = {}; let closed = false;
      const ws = { send: (s) => inbox.push(JSON.parse(s)), addEventListener: (t, f) => { ls[t] = f; }, close: () => { closed = true; ls.close && ls.close(); } };
      core.attach(ws, { ip: ip || ('10.0.0.' + (id.charCodeAt(0) % 200)) });
      const sec = ('S' + id).padEnd(24, 'k');
      const c = {
        id, pid: id.padEnd(12, 'x'), inbox, get closed() { return closed; },
        say: async (o) => { ls.message({ data: typeof o === 'string' ? o : JSON.stringify(o) }); await tick(); },
        last: (t) => [...inbox].reverse().find((m) => m.t === t),
        all: (t) => inbox.filter((m) => m.t === t),
        login: async (name) => c.say({ t: 'hello', id: c.pid, secret: sec, name }),
        drop: () => { ls.close(); }
      };
      return c;
    }
  };
  return w;
}
// 手順(先手): 9六歩 1六歩 8六歩 / (後手): 1四歩 9四歩 2四歩  -- どれも王手にならない
const SEQ = [[54, 45], [26, 35], [62, 53], [18, 27], [55, 46], [25, 34]];
async function startPair(w, A, B) {
  await A.say({ t: 'queue' }); await B.say({ t: 'queue' });
  const mA = A.last('matched'); const sente = mA.side === 0 ? A : B; const gote = sente === A ? B : A;
  return { mA, sente, gote, mid: mA.mid };
}
async function playSeq(p, n) {
  for (let i = 0; i < n; i++) { const [f, t] = SEQ[i]; await (i % 2 === 0 ? p.sente : p.gote).say({ t: 'move', m: [f, t, 0, ''] }); }
}

// ===== 基本の流れ =====
{
  const w = world();
  const A = w.client('alice'), B = w.client('bobby');
  await A.login('アリス'); await B.login('ボブ');
  check('welcome', A.last('welcome')?.rating.r === 1000);
  await A.say({ t: 'queue' }); check('queued', !!A.last('queued'));
  await B.say({ t: 'queue' });
  const mA = A.last('matched'), mB = B.last('matched');
  check('matched', mA && mB && mA.mid === mB.mid && mA.side !== mB.side);
  check('opp names', mA.oppName === 'ボブ' && mB.oppName === 'アリス');
  const sente = mA.side === 0 ? A : B, gote = sente === A ? B : A;
  await gote.say({ t: 'move', m: [18, 27, 0, ''] });
  check('wrong turn: no move accepted', (sente.last('state')?.moves.length ?? 0) === 0);
  await sente.say({ t: 'move', m: [0, 80, 0, ''] });
  check('illegal move ignored', (sente.last('state')?.moves.length ?? 0) === 0);
  await sente.say({ t: 'move', m: ['x', {}, 1, 'zz'] });
  await sente.say({ t: 'move', m: [1, 2] });
  check('garbage move ignored', (sente.last('state')?.moves.length ?? 0) === 0);

  // ランダムに決着まで
  let st = S.initialState(), n = 0;
  while (A.last('end') == null && n < 400) {
    const g = S.legalMoves(st); const mv = g[(Math.random() * g.length) | 0];
    w.clock += 1000; await (st.turn === 0 ? sente : gote).say({ t: 'move', m: [mv.from, mv.to, mv.promote ? 1 : 0, mv.drop || ''] });
    st = S.play(st, mv); n++;
  }
  const eA = A.last('end'), eB = B.last('end');
  check('ended by check', eA && eB && eA.reason === 'check' && eA.winner === st.winner);
  const win = eA.winner === mA.side ? eA : eB, lose = win === eA ? eB : eA;
  check('rated applied', win.rated && lose.rated && win.rd.to > win.rd.from && lose.rd.to < lose.rd.from);
  const mult = st.winner === 1 ? GOTE_WIN_MULT : 1;
  check('delta matches elo × mult', win.rd.to - win.rd.from === Math.round(20 * mult) && lose.rd.from - lose.rd.to === Math.round(20 * mult), [win.rd, lose.rd, mult]);
  w.core.dispose();
}

// ===== 後手が勝つとレート変動が1.5倍 / 先手が勝つと通常 =====
for (const goteWins of [true, false]) {
  const w = world();
  const A = w.client('alice'), B = w.client('bobby'); await A.login('a'); await B.login('b');
  const p = await startPair(w, A, B);
  await playSeq(p, 6);                       // 6手進める(早期終了の扱いにならない)
  await (goteWins ? p.sente : p.gote).say({ t: 'resign' });
  const win = (goteWins ? p.gote : p.sente).last('end'), lose = (goteWins ? p.sente : p.gote).last('end');
  const d = goteWins ? 30 : 20;
  check(`${goteWins ? 'gote' : 'sente'} win: ±${d}`, win.rd.to - win.rd.from === d && lose.rd.from - lose.rd.to === d && win.mult === (goteWins ? 1.5 : 1), [win, lose]);
  w.core.dispose();
}
{ // eloUpdate 単体
  const r = eloUpdate({ r: 1500, n: 20, w: 0, l: 0, d: 0 }, 1500, 1, 1.5);
  check('elo unit (K=24 → 12 → 18)', r.r === 1518, r);
  check('elo floor 100', eloUpdate({ r: 105, n: 20, w: 0, l: 0, d: 0 }, 105, 0, 1.5).r === 100);
}

// ===== 早期終了: 勝者はレートが上がらず、敗者は下がる =====
{
  const w = world();
  const A = w.client('alice'), B = w.client('bobby'); await A.login('a'); await B.login('b');
  const p = await startPair(w, A, B);
  await p.sente.say({ t: 'resign' });
  const win = p.gote.last('end'), lose = p.sente.last('end');
  check('quick resign: winner unchanged, loser drops', win.rd.to === win.rd.from && win.note === 'quick' && lose.rd.to < lose.rd.from, [win, lose]);
  w.core.dispose();
}

// ===== 同じ相手との連戦はレート対象外(4戦目) =====
{
  const w = world({ rand: () => 0.3 });
  const A = w.client('alice'), B = w.client('bobby'); await A.login('a'); await B.login('b');
  const notes = [];
  for (let i = 0; i < 4; i++) {
    const p = await startPair(w, A, B); await playSeq(p, 6); await (i % 2 ? p.gote : p.sente).say({ t: 'resign' });   // 交互に投了して差が開きすぎないようにする
    const e = p.gote.last('end'); notes.push([e.rated, e.note]); await w.advance(5000);   // 発言の上限を回復させる
  }
  check('pair limit: 3 rated then unrated', notes[0][0] && notes[1][0] && notes[2][0] && !notes[3][0] && notes[3][1] === 'pair', notes);
  w.core.dispose();
}

// ===== 同じIP同士はレート対象外(設定で変更可) =====
for (const allow of [false, true]) {
  const w = world({ rateSameIp: allow });
  const A = w.client('alice', '9.9.9.9'), B = w.client('bobby', '9.9.9.9'); await A.login('a'); await B.login('b');
  const p = await startPair(w, A, B); await playSeq(p, 6); await p.sente.say({ t: 'resign' });
  const e = p.gote.last('end');
  check(`same IP rated=${allow}`, e.rated === allow && (allow || e.note === 'sameip'), e);
  w.core.dispose();
}

// ===== 時間切れ・再接続 =====
{
  const w = world();
  const A = w.client('alice'), B = w.client('bobby'); await A.login('a'); await B.login('b');
  const p = await startPair(w, A, B);
  await w.advance(TIME + 100);
  const tA = A.last('end'), tB = B.last('end');
  check('timeout: mover loses', tA.reason === 'time' && tB.reason === 'time' && tA.winner === 1);
  // 切断→再接続でレジューム
  const p2 = await startPair(w, A, B);
  await p2.sente.say({ t: 'move', m: [54, 45, 0, ''] });
  p2.sente.drop();
  const S2 = w.client(p2.sente.id); await S2.login('x');
  const re = S2.last('matched');
  check('resume', re && re.mid === p2.mid && re.moves.length === 1, re);
  S2.drop(); await w.advance(TIME + 100);
  const S3 = w.client(p2.sente.id); await S3.login('x');
  check('pending end delivered after reconnect', !!S3.last('end'));
  const S4 = w.client(p2.sente.id); await S4.login('x');
  check('old connection replaced', S3.last('error')?.code === 'replaced');
  w.core.dispose();
}

// ===== 通信遅れの補正 =====
{
  const w = world();
  const A = w.client('alice'), B = w.client('bobby'); await A.login('a'); await B.login('b');
  const p = await startPair(w, A, B);
  const sp = p.sente.last('sping');
  check('server sends sping at start', !!sp);
  await w.advance(200); await p.sente.say({ t: 'spong', n: sp.n });
  await w.advance(1000 - 200);              // 手番になってから合計1000ms後に指す
  await p.sente.say({ t: 'move', m: [54, 45, 0, ''] });
  const used = TIME - p.sente.last('state').time[0] - 0;
  const t0 = p.gote.last('state').time[0];
  check('lag credit: 1000ms elapsed, 200ms credited', t0 === TIME - 800, t0);
  // 嘘の遅れ(5秒)を申告しても上限と持ち分で頭打ち
  const c = w.core; const g = [...c.games.values()][0];
  const sp2 = p.gote.last('sping'); void sp2;
  await w.advance(100); const spx = (p.gote.all('sping').at(-1) || { n: 1 });
  p.gote.say({ t: 'spong', n: spx.n }); await w.advance(4000);   // わざと4秒遅らせて返す
  await p.gote.say({ t: 'move', m: [26, 35, 0, ''] });
  const t1 = p.sente.last('state').time[1];
  check('lag credit capped (≤1500ms)', TIME - t1 <= 4100 - 1000 && TIME - t1 >= 4100 - 1500 - 100, TIME - t1);
  check('quota never negative', g.quota[0] >= 0 && g.quota[1] >= 0, g.quota);
  w.core.dispose();
}

// ===== 荒らし対策 =====
{
  const w = world();
  // メッセージ連投
  const F = w.client('flood', '7.7.7.7'); await F.login('f');
  for (let i = 0; i < 100; i++) await F.say({ t: 'ping' });
  check('flood is kicked', F.closed && F.inbox.some((m) => m.code === 'flood'));
  // 不正なメッセージ
  const G2 = w.client('garbo', '7.7.7.8'); await G2.login('g');
  await G2.say('not json'); await G2.say('{"t":5}'); await G2.say('x'.repeat(3000)); await G2.say('[]');
  check('garbage tolerated', !G2.closed);
  // 認証失敗の連続でロック
  const bad = w.client('victim', '6.6.6.6'); await bad.login('v');       // 正規のアカウントを作る
  let locked = false;
  for (let i = 0; i < 12; i++) {
    const x = w.client('victim', '6.6.6.7');
    await x.say({ t: 'hello', id: bad.pid, secret: 'Z'.repeat(24) + i, name: 'x' });
    if (x.last('error')?.code === 'locked') locked = true;
  }
  check('auth brute force locked', locked);
  // 別IPからの正しい認証は通る
  const good = w.client('victim', '6.6.6.8'); await good.login('v');
  check('legit login still works', !!good.last('welcome'));
  // 新規アカウント作成の制限
  let limit = null;
  for (let i = 0; i < LIMITS.NEW_ACCT_PER_IP_HR + 2; i++) {
    const x = w.client('spam' + String.fromCharCode(97 + i), '5.5.5.5'); await x.login('s');
    if (x.last('error')?.code === 'limit' && limit === null) limit = i;
    x.drop();
  }
  check('new accounts per IP limited', limit === LIMITS.NEW_ACCT_PER_IP_HR, limit);
  await w.advance(3600_000 + 10);
  const again = w.client('spamz', '5.5.5.5'); await again.login('s');
  check('limit resets after an hour', !!again.last('welcome'));
  // 同一IPの同時接続数
  const socks = []; for (let i = 0; i < LIMITS.MAX_CONN_PER_IP + 1; i++) socks.push(w.client('cx' + i, '4.4.4.4'));
  check('connections per IP limited', socks[LIMITS.MAX_CONN_PER_IP].closed === true && socks.slice(0, LIMITS.MAX_CONN_PER_IP).every((s) => !s.closed));
  // hello 前の操作は拒否
  const nh = w.client('nohello', '3.3.3.3'); await nh.say({ t: 'queue' });
  check('no action before hello', nh.last('error')?.code === 'hello');
  w.core.dispose();
}

// ===== ニックネーム =====
check('name: strips tags', cleanName('<b>x</b>') === 'bxb', cleanName('<b>x</b>'));
check('name: NG word → 名無し', cleanName('FUCK you') === '名無し' && cleanName('死ね') === '名無し');
check('name: no URL/markup chars survive', !/[<>\/@.:]/.test(cleanName('http://a.b/<x>@y')), cleanName('http://a.b/<x>@y'));
check('name: length 12', Array.from(cleanName('あ'.repeat(30))).length === 12);
check('name: control/bidi removed', cleanName('a‮b\u0000c') === 'abc');
check('name: empty → 名無し', cleanName('   ') === '名無し' && cleanName(null) === '名無し');
{
  const w = world();
  const A = w.client('alice'); await A.login('アリス');
  await A.say({ t: 'name', name: 'アリス2' });
  check('name change applied', w.core.recs.get(A.pid).name === 'アリス2');
  await A.say({ t: 'name', name: 'アリス3' });
  check('name change cooldown', w.core.recs.get(A.pid).name === 'アリス2');
  await w.advance(11000); await A.say({ t: 'name', name: 'アリス3' });
  check('name change after cooldown', w.core.recs.get(A.pid).name === 'アリス3');
  w.core.dispose();
}

// ===== ランキング =====
{
  const w = world();
  const names = ['a', 'b', 'c', 'd'];
  const cl = [];
  for (let i = 0; i < 4; i++) { const c = w.client('rank' + names[i]); await c.login('P' + names[i]); cl.push(c); const r = w.core.recs.get(c.pid); r.r = 1000 + i * 100; r.n = i === 3 ? 1 : 5; }
  await cl[0].say({ t: 'board' });
  const b = cl[0].last('board');
  check('board: only n>=3, sorted', b.top.length === 3 && b.top[0].name === 'Pc' && b.top[0].rank === 1, b);
  check('board: my rank', b.me && b.me.rank === 3 && b.me.r === 1000, b.me);
  check('board hides secrets', !JSON.stringify(b).includes('secret'));
  await cl[3].say({ t: 'board' });
  check('board: unqualified player has no rank', cl[3].last('board').me === null);
  // 再起動しても全員のレートを読み込める
  const w2 = world(); for (const [k, v] of w.mem) w2.mem.set(k, v);
  const re = new LobbyCore({ storage: { get: async (k) => w2.mem.get(k), put: async () => {}, list: async ({ prefix }) => new Map([...w2.mem].filter(([k]) => k.startsWith(prefix))) }, noTick: true });
  await re.ready; check('restart loads all records', re.recs.size === 4);
  re.dispose(); w2.core.dispose(); w.core.dispose();
}

// ===== レート差とマッチング =====
{
  const w = world();
  const C = w.client('carol'), D = w.client('dave1'); await C.login('c'); await D.login('d');
  w.core.recs.get(C.pid).r = 1800;
  await C.say({ t: 'queue' }); await D.say({ t: 'queue' });
  check('big gap not matched at once', !C.last('matched'));
  w.clock += 30000; w.core.pair(); await tick();
  check('gap widens with wait', !!C.last('matched'));
  w.core.dispose();
}

console.log(fails ? `FAILED ${fails}` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
