// ニックネームの整形と検査。NGワードは自由に追加してください(ひらがな・小文字で書く)。
export const NG_WORDS = [
  // 運営になりすます名前
  'うんえい', '運営', '管理人', 'かんりにん', 'admin', 'official', 'moderator', 'system',
  // 暴言・卑猥な語(一部)
  'しね', '死ね', 'ころす', '殺す', 'ころして', 'うんこ', 'ちんこ', 'ちんぽ', 'まんこ', 'せっくす', 'ばか', 'あほ', 'きもい', 'ぶす',
  'fuck', 'shit', 'bitch', 'nazi', 'rape', 'sex', 'porn', 'cock', 'pussy', 'nigger'
];

// 比較用に正規化: 全角半角を統一、小文字化、カタカナをひらがなへ、記号と空白を除く
export function normalizeForCheck(s) {
  let t = String(s).normalize('NFKC').toLowerCase();
  t = t.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  return t.replace(/[\s\p{P}\p{S}_ー・]/gu, '');
}
export function isNgName(s) {
  const t = normalizeForCheck(s);
  return NG_WORDS.some((w) => t.includes(normalizeForCheck(w)));
}

// 使える文字: 文字・数字・結合記号・一部の記号・空白。制御文字、ゼロ幅文字、右から左への切り替えなどは除く
export function cleanName(raw) {
  let s = String(raw == null ? '' : raw).normalize('NFKC');
  s = s.replace(/[^\p{L}\p{N}\p{M}ー_\- ・]/gu, '').replace(/\p{Cf}/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, 12).join('').trim();
  if (!s || isNgName(s)) return '名無し';
  return s;
}
