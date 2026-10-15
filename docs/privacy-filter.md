# Mac 内での個人情報保護（個人用フォーク）

2026-10-15。対象は OpenMausBot `499309c79b6b5717b9338676649ba8df38f4dfb9`。
認証済み GitHub アカウント `SORALNV` に [フォーク](https://github.com/SORALNV/OpenMausBot) を作成し、`codex/privacy-filter` で変更した。変更の push・公開は行っていない。

この実装は、**専用Macアプリまたは専用ランチャーで起動した改良版のテキスト API 会話**を保護する。日本語の検出漏れが残るため、完全な漏えい防止・匿名化を保証するものではない。本番データへの適用は未実施。

## 起動

この Mac では依存関係・公式モデル・トークナイザーの準備済み。

普段は **`/Applications/OpenMausBot Privacy.app` をダブルクリック**する。Dock に表示される専用の Mac アプリで、ブラウザーを別途開く必要はない。起動時に GPU フィルターと改良版サーバーを立ち上げ、準備が完了してから専用ウィンドウに画面を表示する。ウィンドウを閉じるか Cmd-Q で終了すると、起動したサーバー・GPU フィルターも停止する。

専用アプリは AppKit / WebKit 製で、配布版 Electron の機能や認証情報は読み込まない。WebKit の保存領域はメモリ内だけで、会話・設定・対応表は引き続き `.privacy-dev/data/` に保存する。専用アプリは GPU 必須。起動したプロセスだけが応答できる確認用トークンで、API の厳格モード・MPS 初期化完了・UI の CSP を確認してから画面を開く。未対応の接続方法へ切り替えたり、既にそのポートで動く別のアプリを開いたりしない。

この Mac 専用のアプリであり、`/Users/sora/Code/OpenMausBot` のソース・依存関係・モデルと Homebrew の Node.js を参照する。そのフォルダーは移動・削除しない。ソースからの再作成は `node scripts/privacy-build-app.mjs`。`--install` を付けると Applications に新規配置するが、既存の同名アプリは上書きしない。アプリ自体はローカルの署名で、配布・公証・外部公開は行っていない。

ターミナルで開発する場合は次を使う。専用アプリと手動ランチャーは同時起動せず、先に使っていた方を終了する。

```sh
cd /Users/sora/Code/OpenMausBot
node scripts/privacy-dev.mjs
```

UI は `http://127.0.0.1:5299`、サーバーは `http://127.0.0.1:8899`。停止は起動したターミナルで Ctrl-C。
`pnpm privacy:dev` または `pnpm dev` も同じ起動方法。`pnpm dev:server` は保護版サーバーだけを起動する。
この環境では pnpm をグローバルに追加せず、必要なら `.privacy-dev/tools/node_modules/.bin/pnpm` を使える。

Apple GPU は既定で自動選択する。GPU を必須にする場合は次で起動する。利用できない場合は送信を止める。

```sh
OMB_PRIVACY_DEVICE=mps node scripts/privacy-dev.mjs
```

`OMB_PRIVACY_DEVICE=cpu` で CPU 比較ができる。既定の `auto` は起動時に MPS が利用できなければローカル CPU を選ぶ。GPU の初期化・実行に失敗した後の自動切替は行わない。モデルはサーバー起動時に読み込み、固定の確認文をローカルで推論してから HTTP の受付を始める。その後も同じプロセスで保持する。準備に失敗した場合はサーバーを起動しない。

初期状態では実サービスのキーを設定していない。接続先・モデルは、停止中に `.privacy-dev/data/config.json` の `instances.privacy-api.config.url` と `model` を設定する。初期値は OpenRouter の互換 API。初回起動時だけ `OMB_PRIVACY_API_URL`、`OMB_PRIVACY_MODEL` でも指定できる。既存の開発設定は上書きしない。

専用 Mac アプリはターミナルの環境変数を引き継がない。アプリで使う専用 API キーは、アプリを終了してから同じ `config.json` の `instances.privacy-api.config.key` にローカルで設定し、開き直す。設定ファイルは `0600`・Git 対象外だが平文なので、キーをチャットや Git に貼らない。キーの設定や実サービスとの接続確認はまだ行っていない。

専用の `OMB_PRIVACY_API_KEY` をローカルのターミナルから設定して起動する。キーはチャットや Git に貼らない。ランチャーはこの変数だけをプロバイダーの認証用に引き継ぐ。既存アプリのキー・CLI のログインは読み込まない。認証ヘッダーのキー自体は接続先サービスに必要な認証情報であり、本文の仮名化とは別。キーの本文への混入は、モデル判定に加えて一致置換する。

新しい環境での準備は Node 24+ と uv を用意して、リポジトリ指定の pnpm 10.33.0 で依存をインストールした後、次を実行する。

```sh
node scripts/privacy-setup.mjs
```

セットアップ時だけ公開モデル等を取得する。ユーザーの文章は使わない。OPF ソースは `f7f00ca7fb869683eb732c010299d901457f19c3`、Hugging Face の重みは `7ffa9a043d54d1be65afb281eddf0ffbe629385b` に固定した。主な Python 依存バージョンは `scripts/privacy-requirements.txt` に記録している。

**`node server/index.ts`、`pnpm omb`、既存の Electron・配布アプリ、手動の低水準エントリーポイントには自動で保護を適用しない。** 保護状態は `OMB_PRIVACY_MODE=strict` と専用 preload の組合せで成立する。保護版で `OMB_PRIVACY_MODE=off` を使用しない。専用 Mac アプリもこの保護ランチャーだけを起動する。既存 Electron 版の改造・パッケージ化や本番移行は行っていない。

## 分離とローカル保存

| 対象 | 開発版の保存先・扱い |
| --- | --- |
| アプリ設定・会話・記憶 | `.privacy-dev/data/` |
| 子プロセスの HOME | `.privacy-dev/home/` |
| 公式モデル・Python 環境 | `.privacy-dev/checkpoint/`、`.privacy-dev/venv/` |
| 仮名の対応表 | `.privacy-dev/data/private/vault.json`、`0600` |
| 利用者の保護語句 | `.privacy-dev/data/private/terms.json`、`0600` |
| private ディレクトリ | `0700`。リンクや公開権限を拒否 |
| コンソール | 厳格モードでは引数の内容を出さず、内容省略の通知だけを出す |
| provider-native ログ | 厳格モードでは書き込まない |
| Git | `.privacy-dev/` と `.local-privacy-filter/` は除外 |

既存の `~/.openmausbot`、会話・設定・認証情報は移行・変更していない。2026-10-15、利用者の削除依頼に従い、配布版 `/Applications/OpenMausBot.app` を終了し、`~/.Trash/OpenMausBot.app` へ移動した。改良版はこのリポジトリからのみ起動する。開発ランチャーは既定の本番ポート `8799`、`8800`、`5199` を拒否する。Webhook は厳格モードでは起動しない。

対応表はローカルの平文ファイルであり、暗号化ストアではない。通常の会話保存には利用者が入力した原文が残る。今回の保護対象は外部モデルへ渡すリクエストであり、既存保存データの匿名化ではない。OS の別プロセスからの読取や、OS 側の同期・バックアップは制御しない。

## 調査した送信経路と実装範囲

| 接続・機能 | 送信経路 | 厳格モード |
| --- | --- | --- |
| OpenAI-compatible、OpenAI API、OpenRouter 等の Chat Completions | `openai-compat.ts` → `openai-chat.ts` → HTTP | 共通境界で検査してテキストだけ送信 |
| xAI Grok API、MiniMax、Mistral、Cerebras、Groq、Meta API | 各ドライバー → 同じ `createOpenAIChatRuntime` | 同じ保護層。各ベンダーとの実通信は未検証 |
| Claude Code、Codex | CLI の stream-JSON／app-server、背景生成・keep-warm。CLI 自身のファイル・ネットワーク・履歴読取がある | インスタンス生成前に無効化。CLI の送信を保護済みとは扱わない |
| Grok Build、Gemini、Kimi、Droid、Cursor、OpenCode、Qwen、Hermes、Cline、独自 ACP | `drivers/acp/` の子プロセス、独自のツール・ブラウザ・ファイル送信 | 同上。未知のドライバーも無効 |
| Pi、Antigravity、Muse Code | 独立した CLI／SDK・推論経路 | 同上。未対応 |
| ChatGPT プラン認証・独自 Responses 経路 | Codex／専用認証経路 | 未対応の接続方式として無効。Chat Completions で利用する OpenAI API とは別 |
| 会話履歴、system、記憶・recall、補助要約の入力 | 履歴再構成・メモリ層 → 各モデル呼出し | 対応する HTTP 経路の本文全体を毎回検査。以前の送信済み履歴も再検査 |
| MCP／接続アプリ／ブラウザ／ファイル／computer／data ツール | ツールの戻り値 → 次のモデルリクエスト。ツール自身にも別の送信経路がある | ツールのマウント・宣言・実行を無効化。結果テキストの保護は境界の fixture で検証したが、実ツールとの連続実行は提供しない |
| Jev／OpenRouter の decision model | `decider/jev.ts`、`decider/openrouter.ts` の別 HTTP | 無効。未保護の fetch は拒否 |
| 音声・Live call・画像生成 | `tts/`、`live-call.ts`、`avatar-image.ts` 等の別 HTTP | API・UI の Live host・WebSocket を無効化 |
| 添付・画像・音声・動画・バイナリ | アップロード、画像パート、ファイル参照、base64 等 | 送信停止。テキストファイルも直接添付せず、必要なら内容を本文へ貼る |
| 定期実行・Webhook・記憶の自動 upkeep | 通常チャット以外からの自動起動 | 停止 |
| 共有・公開・クラウド移行・接続設定・外部 MCP | API、別プロセス、外部サービス | 関連 API を許可しない。外部 MCP クライアントが独自にローカルファイルや原文会話を読む行為は保護対象外 |

レジストリの許可対象は上表の共通 HTTP ランタイムを使う 7 種類に限定。専用ランチャーで生成する接続は `openai-compat` のみ。HTTP API の許可リスト、loopback 制限、WebSocket の拒否、ツール無効化を組み合わせた。これは OS 全体のネットワーク・ファイルアクセスを隔離するサンドボックスではない。Node の別 HTTP クライアントや SDK、別の子プロセスを追加するときは経路を再調査する必要がある。

## 保護の動作

1. `openai-chat.ts` が作った送信 JSON を、外部 fetch の前に `protectedChatFetch` に渡す。
2. ネストされた文字列とキーを収集し、Mac 内の OPF 子プロセスへ stdio で渡す。フィルターの HTTP サービスは使わない。
3. OPF の範囲、日本語・メール・電話・口座・秘密情報・ローカルパスの補助ルール、登録語句、既知の原文一致を統合する。
4. `⟦人物_001⟧`、`⟦メール_001⟧` 等に置換。対応表をローカルへ保存できた後だけ送信する。対応表自体を本文に追加しない。
5. リダイレクトは拒否。プロバイダーのエラー本文もログや画面へそのまま転送しない。

同じ開発データ領域では会話・補助生成をまたいで同じ**完全一致の原文**に同じ仮名を使い、再起動後も維持する。表記揺れ・略称・同一人物の推定による名寄せはしない。仮名には会話間の関連付けが残る。

OPF は Apple GPU（MPS）またはローカル CPU、CPU 処理 4 スレッド、4096 トークンの推論ウィンドウで実行する。HF の offline 設定を強制し、ソケット接続・DNS 解決・UDP 送信を検出プロセス内で禁止する。モデルもトークナイザーも事前にローカルへ取得する。モデル未設定・GPU 例外・不正な範囲・文字位置の不一致・120 秒の検出タイムアウト・保存失敗では原文へ戻さず送信を止める。

GPU では [`privacy_metal.py`](../scripts/privacy_metal.py) が、公式 OPF の MoE 射影だけを Metal カーネルへ置き換える。専門モデルの重みをトークンごとに複製・FP32 化する処理を避け、GPU 上の元の BF16 重みを直接読み、FP32 の積和を並行計算する。重みの量子化、expert 数の削減、入力や検出カテゴリの省略は行わない。Attention、トークナイザー、Viterbi 復号は固定した OPF の実装を使う。このアダプターは今回の固定ソース・重み用で、別のモデル構成にはそのまま流用しない。

OPF の結果は完全一致の入力文字列をキーとするプロセス内 LRU に保持する。上限は 2,048 件・文字列と範囲の符号化サイズ合計 4 MiB（Python オブジェクトの管理領域は別）。同一リクエスト内の重複キーや過去の履歴を再推論しない。キャッシュはディスク・通常ログ・外部へ出さず、プロセス終了で消える。失敗した結果は保存しない。補助ルール、登録語句、対応表、認証情報の本文混入チェックはキャッシュに関係なく毎回適用する。

1 リクエストは UTF-16 で計 100,000 文字、512 文字列、深さ 32 まで。対応表は 20,000 エントリーまで。認識できる添付マーカー・非テキストの content part・長いエンコード列も拒否する。短い未知の符号化・難読化・分割された秘密を完全に検出できるわけではない。

## 利用者の保護語句

`.privacy-dev/data/private/terms.json` を UTF-8 の JSON 配列で編集する。内容は API の設定画面やログへ出さない。権限が `0600` 以外、JSON が不正、ラベルが不正な場合は送信を止める。

```json
[
  { "text": "星野 架空", "label": "private_person" },
  { "text": "架空プロジェクトの非公開名称", "label": "secret" }
]
```

使用できるラベルは `private_person`、`private_address`、`private_email`、`private_phone`、`account_number`、`secret`、`private_url`、`private_date`。上の語句は検証用の架空データ。

## 表示専用の復元

AI の返答と会話に保存するテキストは仮名のまま。必要なときだけ「このMac内だけで表示を復元」を押すと、loopback 認証済みの `/api/privacy/display` が置換し、その結果を React の通常の文字列として表示する。HTML・Markdown のリンク・画像・埋め込みにはしない。応答は `no-store`。本文・会話・ツールの入力へ書き戻さない。

外部送信やツール引数のための自動復元は実装していない。既存の承認処理には変更を加えず、厳格モードでは実行するツール自体がない。通常モードのツール承認の回帰テストも実施した。

保護版 UI では analytics、外部リソース、初回の名前・メール登録、Live call host を止める。CSP は外部接続・外部画像・埋め込み・フォーム送信を拒否する。保護版の画面下部には厳格モードと日本語の検出漏れについて常時表示する。設定画面の一部やグループ・拡張機能等は今回の許可リストに含まず、操作は 403 になる。

## 実測

Apple M1、16 GiB、macOS 27.0.1 arm64、Python 3.12.13、PyTorch 2.14.1。公式 CPU 実装と、同じ重みを用いた MPS/Metal アダプターを実測した。重みファイルは約 2.80 GB。CPU と GPU のモデルは同時に動かさず順番に計測した。

| 合成データ評価 | CPU・4 スレッド | Metal 最適化後 |
| --- | ---: | ---: |
| モデル読込・Metal コンパイル（Python import を除く） | 3,085 ms | 4,967 ms |
| 未キャッシュの短文 12 件の検出合計 | 5,056 ms | 736 ms（6.9 倍） |
| 履歴を模した 39 項目（16 項目を推論、23 項目は重複） | 3,308 ms | 614 ms（5.4 倍） |
| 5,044 文字・4,015 トークンの未キャッシュ長文 | 50,775 ms | 5,226 ms（9.7 倍） |
| 同じ 39 項目の再検出 | 0 ms（丸め後） | 0 ms（丸め後） |
| ピーク RSS | 4,079,992,832 B | 3,010,019,328 B |
| Metal メモリの最大観測値（driver） | — | 4,324,589,568 B |
| OPF 単体の期待範囲全体の被覆 | 12 / 14 箇所 | 12 / 14 箇所 |

詳細は [CPU の記録](privacy-benchmark-cpu.json) と [Metal の記録](privacy-benchmark.json)。短文、39 項目、長文とその再送の全検出範囲・分類をハッシュでも照合し、今回の評価入力では完全一致した。小型のランダム MoE でも、端数寸法・複数バッチ・SwiGLU の両配置を含む 15 条件で元の計算と `rtol=atol=2e-5` 以内で一致した。FP32 の加算順序は変わるため、任意の入力についてビット単位の一致や検出精度の維持を保証するものではない。

時間は検出ワーカーの処理時間で、外部 AI の応答時間を含まない。キャッシュの 0 ms は整数への丸め結果で、アプリ全体の応答が 0 ms になるという意味ではない。モデル読込は初回だけ別途必要。Metal の tensor 使用量は処理後に約 3.07 GB、driver は約 3.25 GB（長文後約 4.32 GB）を観測した。Metal の値は応答時点・読込完了時点の標本で、処理途中の真のピークではない。RSS と Metal の値は共有メモリを含み、単純加算できない。

小規模な人工データの smoke 評価であり、実際の日本語に対する再現率とは呼ばない。4,096 トークンを超える複数ウィンドウの性能・長時間高負荷運転・別の Mac では未検証。

「私は星野架空です」「😀担当者は星野架空です」の氏名を OPF が見逃した。全角メールを人物として分類した例、敬称や句読点まで含む範囲もある。補助ルールと保護語句で今回の架空例を補っているが、未知の日本語氏名・住所・新しいキー形式の検出は保証できない。

## 検証と証拠

```sh
node_modules/.bin/vitest run server/privacy/privacy.test.ts src/components/PrivacyText.test.ts
node scripts/privacy-acceptance.mjs
.privacy-dev/venv/bin/python -m unittest discover -s scripts -p 'privacy_*_test.py'
.privacy-dev/venv/bin/python scripts/privacy-benchmark.py --device cpu --stress --output docs/privacy-benchmark-cpu.json
.privacy-dev/venv/bin/python scripts/privacy-benchmark.py --device mps --stress --reference docs/privacy-benchmark-cpu.json
```

受入検証は実サーバーを一時 HOME・一時データ領域・空きポートで起動し、検証用 API も `127.0.0.1` にだけ置く。実在の個人情報・既存アプリのキー・外部 AI サービスは使用しない。操作は既存の MCP/検証 CLI と同じ `handleToolCall` を使い、URL を明示する。

検証するものは、架空の日本語氏名、住所、メール、電話、口座、API キー、登録語句、履歴、記憶テキスト、ツール結果テキスト、同一仮名、再起動後の対応表、UTF-16 の位置、壊れた検出結果、タイムアウト、メディア拒否、未知の CLI 拒否、実ドライバーの送信ペイロード、表示用復元の不活性な描画。

受入検証では、公式 OPF を通った 2 回の実際の HTTP ペイロードに架空の原文がないこと、履歴でも同じ仮名になること、表示だけが復元されること、未対応 API と WebSocket が拒否されること、保護語句ファイルを壊した後の追加送信が 0 件であることを確認する。コンソールにも架空の原文がないことを確認する。実ペイロードは `.privacy-dev/evidence/acceptance.json` に合成データの証拠として残し、Git から除外する。一時サーバーと一時データ領域は終了時に削除する。

起動時のモデル先読みを追加した Metal 版受入検証は全体 13,054 ms（起動待機を含む）、初回会話 961 ms、履歴付きの 2 回目 467 ms だった。API は即時応答のローカルモックであり、実際の外部 AI の待ち時間は含まない。GPU 初期化エラーを返すワーカーの試験でも、送信先モックが 0 回であることを確認した。不正な device 指定でも検出結果や原文を返さず、固定したエラーで終了した。

関連ドライバー・レジストリ・既存ツール承認・HTTP・analytics の回帰テスト、型チェック、lint、保護版の production build も実施した。結果は次のとおり。

専用 Mac アプリは Swift のコンパイルとローカル署名の検証、独立ウィンドウの表示、終了時の GPU ワーカー停止、再起動後の単一起動を実機で確認した。アプリ用の起動確認を追加した一時サーバーの受入検証と、関連 57 件・server 型チェック・変更ファイルの lint も成功した。既存の Electron テストは専用 AppKit アプリの検証とは別。

| 検証 | 結果 |
| --- | --- |
| 保護・ポート分離・既存会話/承認等の関連回帰 | 9 ファイル、286 件成功（保護と表示 48 件、ポート 9 件を含む） |
| Python のキャッシュ・Metal 数値検証 | 5 件成功（GPU 数値検証内に 15 条件）。GPU なしの環境では GPU 検証が skip される |
| TypeScript（UI・server） | 成功 |
| lint | 警告なしで成功 |
| 保護版 UI の production build | 成功（既存の chunk サイズ警告あり） |
| Electron の既存テスト | 754 成功、3 skip、失敗 0 |
| broker | 22 件成功 |
| packaged server の既存 smoke | 成功。保護版 Electron の認証ではない |
| 実サーバー + 公式モデル + モック送信先 | 成功、正常時 2 ペイロード、失敗後の追加送信 0 |
| 全体 `pnpm test` | 実行したが未完走で中断。全体合格とは認定しない |
| 既存の行数・ルート制限 | 行数チェック 1 件失敗（下記 2 ファイル）。ルート数チェックは成功 |

既存の `scripts/testing/file-size-ratchet.test.ts` は、変更前の HEAD でも `server/index.ts` が 17,779 行（記録 17,755）、未変更の `server/drivers/codex.ts` が 1,911 行（記録 1,906）で失敗する。今回の index への配線は HEAD から行数を増やしていない。この既存問題を修正したりチェックを緩めたりしていない。

## 公式資料

- [OpenMausBot の構成・接続方式](https://github.com/milind-soni/OpenMausBot)
- [Privacy Filter README と制約](https://github.com/openai/privacy-filter/blob/f7f00ca7fb869683eb732c010299d901457f19c3/README.md)
- [公式モデルの固定リビジョン](https://huggingface.co/openai/privacy-filter/tree/7ffa9a043d54d1be65afb281eddf0ffbe629385b)

公式 README は主に英語向けとし、非英語・非ラテン文字での性能低下、未知の名前・キー形式の見逃し、誤検出や範囲のずれを挙げている。本実装でもその制約は残る。
