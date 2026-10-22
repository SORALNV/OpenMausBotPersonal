# OpenMausBot Personal

この Mac 用の Electron アプリ。配布版の UI、Codex、接続設定、スマホ用の Remote access 画面を維持し、登録語句の置換・復元と、設定で選んだ定期実行の語句置換を追加した。OpenAI privacy-filterによる自動検出は削除した。

## 起動と認証

`/Applications/OpenMausBot Personal.app` を開く。既存の `/Users/sora/.codex` の ChatGPT ログインを Codex CLI 経由で利用し、API キーは不要。通常の Codex 会話は取り込まない。

Codex の会話・作業状態は `~/.openmausbot-personal/private/codex/` に保存する。`CODEX_HOME` と `CODEX_SQLITE_HOME` を両方この場所に固定し、ChatGPT/Codex の普段の一覧へ UUID の作業フォルダを追加しない。ログインだけは元の `auth.json` へのシンボリックリンクで参照し、認証情報は複製しない。この Mac のファイル保存型ログインに対応し、キーチェーン保存型の Codex 認証を共有する仕組みではない。通常の認証更新は元の保存先に反映される。リンクが別の認証ファイルへ変わっていた場合は上書きせず停止する。

専用の Codex 設定を使い、普段の Codex の MCP・フック・設定ファイルは自動で複製しない。OpenMausBot で登録した接続・ツールと既存の承認制御を使う。専用領域の Codex デーモン自動起動と Codex 自身の記憶機能は無効。OpenMausBot の記憶・定期実行と個人情報のマスク設定は別の機能であり、この分離では変更しない。

`node --test electron/personal-codex-home.node-test.mjs` で保存先と認証参照の保護を検証する。`node scripts/personal-codex-isolation-acceptance.mjs` は使い捨て HOME、架空の認証、実 Codex CLI、ループバックの模擬AIだけを使い、認証ファイルの書き込み、プロセス再起動後の会話再開、履歴移動後の内容維持、共有側の会話一覧が0件のままであることを検証する。実際の ChatGPT モバイル画面の更新そのものはこの検証に含まない。

設定・会話は `~/.openmausbot-personal/`、Electron の設定・端末ペアリング関係は `~/Library/Application Support/OpenMausBot Personal/`。元の `~/.openmausbot` と配布アプリの設定は移行しない。サーバーは `127.0.0.1:8897`（使用中なら 18897、28897）。初期接続は Codex、ボット新規作成の既定は Ask。接続機能とツールは元の権限制御を使う。自分用ビルドの上書きを避けるため配布元の自動更新は停止している。

配布版が初回起動時に自動作成する Miso は通常の新規作成とは異なり、フルアクセスで始まる。必要に応じて入力欄の権限メニューから変更する。表示復元はこの権限を変更しない。

再ビルド後に macOS のキーチェーン確認が出た場合は、要求元がこの Personal アプリであることを確認し、Mac 上で許可する。パスワードをチャットへ送る必要はない。確認待ちの間は「Opening your workspace…」で止まることがある。暗号化を外したり認証保存先を削除したりして回避しない。

## 登録語句の置換と復元

設定 → 一般 → **登録語句の置換** で、置換先・複数の表記・元に戻す際の表記を登録し、「置換設定を保存」を押す。取得ツールと定期実行は個別にオン・オフできる。通常の手入力チャットには自動適用しない。Google Chat連携の受信本文は登録語句だけを置換する。

例えば「星野架空」「ほしのかくう」「Kaku Hoshino」を同じルールへ登録すると、どの表記も `⟦ユーザーA⟧` へ置換できる。完全一致で大文字・小文字・空白を区別し、重なる語句は長いものを優先する。復元表記を指定すれば漢字等へまとめて戻せる。

入力欄の「仮名化して入力」から貼り付けた文章にも同じ登録ルールを適用する。結果を確認して入力欄へ戻してから、別途送信する。AIの返答はその会話に限定して表示復元できる。復元下書きは確認・コピー用で、自動送信やツール引数への復元は行わない。

**未登録の氏名・メール・住所・電話・口座・APIキーは自動検出しない。** OpenAI privacy-filter、補助検出ルール、Pythonワーカー、モデルの起動設定は削除した。CLIによる独自のファイル・ブラウザ読取や直接通信も網羅しない。対応表は `private/vault.json`（0600、親0700）に保持する。モデル・Pythonの旧ダウンロードは復帰用に残し、実行時に使用しない。[詳しい範囲](privacy-filter.md) と [Google Chat連携](google-chat.md) を参照。

## スマホ

元の Settings → Remote access、QR・端末ペアリング、端末の失効操作を維持する。Mac が起動していて到達可能な接続先が必要。Mac の localhost URL をスマホへ渡しても接続できない。

仮名化 UI は Mac と同じビルドを使うスマホ Web UI で使える。既存の iPhone/Android ネイティブアプリには新しい仮名化ボタンを追加していないが、既存のチャット・承認・ペアリングの API は維持する。新しい仮名化・復元 API は、ペアリング済み端末の許可リストに会話単位で追加した。既存の端末認証や会話の可視性チェックを経由する。

## ビルド

```sh
node scripts/personal-build-app.mjs
```

ローカルのソースから UI・サーバー・companion・Electron main/preload をビルドする。Apple silicon 用の配布版 0.1.111 を署名検証し、Electron 本体と CUA・音声・ブラウザ・cloudflared 等のネイティブ資材を再利用する。元の配布物は変更しない。ビルド先は `.privacy-dev/personal-build/<UUID>/OpenMausBot Personal.app`。`--install` は Applications の同名アプリが既に存在すれば上書きせず停止する。ローカル署名で、公開・公証・push は行わない。

署名は初回ビルド時に生成する専用のローカル証明書を使い、以降も同じ証明書を再利用する。`.privacy-dev/personal-signing/` の専用キーチェーンと設定は Mac 内に限定する。秘密鍵の平文・PKCS#12 の一時ファイルはインポート後に削除する。キーチェーンはビルド時だけ解除して最後にロックし、既存のログインキーチェーン・既定の検索リスト・システム全体の証明書信頼は変更しない。証明書が壊れた場合に別の鍵を自動生成する代替動作はしない。この署名は Apple の Developer ID や公証を意味しない。

旧ビルドは ad-hoc 署名だったため、再ビルドで macOS の許可と署名が一致しなくなる問題があった。新しい方式への初回移行時は、画面収録とアクセシビリティの **OpenMausBot Personal だけ** を一覧から削除し、現在の `/Applications/OpenMausBot Personal.app` を追加して再許可する必要がある。キーチェーンの確認が出た場合も Mac 上で操作する。TCC データベースの書換え、全アプリの許可リセット、識別子だけを信用する署名要件は使わない。[Apple の署名に関する説明](https://developer.apple.com/forums/thread/819406)も参照。

CUA ホストの識別子も `dev.sora.openmausbot.personal` に合わせる。配布版の `com.openmausbot.app` の許可を照会しない。`node --test scripts/personal-signing.node-test.mjs` は使い捨てキーチェーンで、実行コードを変えても同じ証明書の署名要件が保たれることと、署名後の実行コード改ざんが拒否されることを検証する。

現在の語句置換にPython環境・モデルは不要。下記の過去のOPF・MPS実測は、削除前の機能についての履歴である。

## 検証

`node scripts/registered-words-acceptance.mjs` は使い捨てHOME・データ、実サーバー・実MCPプロキシ、ループバックの模擬AIを使う。登録した複数表記の置換、定期実行への適用、通常チャットの非適用、表示復元、画像拒否、設定破損時の原文送信停止を確認する。未登録メールがそのまま通ることも検証し、自動検出があると誤認させない。証拠は `.privacy-dev/evidence/registered-words-acceptance.json`。実大学チャット・実AI・Piへの操作は行わない。

以下は以前のバージョンの検証記録であり、現在の自動検出機能を意味しない。

### 2026-10-15 上流更新の再検証

改良内容を `f6231d6fb` に保存してから、上流 `de63346e9` までの195コミットをマージした。復帰用のローカルブランチは `backup/privacy-before-upstream-20261015`。依存パッケージとロックファイルはこの上流更新では変わっていない。

関連 UI・仮名化・スマホ用プロキシ等の444テスト、Codex・承認・送信境界等の466テスト、Electron の799テストが成功（Electron は別途3件スキップ）。統合時の整理後にも仮名化・入力欄・ファイルサイズ制約の11テストを再実行して成功した。全テストスイートの実行ではない。上流のファイルサイズ制約は緩めず、Composer の表示部品を分離した。

使い捨てデータで Personal と厳格モード両方の受け入れ検証に成功した。Personal の初回GPU仮名化はモデル読込込み10,953ms、既存のChatGPTログインによるCodex実応答も再確認した。厳格モードでは送信境界モックのペイロード、履歴の仮名、異常時の遮断、未対応経路・WebSocketの拒否を確認した。実在の大学チャットは使用していない。

ビルド元のコミットと上流コミットはアプリ内の `personal-build.json` とローカルの `.privacy-dev/evidence/personal-app-build.json` に記録する。モデル・対応表・認証情報・アプリ本体はGitに含めない。

再ビルドしたアプリ内の `Resources/server` を一時 HOME へコピーしたパッケージ検証も成功した（独立起動、MCP、CLI、暗号化バックアップ、子プロセスの終了等）。push 前の lint・型検査・12言語のカタログ検査も成功した。

フォークの移転先は [SORALNV/OpenMausBotPersonal](https://github.com/SORALNV/OpenMausBotPersonal/tree/codex/privacy-filter)。改良版は `codex/privacy-filter` ブランチを使う。ローカルの origin も移転先へ更新し、既存の SSH 認証で保存した。

## キーチェーン確認を更新ごとに繰り返さない構成

Personalの通常更新は固定の起動アプリと、更新可能な署名付きランタイムを分ける。自己署名アプリでは、同じ証明書でもキーチェーンのPartition-IDがビルドごとのcdhashを記録していた。2026-10-22の読み取り専用の診断で、Safe Storageの1項目に18個の過去のcdhashが確認された。秘密の値は取得せず、既存項目やACLは削除・緩和しない。

```sh
OMB_PERSONAL_BASE_APP='/Applications/OpenMausBot Personal.app' node scripts/personal-build-app.mjs
node scripts/personal-package-runtime.mjs
# Personalを終了してから実行する
node scripts/personal-install-runtime.mjs
```

初回だけ `/Applications/OpenMausBot Personal.app` を固定ランチャーへ移行してバックアップを残す。その後の通常更新ではランチャーを変更しない。ランタイムは `~/.openmausbot-personal/runtime/versions/<UUID>/OpenMausBot Runtime.app` に保存する。privateな `active.json` を原子的に切り替える。起動前に専用識別子とローカル署名証明書を検証し、改ざん・別署名・不正なパス・symlink・他ユーザー所有は拒否する。検証できなければコードを読み込まない。固定ランチャーは署名とASAR整合性情報を保持し、暗号化・Keychain保護を無効にしない。

移行時の初回はmacOSの確認が必要になる可能性がある。対象がPersonalのSafe Storageであることを確認し、継続利用を許可する場合はMac上で「常に許可」を選ぶ。パスワードをチャットへ送る必要はない。固定ランチャーやElectron本体・署名証明書そのものを将来更新した場合、またはキーチェーンのロック・OS側の設定によっては再確認が必要になる。すべてのOS認証が永久に出なくなるという保証ではない。

`node --test electron/personal-runtime-verifier.node-test.mjs` で起動前検証を確認する。アプリ全体を以前のビルド手順だけで上書きすると固定署名の効果が失われるため、通常は上記のランタイム更新手順を使う。履歴の保全・Pi/M1接続・マスクOFF設定も更新時に確認する。

起動部分そのものの修正時に限り、`personal-install-runtime.mjs --migrate-launcher` で固定ランチャーも明示的に更新できる。その場合は署名ハッシュが変わり、OSの再確認が起こり得る。通常更新ではこの指定を使わない。

## 2026-10-22 上流0.1.121との統合

上流 `bdcfc4404` を取り込み、Personal固有のNativeConnect、手動置換・マスク設定、送信キー、グループごとの権限を維持する。直前のソースは `cda287b54` と `backup/personal-before-upstream-20261022-cda287b54` に保存。上流の音声入力PR #3044はマージ済みなので、その共通フックを使う。グループ投稿の共通判定には、上流で追加されたWebhook経路でもメンバー権限と閲覧範囲を適用する。

通常更新は上記のランタイム切り替えを使う。固定ランチャーのバージョンとは別に、検証済みランタイムのバージョンをサーバー、接続サービス、Aboutへ渡す。現在の組み込みスキルとライセンスもビルドへコピーし、古いベースアプリの内容を引き継いだままにしない。既存の会話・認証は消さず、Privacy Filterの保存済みOFF設定を維持する。

検証は使い捨てHOME・偽エンジンで行う。実ユーザーのM1/Piへ検証命令は流さず、導入後は起動・接続設定・履歴の保全を確認する。最新上流の全機能の実サービス検証や、物理スマホからの再ペアリング検証を意味するものではない。

この統合の実測結果は `.privacy-dev/upstream-update-report.json`。関連単体202件、最終回帰27件、グループ・バックアップ29件、companion482件、Electron・NativeConnect1024件が通過（Electronは3件スキップ）。回帰実行の間には重複がある。統合122件は初回120件成功・2件が過負荷時の隔離サーバー起動期限切れとなり、その2件だけの再実行で両方成功した。パッケージサーバーの独立起動・MCP・暗号化バックアップ・終了、UI/サーバー/companionの型検査も通過した。

0.1.121を署名付きランタイムとして導入し、8897での通常起動とスマホ用中継のreadyを確認。追加のキーチェーン確認は出なかった。固定ランチャーのCDHash・ASARは不変で、ネイティブAboutの括弧内ビルド番号は固定ランチャーの0.1.111、アプリケーションとサーバーのバージョンは0.1.121。既存2381メッセージの欠落・本文変更は0件。設定・グループ・Google Chat・M1/Pi接続設定とPrivacy Filter OFFは不変。Bot情報は上流の `repairThreadUpdatedAts` によるスレッド日時2項目の単調な補正だけが差分で、それ以外は同一だった。全データとElectronプロファイルのローカルバックアップ、旧ランタイムの復帰用ポインターを保持している。
