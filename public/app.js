(function () {
  'use strict';
  var S = window.Shogi;
  var KANJI = { P: ['歩', 'と'], L: ['香', '杏'], N: ['桂', '圭'], S: ['銀', '全'], G: ['金', '金'], B: ['角', '馬'], R: ['飛', '龍'], K: ['玉', '王'] };
  var RANK = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  var HAND_ORDER = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];
  var TIME = 180000;
  var G = null;
  var LEVELS = [{ n: '入門', r: 500 }, { n: 'ふつう', r: 1000 }, { n: '強い', r: 1300 }, { n: '強豪', r: 1500 }, { n: '達人', r: 1600 }];
  var level = 1;
  var GOTE_WIN_MULT = 1.5;

  // ---- 保存(端末内) ----
  function load(key, def) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
  function loadRating() { return load('ouote-rating-v1', { r: 1000, n: 0, w: 0, l: 0, d: 0 }); }
  function applyRating(score) {
    var R = loadRating(), opp = LEVELS[G.level].r, from = R.r;
    var e = 1 / (1 + Math.pow(10, (opp - R.r) / 400));
    var k = R.n < 10 ? 40 : 24;
    if (score === 1 && G.view === 1) k *= GOTE_WIN_MULT;   // 後手で勝ったときは変動を1.5倍にする
    R.r = Math.max(100, R.r + Math.round(k * (score - e)));
    R.n++; if (score === 1) R.w++; else if (score === 0) R.l++; else R.d++;
    save('ouote-rating-v1', R);
    G.rd = { from: from, to: R.r };
  }
  function refreshMenu() {
    var R = loadRating();
    $('rt-val').textContent = R.r;
    $('rt-meta').textContent = R.n ? R.w + '勝 ' + R.l + '敗 ' + R.d + '分' + (R.n < 10 ? '(仮)' : '') : '未対局';
    var N = NET.rating;
    $('rt-on').textContent = NET.ok && N ? N.r : '-';
    $('rt-on-meta').textContent = NET.ok && N ? (N.n ? N.w + '勝 ' + N.l + '敗 ' + N.d + '分' + (N.n < 10 ? '(仮)' : '') : '未対局') : '';
    $('lv').innerHTML = LEVELS.map(function (l, i) {
      return '<button data-lv="' + i + '" class="' + (i === level ? 'on' : '') + '">' + l.n + '<small>' + l.r + '</small></button>';
    }).join('');
  }

  // ---- CPU(Web Worker。使えなければ本体スレッドで実行) ----
  var worker = null, wseq = 0, wreq = {};
  function initWorker() {
    try {
      worker = new Worker('cpu-worker.js');
      worker.onmessage = function (e) { var r = wreq[e.data.id]; delete wreq[e.data.id]; if (r) r.cb(e.data.mv); };
      worker.onerror = function () {
        worker = null;
        var ids = Object.keys(wreq);
        ids.forEach(function (id) { var r = wreq[id]; delete wreq[id]; askCpu(r.state, r.level, r.cb); });
      };
    } catch (e) { worker = null; }
  }
  function askCpu(state, lv, cb) {
    if (worker) {
      var id = ++wseq;
      wreq[id] = { state: state, level: lv, cb: cb };
      worker.postMessage({ id: id, state: state, level: lv });
    } else {
      setTimeout(function () { cb(window.ShogiCPU.choose(state, lv)); }, 30);
    }
  }

  // ---- オンライン対戦(専用サーバーにWebSocketでつなぐ) ----
  var NET = { ws: null, ok: false, state: 'init', rating: null, online: null, everOpen: false, tries: 0, timer: null, ping: null };
  var Q = { on: false, since: 0, timer: null };

  function ident() {
    var v = load('ouote-ident', null);
    if (!v || !v.id || !v.secret) {
      var abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      var rnd = function (n) {
        var a = new Uint8Array(n), out = '', i;
        (window.crypto || window.msCrypto).getRandomValues(a);
        for (i = 0; i < n; i++) out += abc[a[i] % 62];
        return out;
      };
      v = { id: rnd(20), secret: rnd(32) };
      save('ouote-ident', v);
    }
    return v;
  }
  function setOnlineState(st) {
    NET.state = st; NET.ok = st === 'ok';
    var b = $('btn-online'), n = $('online-note');
    var t = {
      init: ['オンライン対戦(接続中…)', ''],
      ok: ['オンライン対戦(レート戦)', 'レートの近い相手と自動で対戦します。相手が見つかるまで待機します。'],
      offline: ['オンライン対戦(つながりません)', '対戦サーバーに接続できません。公開サーバー上でこのページを開いたときだけ使えます。'],
      replaced: ['オンライン対戦(別の画面で使用中)', '別の画面でオンライン対戦が開かれています。こちらで使うには、ページを再読み込みしてください。'],
      auth: ['オンライン対戦(本人確認に失敗)', '本人確認に失敗しました。ブラウザの保存データを消した場合は、以前のレーティングを引き継げません。'],
      limit: ['オンライン対戦(登録の上限)', 'この回線から今日作れるアカウントの上限に達しました。明日もう一度お試しください。'],
      busy: ['オンライン対戦(接続が多すぎます)', 'この回線からの接続が多すぎます。他の画面を閉じてから、ページを再読み込みしてください。']
    }[st];
    b.textContent = t[0]; b.disabled = st !== 'ok'; $('btn-rank').disabled = st !== 'ok'; $('online-note').textContent = t[1];
    void n;
  }
  function send(o) {
    if (NET.ws && NET.ws.readyState === 1) { NET.ws.send(JSON.stringify(o)); return true; }
    return false;
  }
  function netOpen() { return !!(NET.ws && NET.ws.readyState === 1); }
  function connect() {
    if (NET.ws) return;
    if (!window.WebSocket || location.protocol === 'file:' || !location.host) { setOnlineState('offline'); return; }
    var ws;
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); } catch (e) { retry(); return; }
    NET.ws = ws;
    ws.onopen = function () {
      NET.everOpen = true; NET.tries = 0;
      var id = ident();
      send({ t: 'hello', id: id.id, secret: id.secret, name: load('ouote-name', '') });
      clearInterval(NET.ping);
      NET.ping = setInterval(function () { send({ t: 'ping' }); }, 20000);
    };
    ws.onmessage = function (e) { var m; try { m = JSON.parse(e.data); } catch (x) { return; } onNet(m); };
    ws.onclose = function () {
      clearInterval(NET.ping);
      if (NET.ws === ws) NET.ws = null;
      if (NET.state === 'replaced' || NET.state === 'auth' || NET.state === 'limit' || NET.state === 'busy') return;
      if (NET.state === 'ok') setOnlineState('init');
      if (G && G.online && !G.over) { G.netErr = true; drawPanel(); }
      if (Q.on) searchInfo('接続が切れました。再接続しています…');
      retry();
    };
    ws.onerror = function () {};
  }
  function retry() {
    NET.tries++;
    if (!NET.everOpen && NET.tries >= 3) { setOnlineState('offline'); return; }
    clearTimeout(NET.timer);
    NET.timer = setTimeout(connect, Math.min(1000 * NET.tries, 8000));
  }
  function netInit() {
    setOnlineState('init');
    connect();
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !NET.ws && NET.state !== 'replaced' && NET.state !== 'auth' && (NET.everOpen || NET.state === 'init')) { NET.tries = 0; connect(); }
    });
    $('nick').addEventListener('change', function () {
      var v = $('nick').value.trim().slice(0, 12);
      save('ouote-name', v);
      send({ t: 'name', name: v });
    });
  }
  function onNet(m) {
    switch (m.t) {
      case 'welcome':
        NET.rating = m.rating; NET.online = m.online;
        $('nick').value = m.name; save('ouote-name', m.name);
        setOnlineState('ok'); refreshMenu();
        if (Q.on) send({ t: 'queue' });
        break;
      case 'queued': NET.online = m; updateSearchInfo(); break;
      case 'matched': enterMatch(m); break;
      case 'state': onState(m); break;
      case 'end': onEnd(m); break;
      case 'sping': send({ t: 'spong', n: m.n }); break;   // サーバーが通信の遅れを測る
      case 'rank': showRank(m); break;
      case 'error':
        if (m.code === 'replaced') { setOnlineState('replaced'); stopSearch(false); }
        else if (m.code === 'auth') setOnlineState('auth');
        else if (m.code === 'limit') setOnlineState('limit');
        else if (m.code === 'busy' || m.code === 'full') setOnlineState('busy');
        else if (m.code === 'locked') setOnlineState('auth');
        else if (m.code === 'flood') setOnlineState('init');
        break;
      default: break;
    }
  }

  function showRank(m) {
    var list = $('rank-list');
    list.textContent = '';
    $('rank-note').textContent = m.list.length
      ? m.min + '局以上の人が対象です。' + (m.me ? 'あなたは ' + m.me.rank + '位 / ' + m.total + '人' : 'あなたはまだ圏外です(' + m.min + '局以上で載ります)')
      : 'まだランキングに載っている人がいません(' + m.min + '局以上で載ります)。';
    m.list.forEach(function (x, i) {
      var li = document.createElement('li');
      if (m.me && m.me.rank === i + 1) li.className = 'me';
      [['pos', i + 1], ['nm', x.name], ['rt', x.r], ['gm', x.n + '局']].forEach(function (c) {
        var sp = document.createElement('span'); sp.className = c[0]; sp.textContent = c[1]; li.appendChild(sp);
      });
      list.appendChild(li);
    });
  }
  function searchInfo(msg) { $('search-info').textContent = msg; }
  function updateSearchInfo() {
    if (!Q.on) return;
    var o = NET.online || {}, sec = Math.floor((Date.now() - Q.since) / 1000);
    searchInfo('待機 ' + Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2) + ' ・ 他に待機中 ' + Math.max(0, (o.waiting || 0) - 1) + '人 ・ 接続中 ' + (o.players || 0) + '人');
  }
  function startSearch() {
    if (!NET.ok || Q.on) return;
    Q.on = true; Q.since = Date.now();
    $('menu').hidden = true; $('search').hidden = false;
    searchInfo('相手を探しています…');
    send({ t: 'queue' });
    clearInterval(Q.timer);
    Q.timer = setInterval(updateSearchInfo, 1000);
  }
  function stopSearch(notify) {
    if (Q.on && notify) send({ t: 'unqueue' });
    Q.on = false;
    clearInterval(Q.timer);
    $('search').hidden = true;
  }
  function enterMatch(m) {
    stopSearch(false);
    if (G && G.online && G.online.mid === m.mid) { onState(m); return; }
    startOnline(m);
  }
  function startOnline(m) {
    var st = S.initialState();
    G = {
      mode: 'online', view: m.side, st: st, legal: S.legalMoves(st), time: [TIME, TIME], last: performance.now(),
      reps: {}, sel: null, pending: null, over: false, winner: null, reason: null, n: 0, arm: false, thinking: false,
      level: level, rd: null, moves: [], netErr: false,
      online: { mid: m.mid, oppName: m.oppName, oppR: m.oppR, myR: m.myR, rated: m.rated !== false, why: m.why || null, bonus: false }
    };
    G.reps[S.key(st)] = 1;
    $('menu').hidden = true; $('promo').hidden = true; $('search').hidden = true;
    render();
    onState(m);
  }
  function encodeMove(m) { return [m.from, m.to, m.promote ? 1 : 0, m.drop || ''].join(','); }
  function decodeMove(t) {
    var a = String(t).split(',');
    var m = { from: +a[0], to: +a[1], promote: a[2] === '1' };
    if (a[3]) m.drop = a[3];
    return m;
  }
  // サーバーの局面(手順と残り時間)をこちらに反映する
  function replay(g, list) {
    g.st = S.initialState(); g.moves = []; g.n = 0; g.reps = {}; g.reps[S.key(g.st)] = 1; g.sel = null;
    list.forEach(function (t) {
      g.st = S.play(g.st, decodeMove(t));
      g.moves.push(t); g.n++;
      var k = S.key(g.st); g.reps[k] = (g.reps[k] || 0) + 1;
    });
    g.legal = g.st.winner == null ? S.legalMoves(g.st) : [];
  }
  function onState(m) {
    var g = G;
    if (!g || !g.online || g.online.mid !== m.mid) return;
    var inc = m.moves || [], i, same = true;
    for (i = 0; i < g.moves.length && i < inc.length; i++) if (g.moves[i] !== inc[i]) { same = false; break; }
    if (!same) replay(g, inc);
    else if (inc.length > g.moves.length) {
      for (i = g.moves.length; i < inc.length && !g.over; i++) commit(decodeMove(inc[i]), true);
    }
    if (inc.length >= g.moves.length) { g.time = [m.time[0], m.time[1]]; g.last = performance.now(); }
    g.netErr = false;
    render();
  }
  function onEnd(m) {
    var g = G;
    if (!g || !g.online || g.online.mid !== m.mid) return;
    g.rd = m.rd; NET.rating = m.rating; g.online.rated = m.rated !== false; g.online.why = m.why || null; g.online.bonus = !!m.bonus;
    if (!g.over) finish(m.winner, m.reason, true);
    else { g.winner = m.winner; g.reason = m.reason; render(); }
  }

  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function kanji(pc) {
    if (pc.t === 'K') return KANJI.K[pc.o];
    return KANJI[pc.t][pc.p ? 1 : 0];
  }
  function pieceHtml(pc, rot) {
    return '<span class="pc' + (rot ? ' rot' : '') + (pc.p ? ' pro' : '') + '"><span class="pb">' + kanji(pc) + '</span></span>';
  }

  // ---- 盤の骨組み ----
  var cells = [];
  function buildBoard() {
    var b = $('board'), i;
    b.innerHTML = '';
    for (i = 0; i < 81; i++) {
      var c = document.createElement('button');
      c.className = 'cell';
      c.dataset.d = i;
      b.appendChild(c);
      cells.push(c);
    }
    [[3, 3], [3, 6], [6, 3], [6, 6]].forEach(function (p) {
      var s = document.createElement('span');
      s.className = 'star';
      s.style.left = (p[1] / 9 * 100) + '%';
      s.style.top = (p[0] / 9 * 100) + '%';
      b.appendChild(s);
    });
    b.addEventListener('click', function (e) {
      var t = e.target.closest('.cell');
      if (t) onCell(+t.dataset.d);
    });
  }
  function toIdx(d, view) { return view === 0 ? d : 80 - d; }

  // ---- 対局開始 ----
  function startGame(mode) {
    var view = mode === 'cpu1' ? 1 : 0;
    if (mode !== '2p') save('ouote-level', level);
    var st = S.initialState();
    G = {
      mode: mode === '2p' ? '2p' : 'cpu', view: view, st: st, legal: S.legalMoves(st),
      time: [TIME, TIME], last: performance.now(), reps: {}, sel: null, pending: null,
      over: false, winner: null, reason: null, n: 0, arm: false, thinking: false, level: level, rd: null, moves: []
    };
    G.reps[S.key(st)] = 1;
    $('menu').hidden = true;
    $('promo').hidden = true;
    render();
    maybeCpu();
  }
  function humanTurn() { return G.mode === '2p' || G.st.turn === G.view; }

  // ---- 入力 ----
  function onCell(d) {
    if (!G || G.over || !humanTurn() || G.thinking || (G.mode === 'online' && !netOpen())) return;
    var idx = toIdx(d, G.view), st = G.st, p = st.board[idx];
    if (G.sel) {
      var opts = G.legal.filter(function (m) { return m.to === idx && sameSrc(m, G.sel); });
      if (opts.length === 1) return commit(opts[0]);
      if (opts.length === 2) return askPromote(opts, st.board[G.sel.from]);
    }
    if (p && p.o === st.turn) {
      G.sel = (G.sel && G.sel.from === idx) ? null : { from: idx };
    } else G.sel = null;
    render();
  }
  function sameSrc(m, sel) { return sel.drop ? m.drop === sel.drop : m.from === sel.from; }
  function onHand(t) {
    if (!G || G.over || !humanTurn() || G.thinking || (G.mode === 'online' && !netOpen())) return;
    G.sel = (G.sel && G.sel.drop === t) ? null : { drop: t };
    render();
  }

  function askPromote(opts, pc) {
    G.pending = opts;
    var o = $('promo');
    o.innerHTML = '<div class="sheet promo"><h2>成りますか?</h2><div class="row">' +
      '<button class="btn" data-p="1">' + pieceHtml(S.mk(pc.t, true, pc.o), false) + '成る</button>' +
      '<button class="btn" data-p="0">' + pieceHtml(pc, false) + '成らない</button></div>' +
      '<button class="btn" data-p="x" style="flex:none;height:40px">やめる</button></div>';
    o.hidden = false;
  }
  $('promo').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!G || !G.pending) return;
    if (!b && e.target !== $('promo')) return;
    var v = b ? b.dataset.p : 'x', opts = G.pending;
    G.pending = null;
    $('promo').hidden = true;
    if (v === 'x') { render(); return; }
    commit(opts.filter(function (m) { return m.promote === (v === '1'); })[0]);
  });

  function commit(mv, remote) {
    G.moves.push(encodeMove(mv));
    G.st = S.play(G.st, mv);
    G.sel = null; G.arm = false; G.n++;
    G.legal = G.st.winner == null ? S.legalMoves(G.st) : [];
    G.last = performance.now();
    if (G.mode === 'online' && !remote) send({ t: 'move', m: [mv.from, mv.to, mv.promote ? 1 : 0, mv.drop || ''] });
    if (G.st.winner != null) { finish(G.st.winner, G.st.reason, remote); return; }
    var k = S.key(G.st);
    G.reps[k] = (G.reps[k] || 0) + 1;
    if (G.reps[k] >= 4) { finish(null, 'repetition', remote); return; }
    render();
    maybeCpu();
  }

  function maybeCpu() {
    if (G.over || G.mode !== 'cpu' || G.st.turn === G.view) return;
    var g = G, t0 = performance.now();
    g.thinking = true;
    render();
    askCpu(g.st, g.level + 1, function (mv) {
      var wait = Math.max(0, 450 + Math.random() * 450 - (performance.now() - t0));
      setTimeout(function () {
        if (G !== g || g.over) return;
        g.thinking = false;
        if (!mv) { finish(1 - g.st.turn, 'nomove'); return; }
        commit(mv);
      }, wait);
    });
  }

  function finish(winner, reason, remote) {
    G.over = true; G.winner = winner; G.reason = reason; G.sel = null; G.thinking = false;
    if (G.mode === 'cpu') applyRating(winner == null ? 0.5 : (winner === G.view ? 1 : 0));
    render();
  }

  // ---- 時計 ----
  function fmt(ms) {
    if (ms < 0) ms = 0;
    var s = ms / 1000;
    if (s < 10) return '0:0' + s.toFixed(1);
    var m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function tick() {
    if (!G || G.over) return;
    var now = performance.now(), dt = now - G.last;
    G.last = now;
    G.time[G.st.turn] -= dt;
    if (G.mode === 'online') { drawClocks(); return; }   // 時間切れの判定はサーバーが行う
    if (G.time[G.st.turn] <= 0) {
      G.time[G.st.turn] = 0;
      finish(1 - G.st.turn, 'time');
      return;
    }
    drawClocks();
  }
  setInterval(tick, 100);

  function sideName(s) { return s === 0 ? '先手' : '後手'; }
  function whoLabel(s) {
    if (G.mode === '2p') return '';
    if (G.mode === 'online') return s === G.view ? 'あなた ' + G.online.myR : G.online.oppName + ' ' + G.online.oppR;
    return s === G.view ? 'あなた' : 'CPU ' + LEVELS[G.level].n;
  }
  function drawClocks() {
    [['top', 1 - G.view], ['bot', G.view]].forEach(function (x) {
      var el = $('clk-' + x[0]);
      if (!el) return;
      var s = x[1];
      el.textContent = fmt(G.time[s]);
      el.className = 'clock' + (!G.over && G.st.turn === s ? ' on' : '') + (G.time[s] < 30000 ? ' low' : '');
    });
  }

  // ---- 描画 ----
  function strip(pos, s) {
    var mark = s === 0 ? '▲' : '△';
    $('strip-' + pos).innerHTML =
      '<div class="who"><span class="side">' + mark + sideName(s) + '</span><span class="name">' + esc(whoLabel(s)) + '</span></div>' +
      '<div class="clock" id="clk-' + pos + '"></div>';
  }
  function handHtml(s, active) {
    var h = G.st.hands[s], out = '', any = false;
    HAND_ORDER.forEach(function (t) {
      var n = h[t];
      if (!n) return;
      any = true;
      var sel = active && G.sel && G.sel.drop === t;
      out += '<button class="hd' + (sel ? ' sel' : '') + '" data-t="' + t + '"' + (active ? '' : ' disabled') +
        ' aria-label="持ち駒 ' + KANJI[t][0] + ' ' + n + '枚">' + pieceHtml(S.mk(t, false, s), s !== G.view) +
        (n > 1 ? '<i>' + n + '</i>' : '') + '</button>';
    });
    return { html: out, any: any };
  }
  function render() {
    var v = G.view, st = G.st, i;
    strip('top', 1 - v); strip('bot', v);

    var fl = '', rk = '';
    for (i = 0; i < 9; i++) {
      fl += '<span>' + (v === 0 ? 9 - i : i + 1) + '</span>';
      rk += '<span>' + RANK[v === 0 ? i : 8 - i] + '</span>';
    }
    $('files').innerHTML = fl; $('ranks').innerHTML = rk;

    var targets = {}, caps = {};
    if (G.sel && !G.over) {
      G.legal.forEach(function (m) {
        if (sameSrc(m, G.sel)) { targets[m.to] = true; if (st.board[m.to]) caps[m.to] = true; }
      });
    }
    var koSq = -1;
    if (G.over && G.reason === 'check') koSq = S.kingSquare(st.board, 1 - G.winner);
    var last = st.last;

    for (i = 0; i < 81; i++) {
      var idx = toIdx(i, v), p = st.board[idx], c = cells[i], cls = 'cell';
      if (last && (idx === last.to || idx === last.from)) cls += ' last';
      if (G.sel && G.sel.from === idx) cls += ' sel';
      if (targets[idx]) cls += caps[idx] ? ' tgt cap' : ' tgt';
      if (idx === koSq) cls += ' ko';
      c.className = cls;
      c.innerHTML = p ? pieceHtml(p, p.o !== v) : '';
      c.setAttribute('aria-label', (9 - idx % 9) + RANK[(idx / 9) | 0] + (p ? ' ' + kanji(p) : ''));
    }

    var canTop = !G.over && !G.thinking && humanTurn() && st.turn === 1 - v;
    var canBot = !G.over && !G.thinking && humanTurn() && st.turn === v;
    var ht = handHtml(1 - v, canTop), hb = handHtml(v, canBot);
    $('hand-top').innerHTML = ht.html; $('hand-top').className = 'hand' + (ht.any ? '' : ' empty');
    $('hand-bot').innerHTML = hb.html; $('hand-bot').className = 'hand' + (hb.any ? '' : ' empty');

    drawClocks();
    drawPanel();
  }

  function reasonText(r) {
    return { check: '王手で決着', time: '時間切れ', resign: '投了', nomove: '指せる手がありません', repetition: '同一局面4回' }[r] || '';
  }
  function rateLine() {
    if (G.mode === 'online' && G.online && G.online.rated === false) {
      return '<div class="sub">' + ({ same_ip: '同じ回線同士の対戦のため', quick: '短手数での勝利のため' }[G.online.why] || '同じ相手との連戦のため') + 'レーティングは変動しません</div>';
    }
    if (!G.rd) return '';
    var d = G.rd.to - G.rd.from;
    var bonus = (G.mode === 'online' ? (G.online && G.online.bonus) : (G.view === 1 && G.winner === 1));
    return '<div class="sub">' + (G.mode === 'online' ? 'オンラインレーティング ' : 'レーティング ') + G.rd.from + ' → <span class="delta">' + G.rd.to + '(' + (d >= 0 ? '+' : '') + d + ')</span>' + (bonus ? ' 後手勝利ボーナス×1.5' : '') + '</div>';
  }
  function drawPanel() {
    var p = $('panel'), st = G.st;
    if (G.over) {
      var big, cls = '';
      if (G.winner == null) big = '引き分け';
      else if (G.mode === '2p') { big = sideName(G.winner) + '勝ち'; cls = ' win'; }
      else if (G.winner === G.view) { big = 'あなたの勝ち'; cls = ' win'; }
      else big = 'あなたの負け';
      p.innerHTML = '<div class="result"><div class="big' + cls + '">' + big + '</div><div class="sub">' + G.n + '手 ・ ' + reasonText(G.reason) + '</div>' + rateLine() + '</div>' +
        '<div class="row"><button class="btn pri" id="b-again">もう一局</button><button class="btn" id="b-menu">メニュー</button></div>';
      $('b-again').onclick = function () { if (G.mode === 'online') { startSearch(); } else startGame(G.mode === '2p' ? '2p' : 'cpu' + G.view); };
      $('b-menu').onclick = function () { refreshMenu(); $('menu').hidden = false; };
      return;
    }
    var msg;
    if (G.mode === 'cpu') msg = G.thinking ? 'CPUが考えています…' : '<b>あなたの番です</b>';
    else if (G.mode === 'online') msg = (st.turn === G.view ? '<b>あなたの番です</b>' : '相手の番です') + (G.netErr ? '(再接続しています…)' : '') + (G.online.rated === false ? ' ・ レート変動なし' : '');
    else msg = '<b>' + sideName(st.turn) + '番</b>';
    p.innerHTML = '<div class="status">' + (G.n + 1) + '手目 ・ ' + msg + '</div>' +
      '<div class="row"><button class="btn' + (G.arm ? ' warn' : '') + '" id="b-resign">' + (G.arm ? 'もう一度押すと投了' : '投了') + '</button></div>';
    $('b-resign').onclick = function () {
      if (!G.arm) { G.arm = true; drawPanel(); setTimeout(function () { if (G && G.arm) { G.arm = false; if (!G.over) drawPanel(); } }, 3000); return; }
      if (G.mode === 'online') { G.arm = false; send({ t: 'resign' }); drawPanel(); return; }
      var loser = G.mode === '2p' ? G.st.turn : G.view;
      finish(1 - loser, 'resign');
    };
  }

  // ---- 初期化 ----
  buildBoard();
  level = Math.min(4, Math.max(0, load('ouote-level', 1) | 0));
  initWorker();
  refreshMenu();
  $('lv').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b) { level = +b.dataset.lv; refreshMenu(); }
  });
  document.querySelector('.menu .btns').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || b.disabled || !b.dataset.mode) return;
    if (b.dataset.mode === 'online') startSearch(); else startGame(b.dataset.mode);
  });
  $('btn-rank').addEventListener('click', function () {
    $('rank-note').textContent = '読み込み中…'; $('rank-list').textContent = '';
    $('rank').hidden = false; send({ t: 'rank' });
  });
  $('rank-close').onclick = function () { $('rank').hidden = true; };
  $('rank').addEventListener('click', function (e) { if (e.target === $('rank')) $('rank').hidden = true; });
  $('search-cancel').onclick = function () { stopSearch(true); refreshMenu(); $('menu').hidden = false; };
  netInit();
  ['hand-top', 'hand-bot'].forEach(function (id) {
    $(id).addEventListener('click', function (e) {
      var b = e.target.closest('.hd');
      if (b && !b.disabled) onHand(b.dataset.t);
    });
  });
  $('btn-rules').onclick = function () { $('rules').hidden = false; };
  $('rules-close').onclick = function () { $('rules').hidden = true; };
  $('rules').addEventListener('click', function (e) { if (e.target === $('rules')) $('rules').hidden = true; });

  // メニュー背景用に初期盤面を表示しておく
  G = { mode: 'cpu', view: 0, st: S.initialState(), legal: [], time: [TIME, TIME], last: 0, reps: {}, sel: null, over: true, winner: null, n: 0, thinking: false, level: level, rd: null, moves: [] };
  render();
  $('panel').innerHTML = '';
  window.__ouote = { get G() { return G; }, startGame: startGame, startSearch: startSearch, NET: NET, setLevel: function (l) { level = l; } };
})();
