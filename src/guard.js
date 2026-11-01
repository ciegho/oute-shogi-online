// 入口での検査(Cloudflareに依存しない部分)

// ブラウザからの接続は、このサイト自身のページからのものだけ通す。
// Originがない接続(ブラウザ以外)は通す。ブラウザ以外からの接続は core.js 側の制限で防ぐ。
export function originOk(origin, host) {
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch (e) { return false; }
}
// 比較時間が一致の位置で変わらない文字列比較
export function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
