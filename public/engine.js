/* 王手将棋エンジン
 * 盤: 長さ81の配列。index = r*9 + c (r=0が後手側の最上段、c=0が画面左=9筋)
 * 駒: {t:'P'|'L'|'N'|'S'|'G'|'B'|'R'|'K', p:成りフラグ, o:0先手|1後手}
 * 王手将棋: 先に王手をかけた側の勝ち。それ以外は通常の将棋の指し手規則。
 */
(function (root) {
  'use strict';

  var PIECES = {};
  function mk(t, p, o) {
    var k = t + (p ? '+' : '') + o;
    return PIECES[k] || (PIECES[k] = Object.freeze({ t: t, p: p, o: o }));
  }

  var STEP = {
    P: [[-1, 0]],
    N: [[-2, -1], [-2, 1]],
    S: [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 1]],
    G: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]],
    K: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]
  };
  var ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  var DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

  function initialState() {
    var b = new Array(81).fill(null);
    var back = ['L', 'N', 'S', 'G', 'K', 'G', 'S', 'N', 'L'];
    for (var c = 0; c < 9; c++) {
      b[c] = mk(back[c], false, 1);
      b[6 * 9 + c] = mk('P', false, 0);
      b[2 * 9 + c] = mk('P', false, 1);
      b[8 * 9 + c] = mk(back[c], false, 0);
    }
    b[1 * 9 + 1] = mk('R', false, 1);
    b[1 * 9 + 7] = mk('B', false, 1);
    b[7 * 9 + 7] = mk('R', false, 0);
    b[7 * 9 + 1] = mk('B', false, 0);
    return {
      board: b,
      hands: [{ R: 0, B: 0, G: 0, S: 0, N: 0, L: 0, P: 0 }, { R: 0, B: 0, G: 0, S: 0, N: 0, L: 0, P: 0 }],
      turn: 0,
      winner: null,   // 0 | 1 | null
      reason: null,   // 'check' | 'nomove' | 'time' | 'resign'
      check: false,
      last: null
    };
  }

  // fn(target) が true を返したら打ち切って true を返す
  function eachTarget(board, i, pc, fn) {
    var r = (i / 9) | 0, c = i % 9, m = pc.o === 0 ? 1 : -1, t = pc.t, k, d, rr, cc, steps = null, rays = null;
    if (pc.p) {
      if (t === 'B') { rays = DIAG; steps = ORTH; }
      else if (t === 'R') { rays = ORTH; steps = DIAG; }
      else steps = STEP.G;
    } else if (t === 'B') rays = DIAG;
    else if (t === 'R') rays = ORTH;
    else if (t === 'L') rays = [[-1, 0]];
    else steps = STEP[t];

    if (steps) {
      for (k = 0; k < steps.length; k++) {
        d = steps[k]; rr = r + d[0] * m; cc = c + d[1] * m;
        if (rr < 0 || rr > 8 || cc < 0 || cc > 8) continue;
        if (fn(rr * 9 + cc)) return true;
      }
    }
    if (rays) {
      for (k = 0; k < rays.length; k++) {
        d = rays[k];
        rr = r + d[0] * m; cc = c + d[1] * m;
        while (rr >= 0 && rr <= 8 && cc >= 0 && cc <= 8) {
          var idx = rr * 9 + cc;
          if (fn(idx)) return true;
          if (board[idx]) break;
          rr += d[0] * m; cc += d[1] * m;
        }
      }
    }
    return false;
  }

  function kingSquare(board, o) {
    for (var i = 0; i < 81; i++) { var p = board[i]; if (p && p.t === 'K' && p.o === o) return i; }
    return -1;
  }

  // sq が by 側の駒に利かれているか
  function attacked(board, sq, by) {
    for (var i = 0; i < 81; i++) {
      var p = board[i];
      if (p && p.o === by) {
        if (eachTarget(board, i, p, function (t) { return t === sq; })) return true;
      }
    }
    return false;
  }

  function inZone(o, r) { return o === 0 ? r <= 2 : r >= 6; }
  function mustPromote(t, o, r) {
    if (t === 'P' || t === 'L') return o === 0 ? r === 0 : r === 8;
    if (t === 'N') return o === 0 ? r <= 1 : r >= 7;
    return false;
  }
  var CAN_PROMOTE = { P: 1, L: 1, N: 1, S: 1, B: 1, R: 1 };

  function pseudoMoves(state) {
    var b = state.board, o = state.turn, out = [], i;
    for (i = 0; i < 81; i++) {
      var p = b[i];
      if (!p || p.o !== o) continue;
      (function (from, pc) {
        eachTarget(b, from, pc, function (to) {
          var tp = b[to];
          if (tp && tp.o === o) return false;
          var fr = (from / 9) | 0, tr = (to / 9) | 0;
          if (!pc.p && CAN_PROMOTE[pc.t] && (inZone(o, fr) || inZone(o, tr))) {
            out.push({ from: from, to: to, promote: true });
            if (!mustPromote(pc.t, o, tr)) out.push({ from: from, to: to, promote: false });
          } else if (!pc.p && mustPromote(pc.t, o, tr)) {
            out.push({ from: from, to: to, promote: true });
          } else {
            out.push({ from: from, to: to, promote: false });
          }
          return false;
        });
      })(i, p);
    }
    var h = state.hands[o];
    var kinds = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];
    for (var k = 0; k < kinds.length; k++) {
      var t = kinds[k];
      if (!h[t]) continue;
      var pawnCols = null;
      if (t === 'P') {
        pawnCols = {};
        for (i = 0; i < 81; i++) { var q = b[i]; if (q && q.o === o && q.t === 'P' && !q.p) pawnCols[i % 9] = true; }
      }
      for (i = 0; i < 81; i++) {
        if (b[i]) continue;
        var r = (i / 9) | 0;
        if (mustPromote(t, o, r)) continue;
        if (pawnCols && pawnCols[i % 9]) continue;
        out.push({ from: -1, to: i, drop: t, promote: false });
      }
    }
    return out;
  }

  // 王手将棋では打ち歩詰めも王手(=勝ち)なので禁止しない
  function apply(state, mv) {
    var board = state.board.slice();
    var hands = [Object.assign({}, state.hands[0]), Object.assign({}, state.hands[1])];
    var o = state.turn, cap = null;
    if (mv.from < 0) {
      board[mv.to] = mk(mv.drop, false, o);
      hands[o][mv.drop]--;
    } else {
      var pc = board[mv.from];
      cap = board[mv.to];
      if (cap) hands[o][cap.t]++;
      board[mv.from] = null;
      board[mv.to] = mv.promote ? mk(pc.t, true, o) : pc;
    }
    var ks = kingSquare(board, 1 - o);
    var check = ks >= 0 && attacked(board, ks, o);
    return {
      board: board, hands: hands, turn: 1 - o,
      winner: check ? o : null, reason: check ? 'check' : null,
      check: check, last: { from: mv.from, to: mv.to, drop: mv.drop || null, promote: !!mv.promote, cap: cap }
    };
  }

  // 合法手(自玉が取られる手を除外)と、その結果局面
  function legalWithState(state) {
    var o = state.turn, res = [], pm = pseudoMoves(state);
    for (var i = 0; i < pm.length; i++) {
      var st = apply(state, pm[i]);
      var ks = kingSquare(st.board, o);
      if (ks >= 0 && attacked(st.board, ks, 1 - o)) continue;
      res.push({ mv: pm[i], st: st });
    }
    return res;
  }
  function legalMoves(state) { return legalWithState(state).map(function (x) { return x.mv; }); }

  // 指して、手番側に指し手が無ければ負け(実戦ではほぼ起きない)も判定
  function play(state, mv) {
    var st = apply(state, mv);
    if (st.winner == null && legalWithState(st).length === 0) { st.winner = state.turn; st.reason = 'nomove'; }
    return st;
  }

  function key(state) {
    var s = '';
    for (var i = 0; i < 81; i++) { var p = state.board[i]; s += p ? (p.p ? '+' : '') + (p.o ? p.t.toLowerCase() : p.t) : '.'; }
    var K = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];
    for (var o = 0; o < 2; o++) for (var k = 0; k < 7; k++) s += state.hands[o][K[k]];
    return s + state.turn;
  }

  // ---- 簡易CPU ----
  // 1) 王手をかけられるなら必ずかける
  // 2) 相手に王手をかけられる手を避ける
  // 3) 安全な手のうち、次に自分が王手をかけられる手の数が多いものを優先
  function cpuMove(state) {
    var list = legalWithState(state);
    if (!list.length) return null;
    var wins = list.filter(function (x) { return x.st.check; });
    if (wins.length) return pick(wins).mv;
    var best = [], bestScore = -1e9, fallback = [], fbScore = 1e9, i;
    for (i = 0; i < list.length; i++) {
      var st = list[i].st;
      var opp = legalWithState(st);
      var oppChecks = 0;
      for (var j = 0; j < opp.length; j++) if (opp[j].st.check) oppChecks++;
      if (oppChecks > 0) {
        if (oppChecks < fbScore) { fbScore = oppChecks; fallback = [list[i]]; }
        else if (oppChecks === fbScore) fallback.push(list[i]);
        continue;
      }
      var pass = Object.assign({}, st, { turn: state.turn, check: false, winner: null });
      var mine = 0, my = legalWithState(pass);
      for (var k = 0; k < my.length; k++) if (my[k].st.check) mine++;
      var cap = list[i].mv.from >= 0 && state.board[list[i].mv.to] ? 0.5 : 0;
      var score = mine + cap + Math.random() * 0.9;
      if (score > bestScore) { bestScore = score; best = [list[i]]; }
    }
    if (best.length) return best[0].mv;
    return pick(fallback.length ? fallback : list).mv;
  }
  function pick(a) { return a[(Math.random() * a.length) | 0]; }

  root.Shogi = {
    mk: mk, initialState: initialState, legalMoves: legalMoves, legalWithState: legalWithState,
    apply: apply, play: play, pseudoMoves: pseudoMoves, key: key, cpuMove: cpuMove, attacked: attacked, kingSquare: kingSquare,
    inZone: inZone
  };
  if (typeof module !== 'undefined') module.exports = root.Shogi;
})(typeof window !== 'undefined' ? window : globalThis);
