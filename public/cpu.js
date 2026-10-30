/* 王手将棋CPU (engine.js の後に読み込む)
 * 王手をかけた方が勝ちなので「何手先で確実に王手をかけられるか」を探索する。
 *  Lv1 入門  : 王手があればかける。それ以外はランダム
 *  Lv2 ふつう: 相手に王手される手を避け、次に自分が王手できる手が多い手を選ぶ
 *  Lv3 強い  : Lv2に加え、どう受けられても王手が残る手(3手詰め相当)を探す
 *  Lv4 強豪  : Lv3に加え、相手の3手詰め相当の狙いを受ける
 *  Lv5 達人  : Lv4に加え、5手先までの王手の強制を探す
 */
(function (root) {
  'use strict';
  var S = root.Shogi;

  function now() { return (root.performance || Date).now(); }

  // 手番側に、自玉を危険にしない王手の手があるか
  function hasCheck(state) {
    var o = state.turn, pm = S.pseudoMoves(state);
    for (var i = 0; i < pm.length; i++) {
      var n = S.apply(state, pm[i]);
      if (!n.check) continue;
      var ks = S.kingSquare(n.board, o);
      if (!S.attacked(n.board, ks, 1 - o)) return true;
    }
    return false;
  }
  function pass(st) { return Object.assign({}, st, { turn: 1 - st.turn, check: false, winner: null }); }
  function countChecks(state) {
    var l = S.legalWithState(state), n = 0;
    for (var i = 0; i < l.length; i++) if (l[i].st.check) n++;
    return n;
  }
  // 自分が m を指した局面 st(相手番)で、相手がどう指しても自分に王手が残る(=強制勝ち)か
  function forcedWin(st, deadline) {
    var replies = S.legalWithState(st);
    if (!replies.length) return false;
    for (var i = 0; i < replies.length; i++) {
      if (replies[i].st.check) return false;
      if (!hasCheck(replies[i].st)) return false;
      if (deadline && now() > deadline) return false;
    }
    return true;
  }
  // 相手が (自分の手の後の局面 st で) 強制勝ちを持つか: 相手の静かな手 r の後、自分のどの手にも相手の王手が残る
  function oppHasForcedWin(st, deadline) {
    var replies = S.legalWithState(st);
    for (var i = 0; i < replies.length; i++) {
      var r = replies[i];
      if (r.st.check) return true;
      if (hasCheck(r.st)) continue;            // 自分に王手があるなら相手の狙いは成立しない
      var mine = S.legalWithState(r.st), ok = mine.length > 0;
      for (var j = 0; j < mine.length && ok; j++) {
        if (mine[j].st.check) { ok = false; break; }
        if (!hasCheck(mine[j].st)) ok = false;
      }
      if (ok) return true;
      if (deadline && now() > deadline) return false;
    }
    return false;
  }


  // ---- 深い探索 (Lv5用) ----
  // attacker(att)番の局面 st で、depth手以内(奇数)に王手を強制できるか
  var timeUp = false;
  function attWins(st, depth, deadline) {
    if (hasCheck(st)) return true;
    if (depth < 3) return false;
    var list = S.legalWithState(st);
    for (var i = 0; i < list.length; i++) {
      if (now() > deadline) { timeUp = true; return false; }
      if (defLoses(list[i].st, depth - 1, deadline)) return true;
    }
    return false;
  }
  // defender番の局面 st で、どう指しても attacker が王手を強制できるか
  function defLoses(st, depth, deadline) {
    var replies = S.legalWithState(st);
    if (!replies.length) return true;
    for (var i = 0; i < replies.length; i++) {
      if (replies[i].st.check) return false;
    }
    for (i = 0; i < replies.length; i++) {
      if (!attWins(replies[i].st, depth - 1, deadline)) return false;
      if (timeUp) return false;
    }
    return true;
  }

  var EVAL_W = +(typeof process !== 'undefined' && process.env && process.env.EVAL_W != null ? process.env.EVAL_W : 3);
  function pick(a) { return a[(Math.random() * a.length) | 0]; }

  function choose(state, level, budgetMs) {
    var list = S.legalWithState(state), i;
    if (!list.length) return null;
    var wins = list.filter(function (x) { return x.st.check; });
    if (wins.length) return pick(wins).mv;
    if (level <= 1) return pick(list).mv;
    if (level === 2) return S.cpuMove(state);

    var t0 = now();
    var attackBudget = budgetMs != null ? budgetMs : (level === 3 ? 1500 : 1500);
    var deadline = t0 + attackBudget;

    // 相手に王手される手を除外し、脅威数(次の王手の数)で並べる
    var safe = [], risky = [];
    for (i = 0; i < list.length; i++) {
      var x = list[i];
      var opp = S.legalWithState(x.st), oc = 0;
      for (var j = 0; j < opp.length; j++) if (opp[j].st.check) oc++;
      if (oc > 0) { x.oc = oc; risky.push(x); continue; }
      x.opp = opp;
      // 相手の返し手のうち、こちらに王手を許してしまう手の数(多いほど相手は窮屈)
      var bad = 0;
      if (EVAL_W > 0) for (var q = 0; q < opp.length; q++) if (hasCheck(opp[q].st)) bad++;
      x.threat = countChecks(pass(x.st)) + EVAL_W * bad + (x.mv.from >= 0 && state.board[x.mv.to] ? 0.5 : 0) + Math.random() * 0.8;
      safe.push(x);
    }
    if (!safe.length) {
      risky.sort(function (a, b) { return a.oc - b.oc; });
      return risky[0].mv;
    }
    safe.sort(function (a, b) { return b.threat - a.threat; });

    // 強制勝ち(3手)探索
    for (i = 0; i < safe.length; i++) {
      if (now() > deadline) break;
      if (forcedWin(safe[i].st, deadline)) return safe[i].mv;
    }
    if (level === 3) return safe[0].mv;
    if (level >= 5) {
      // 5手先まで王手を強制できる手を探す(時間内)
      var d5 = now() + (budgetMs != null ? budgetMs : 3000);
      timeUp = false;
      for (i = 0; i < safe.length; i++) {
        if (now() > d5) break;
        if (defLoses(safe[i].st, 4, d5)) return safe[i].mv;
        timeUp = false;
      }
    }

    // 最強: 相手の強制勝ちを許さない手を選ぶ
    var defDeadline = now() + Math.max(1500, attackBudget * 0.6);
    for (i = 0; i < safe.length; i++) {
      if (now() > defDeadline) break;
      if (!oppHasForcedWin(safe[i].st, defDeadline)) return safe[i].mv;
    }
    return safe[0].mv;
  }

  root.ShogiCPU = { choose: choose, hasCheck: hasCheck };
  if (typeof module !== 'undefined') module.exports = root.ShogiCPU;
})(typeof window !== 'undefined' ? window : globalThis);
