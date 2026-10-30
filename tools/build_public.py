"""client/index.html (claude.aiアーティファクト形式) を、単体で配信できる public/index.html に変換する。"""
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
src = (root / 'client' / 'index.html').read_text(encoding='utf-8')
src = src.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
head = '''<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#11161B">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="王手将棋">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" href="icon-192.png">
'''
assert '<title>' in src
src = src.replace('<title>', head + '<title>', 1)
src = src.replace('</style>\n', '</style>\n</head>\n<body>\n', 1)
extra = '''html { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; overscroll-behavior: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
input { -webkit-user-select: text; user-select: text; }
'''
src = src.replace('[hidden] { display: none !important; }', extra + '[hidden] { display: none !important; }', 1)
src = src.rstrip() + '\n</body>\n</html>\n'
(root / 'public' / 'index.html').write_text(src, encoding='utf-8')
print('built public/index.html', len(src))
