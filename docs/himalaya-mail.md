# メール管理人とHimalaya

2026-10-19、利用者の明示承認とローカルでのパスワード入力により `mprg` を追加した。受信・送信の認証確認と、専用ラッパーによる直近1日分の取得に成功した。既存ルーティンは登録済み全アカウントを毎日0/6/12/18時（Asia/Tokyo）に取得するため、対象は5件となる。ルーティン・モデル・通知先は変更していない。全5アカウントのmonitor取得も9.222秒でcomplete=true。これは通知配信や新着到着の実証ではない。

アカウント追加で既存stateの設定identityが変わると、ラッパーはSTATE_SCOPE_CHANGEDで停止する。今回の4件は、排他ロックと非公開バックアップを保持し、別の一時stateで既存pending/checkpointの再取得・同一性検証に成功した後、設定identityだけを手動で関連付け直した。未処理バッチ・resume・last_ackを保持し、ackや初期化はしていない。通常のラッパーに自動リセットや自動関連付け変更は追加していない。今後の設定変更でも、このエラーを無条件に無視したりstateを消したりしない。

Personal版の指定ボットに [Himalaya操作スキル](../integrations/himalaya-mail/SKILL.md) を登録する。シェル関数や PATH には依存せず、独自Forkの実行ファイルを ~/.local/libexec/himalaya-openmausbot/himalaya に配置する。参照する設定は ~/.config/himalaya-security-test/config.toml。秘密情報を複製したりGitに保存したりしない。

```sh
cd /Users/sora/Code/himalaya
cargo build --locked --offline
mkdir -p /Users/sora/.local/libexec/himalaya-openmausbot
install -m 755 target/debug/himalaya /Users/sora/.local/libexec/himalaya-openmausbot/himalaya
cd /Users/sora/Code/OpenMausBot
node scripts/connect-himalaya.mjs --url http://127.0.0.1:8897 --bot メール管理人
```

登録スクリプトは既存ボットを名前で1件に特定し、通常のスキル登録APIから有効化する。SOUL・承認モード・他ボット・MCP設定・既存会話は変更しない。再実行時は同一内容の有効なスキルなら何も書き換えず、内容が異なる場合や無効化されている場合は停止する。

デスクトップ管理下の本番アプリは、認証のないシェルからの変更を403で拒否する。その場合はアプリの「メール管理人 → スキル → スキルを追加 → コマンドを作成」で登録する。名前を himalaya-mail、説明をSKILL.mdのdescription、指示を同ファイルの本文にする。起動用の秘密情報を抜き出したり認証を緩めたりして迂回しない。UIが追加するコマンド用の見出しと案内は、登録スクリプトの完全一致判定では別内容として扱われる。

使い方の例は「全アカウントの直近30分の新着を見せて」「登録アカウントを教えて」「gmail-testの受信一覧を25件」「そのメールの本文を確認して」。対象ボットの次のターンからスキル索引に表示される。モデル自身が索引を読んで適切に操作することと、アプリの操作承認は引き続き必要。

ラッパーはアカウント・メールボックス・一覧・検索・本文の読み取りと、明示的な `monitor` のローカル進捗保存を許可する。本文取得は既読化しない。送信・削除・移動・フラグ変更・添付ファイルの保存には対応しない。これはラッパーの制限であり、ボットに別途許可されたシェルやファイル操作すべてを隔離するサンドボックスではない。

`inbox --since 30m` はアカウント一覧を取得後、各アカウントへ独立した `inbox scan` を実行する。既定25件×4ページ。page-size/max-pagesの入力は従来の100まで受け付けるが、子プロセスには最大50件・4ページへ制限して渡す。子プロセスの既定期限12秒、処理全体の実行予算52秒。期限後のアカウントも不完全として結果に残す。単一scanは最大128 KiB、ラッパー全体は改行を含め1 MiB以内。バッチを途中で切り捨てず、出力枠に収まらないアカウントは `OUTPUT_LIMIT` として後から個別取得する。成功した他アカウントの取得結果と継続情報は維持する。

結果は `entries` に統合一覧、`accounts` に各アカウントの `complete`・`since`・`as_of`・`cursor`・`next_cursor`・`checkpoint`・`reason` または安全な `error.code` を持つ。`complete=false` は必ず「取得範囲が不完全」と明示し、「重要な新着なし」「新着ゼロ」と結論しない。`ENTRY_TOO_LARGE` はそのメールを越えて進まない。`OUTPUT_BUDGET`・`PAGE_LIMIT`・取得行/受信時刻の欠落などでも未処理範囲が残る。失敗で生のstdout/stderrや例外メッセージを転送せず、`TIMEOUT`・`OUTPUT_LIMIT`・`PROCESS_EXIT`・`INVALID_JSON`・`ARGUMENT`・`CONFIG` 等の固定コードと、得られた場合のみ時間・バイト数・終了コード・signalを返す。

期間はIMAPのINTERNALDATEを使い、送信者のDateに置き換えない。検索の `date`・`after` はHimalaya本来の送信者Date条件なので、直近取得の代用にしない。scanはIMAP専用。非IMAPは明示的に `UNSUPPORTED_BACKEND` を返し、全件確認済みとは扱わない。期間・継続指定のない `inbox` と `inbox --all-time` は従来の非IMAP一覧にも対応し、上限・受信時刻欠落・重複等による不完全さを維持する。

通常取得の継続は `inbox --account ACCOUNT --cursor TOKEN`、完了済みcheckpoint以降の新しい取得は `inbox --account ACCOUNT --after TOKEN`。両方同時には指定できない。cursorはアカウント・メールボックス・期間・as_of・UIDVALIDITY・上限UIDに結び付く。期間を再指定する場合は元の期間に合わせる。`--after` は新しいUID範囲を取得し、停止期間をまたぐ場合は前回as_ofまで期間を延ばす。UIDVALIDITY変更は `UIDVALIDITY_CHANGED` で停止する。トークンの解析・改変や自動リセットはしない。通常取得はmonitorの進捗を一切消費しない。

scanの各アカウントには真偽値 `deferred` も返る。INTERNALDATEがas_ofより未来のUIDを検出した場合、そのメールは今回のentriesから除外し、最初の未来UIDの直前までcheckpointを戻して後続ラウンドで再確認する。`complete=true, deferred=true` は今回の固定スナップショットの走査完了を表し、未来の受信時刻が保留されている。後続UIDの一部が別batch_idで再提示されることがあるため、必要な重複防止はaccount・mailbox・uid_validity・envelope.idの組で行う。batch_idだけではラウンドをまたぐ重複を防げない。ラッパーはメールID一覧を永続保存せず、CLIの定数サイズの継続情報を扱う。

件数制限はFETCHするサマリーと出力の上限であり、サーバー側の候補UID一覧を作るSEARCHのメモリ上限ではない。現在のIMAPライブラリは検索に一致したUID一覧を一度保持する。通常は受信時刻で期間を絞り、全期間のmonitorを常用しない。子プロセス期限は検索を含む時間超過を止めるが、厳密なRAM上限を保証するものではない。

## 明示的なmonitorとack

実際の「メール管理人」の通常指示は `integrations/himalaya-mail/BOT_INSTRUCTIONS.md`、新着監視のプロンプトは `integrations/himalaya-mail/MONITORING.md` に保管する。2026-10-18に認証済みPersonal設定画面から両方を更新し、再度開いて本文一致を確認した。既存の `0 0,6,12,18 * * *` / Asia/Tokyo、有効状態、1日分の期間、監視開始時刻、前回実行の引き継ぎ、ボットのメインスレッドへの結果投稿は維持した。通常指示は古い登録スキルの説明より新しいローカル手順を優先し、重要メールの通知成功が確認できるまではackしない。最終返信だけで通知する場合は次回までpendingを保持する。

設定更新の前に使い捨てfake-engineサーバーでSOUL・スキル・ルーティン本文の保存と、プロンプト以外のスケジュール等の不変性を検証した。本番では指示の保存と読み戻しだけを行い、検証メッセージの送信、ルーティンの手動起動、既存の評価済みID/monitor stateの初期化は行っていない。設定済み1日分の通常取得は実4アカウントすべてcomplete=trueを確認した。Forkの受信走査は `SORALNV/himalaya` の `codex/unified-inbox`、commit `3d3c212dccc93545fa4ec5ddf393e1f043102d1f` にpush済み。Web設定/旧TLS等の別作業や上流PRはこのpushに含めていない。

```sh
node scripts/himalaya-readonly.mjs monitor --since 30m
node scripts/himalaya-readonly.mjs monitor --account ACCOUNT --since 30m
# 結果を確認・処理してから、そのアカウントのbatch_idを指定する
node scripts/himalaya-readonly.mjs monitor --account ACCOUNT --since 30m --ack BATCH_ID
```

monitorの既定期間は明示的な30m。設定ファイルのあるディレクトリの `monitor-state/` に、設定パス・アカウント・メールボックス・期間別の進捗を保存する。30m以外やメールボックス指定で取得した場合、ackにも同じ指定を付ける。各アカウントの `batch_id` に対するackが必要。取得しただけでは進捗を確定しない。AI/利用者が当該バッチを確認・処理した後にackする。未処理のまま次のmonitorを呼ぶと、保存した同じ `response.cursor` と取得条件で再取得し、同じbatch_idを返す。保存したSHA-256指紋と結果が異なる場合は、同時expunge等を疑い `REPLAY_CHANGED` で停止し、勝手に飛ばさない。初回・新しい取得ラウンドではラッパーが事前にas_ofを固定せず、CLIがEXAMINE/UIDNEXT取得後に決める。成功した応答のas_ofだけを保存し、pendingの再取得に使用する。

ackは未完了ならnext_cursor、完了ならcheckpointのみを確定し、新規メール取得を行わない。同じ最後のackの再実行は冪等で、次の未処理バッチがあってもそれを進めない。ack応答の `acknowledged` はローカル処理確認を表し、新着の有無を表さない。取得後・応答前の終了でも保存済みpendingを再取得できる。処理途中の終了による同一バッチの再提示はあり得るため、外部処理はbatch_idで重複を避ける。

保存内容は不透明なcursor/checkpoint・取得条件・batch_id・応答指紋・設定のファイル属性指紋だけ。メール本文・件名・差出人・認証情報は保存しない。ディレクトリ0700・ファイル0600・所有者・symlink・hardlink・親ディレクトリの安全性を検査し、排他的lockとfsync/atomic renameを使う。同時書き込みは `STATE_LOCKED`。残ったlockを自動削除しない。破損state、設定ファイルの置換/変更、scopeの不一致は安全側で停止する。復旧時は動作中のプロセスと未処理バッチを利用者が確認し、安易なstate削除で未処理メールを飛ばさない。

このCLIから得たメール情報はPersonal版の入力欄・定期実行用自動マスクを通らない。依頼された本文や差出人等をボットが読むと、設定済み外部モデルにも渡りうる。匿名化必須のメールにこの経路を使わない。Keychainの既存認証をHimalayaが参照し、OSの確認が出た場合は利用者がMac上で対応する。認証エラーでは子プロセスの生ログをボットへ転送しない。

## 検証

```sh
node --test scripts/himalaya-readonly.node-test.mjs
.privacy-dev/venv/bin/python /Users/sora/.codex/skills/.system/skill-creator/scripts/quick_validate.py integrations/himalaya-mail
```

サーバーへの登録・有効化とプロンプト索引は docs/verification/README.md の使い捨てfixtureで確認する。本番の会話へテストメッセージを送らず、実メールを使った送信・削除・移動テストは行わない。

scan/monitorの回帰テストは合成応答、一時0600設定、使い捨てstate、合成Maildirのみを使う。未ack再取得、部分継続、ack再試行、取得直後のプロセス終了、UID変更、アカウント障害分離、期限/UTF-8バイト上限、出力上限、state保護を確認する。この検証は本番botの登録・稼働や実IMAPサーバーでの成功を証明しない。

`node scripts/himalaya-readonly-live-check.mjs` は、利用者が実アカウント検証を明示的に依頼したときだけ実行する。このMacの既存設定・Keychain認証を使って30分/6時間の一覧と5件単位のmonitor継続、別Nodeプロセスでのpending再取得、ack再試行、増分ラウンドを確認する。出力は件数・範囲・完了状態だけで、本文・件名・差出人・UIDを出さない。monitor stateは専用の一時0700ディレクトリにmetadataだけ作成し、終了時にその検証用ディレクトリだけを削除する。本番monitor進捗やbotは変更しない。`--binary PATH` は未インストールの検証ビルドを指定する場合に使用できる。新しいメールの到着自体や通知配信の成功はこの検査で保証しない。

2026-10-18、利用者の依頼で既存4アカウントを実機検証した。ラッパー経由の30分分/6時間分は全アカウントcomplete=true。過大な100件×100ページ指定も50件×4ページに制限され、6時間分は初回18件・後の回で17件、約7〜12秒で取得完了した（各回のas_of/期間は異なる）。5件単位の7/1/1/8バッチで継続完了し、未ackの同一再取得・別Nodeプロセス再起動・ack再試行・次ラウンド増分を確認した。設定と本番monitor stateは変更せず、検証用metadataだけの一時stateを使用した。Astra独立レビューの指摘を修正し、32テスト・lint・形式検証に成功した。稼働中botの指示更新や通知配信の検証は行っていない。詳細は独自Forkの `cairn/spec/testing/inbox-scan.md` を参照。

2026-10-16 に、読み取りラッパー9テスト、独自Forkのセキュリティ17チェック・統合受信21チェック、スキル形式検証、変更スクリプトのlintに成功した。実バイナリと架空の2アカウントのMaildirで一覧・検索・本文・不完全な受信時刻の扱い・既読を変更しないことを確認した。

2026-10-17 に、実アプリの「メール管理人」がスキル0件の状態で通常の `account list` を実行し、標準設定が見つからず停止することを確認した。専用ラッパーの `accounts` は既存の非標準設定で3アカウントを確認できた。認証値・メール本文を表示せず、読み取りラッパー9テストと隔離サーバーの登録・再登録時の無変更を再検証した。その後、認証済みのアプリ設定画面から `himalaya-mail` コマンドを「メール管理人」に登録・有効化した。標準設定を探す代わりに専用ラッパーを使う案内も含む。実モデルが次の依頼でこのスキルを選ぶことまでは、実会話へのテスト送信で検証していない。

一時HOME・fake engineの使い捨てサーバーで登録APIと再実行時の無変更、プロンプト索引およびfake engineへ実際に渡されたスキル案内を確認した。これは実モデルがメール操作を選ぶことの検証ではない。既存のGmail設定では認証と5件のサマリー取得に成功し、本文・件名・差出人を検証出力へ出さず、走査上限によるcomplete=falseを維持した。
