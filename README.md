# 王手将棋オンライン(対戦サーバー付き)

先に王手をかけた方が勝ちの将棋を、3分切れ負けで遊べるアプリです。
画面(`public/`)と対戦サーバー(`src/`)を、Cloudflare(無料枠)にまとめて置きます。

## 公開手順(Windows・Macなし)

### 1. GitHubにアップロード
1. このzipを展開します。
2. GitHubで「New repository」を押し、名前を `ouote-shogi-online` にして作成します(Privateで構いません)。
3. 作成後の画面で「uploading an existing file」を選び、展開したフォルダの**中身すべて**(`public`、`src`、`test`、`tools`、`client`、`package.json`、`wrangler.jsonc` など)をドラッグして、「Commit changes」を押します。

### 2. Cloudflareに登録してデプロイ
1. https://dash.cloudflare.com/sign-up で無料アカウントを作ります(クレジットカードは不要です)。
2. 左のメニューの「Workers & Pages」を開き、「Create」→「Import a repository」(Gitに接続)を選びます。
3. GitHubと連携して、`ouote-shogi-online` を選びます。
4. プロジェクト名は `ouote-shogi-online` のままにします。ビルドコマンドは空欄、デプロイコマンドは `npx wrangler deploy` のままで、「Save and Deploy」を押します。
5. 成功すると `https://ouote-shogi-online.<あなたの名前>.workers.dev` のURLが表示されます。

### 3. iPhoneで使う
1. そのURLをSafariで開きます。
2. 共有ボタン →「ホーム画面に追加」で、アプリのように起動できます。
3. 友人にも同じURLを送れば、オンライン対戦ができます。

## 更新するとき
GitHubでファイルを編集して「Commit」すると、Cloudflareが自動で再デプロイします。

## 仕組み
- `public/`: 画面とCPU(静的ファイル)。`client/index.html` から `python tools/build_public.py` で作ります。
- `src/core.js`: 対戦サーバーの中身。マッチング、手の検証、時計、レーティング。
- `src/index.js`: Cloudflare用の入口。全員が1つのDurable Objectにつながります。
- 時計と勝敗の判定はサーバーが行います。切断しても対局は続き、再接続すると再開します。
- 本人確認は、ブラウザに保存した秘密の文字列で行います。ブラウザの保存データを消すとレーティングは引き継げません。

## 手元で試す(任意。Node.jsが必要)
```
npm install
npm test                  # サーバー処理のテスト
npm run dev:local         # http://localhost:8787 で画面と対戦を試せる
```

## 注意
- サーバーを更新(再デプロイ)すると、そのとき対局中の試合は終了します。
- 無料枠を超えると、その日は一時的に使えなくなる場合があります。
