# BotごとのMCP権限と管理Botへの委任

アプリ → MCP → 対象サーバーの「Bot別権限・Managerへの委任」で、本人がツールの上限、配布を任せるBot、配布対象のBot、初期付与を選ぶ。現在はURL型MCPに対応する。初期付与はツールを個別に指定する。対象に選ぶだけでは付与しない。

管理Botは `manage_mcp_access` の `action: list` で委任範囲を調べ、`set` で対象Botの必要なツールだけに置き換え、`revoke` で解除する。上限外のツール、対象外Bot、管理者・接続先・認証・共通設定・承認モードは変更できない。管理者自身も、対象とツールを本人に指定されていなければ使用権限を持たない。本人がBot設定で除外したサーバーやツールを、管理Botが再び有効にすることはできない。

委任設定を保存したサーバーは、共通スイッチとは独立して配布される。共通スイッチがOFFでも付与先だけが使え、共通スイッチがONでも未付与Botには渡さない。停止しても一括配布へ自動復帰しない。登録済みサーバーの接続先や認証が変われば、本人による再設定まで委任は無効になる。

接続はBot・会話・実行世代に紐づく内部capabilityで認証する。上流トークンはサーバー内だけで扱い、モデルやMCP子プロセスには渡さない。ツール一覧と呼出しの両方で、現在の本人の上限・Botへの付与・Bot自身の除外設定を照合する。resourcesやpromptsなどの別経路は提供しない。実行終了・権限解除後の新しい呼出しは拒否する。受理済みの上流処理を取り消したことにはしない。

付与や解除は上限500件の履歴に記録する。設定画面の保存と管理Botの変更が競合した場合は、古い保存を409で拒否する。設定変更は新しいターンのツール一覧に反映され、解除は既存接続の次の呼出しにも適用される。

これはMCP経由の権限管理であり、シェル、ファイルアクセス、独自に設定済みの外部エージェント接続を制限するサンドボックスではない。

## 検証

- `node scripts/mcp-access-acceptance.mjs`
- `node_modules/.bin/vitest run server/mcp-access.test.ts src/components/McpAccessPanel.test.ts src/lib/mcp-servers.test.ts src/components/bot-settings/AccessSection.test.ts server/drivers/agents-call.test.ts server/drivers/agents-catalog-wire.test.ts`

HTTP検証は専用ホーム、デスクトップ所有者capability、架空のNAS、通常のBot実行経路を使う。管理ツールからの付与、付与Botの通常送信へのMCP組込み、一覧・読取、上流へ届く前の書込拒否、未付与Botの組込みなし、なりすまし・自己昇格・本人上限変更の拒否、即時解除、古い設定保存の拒否、認証値の非公開を確認する。実際のNASへ書き込んだり、ユーザーの会話へ検証入力を送ったりしない。

## macOSのLAN許可とビルドの識別

Personalと汎用Electronで同じMach-OのLC_UUIDが使われると、macOSがLAN許可を正しく対応付けられない場合がある。[Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)は、主実行ファイルのUUIDの欠落・他アプリとの重複が許可の誤動作につながるとしている。

Personalのパッケージ化では、元の実行ファイルUUIDとBundle IDからアプリ固有のUUIDを決め、署名前に設定する。通常のランチャーとRuntimeは別のUUIDを持ち、同じ元バイナリからの再パッケージ化では値を変えない。日本語のNSLocalNetworkUsageDescriptionも追加する。既存の署名証明書とキーチェーンを維持する。旧ランチャーからの初回移行だけは、バックアップ後にpersonal-install-runtime.mjsの--migrate-launcherを明示する。

この修正はOS許可を付与・リセットしない。アプリ固有の通常のLAN許可を本人が選ぶ。権限データベースの改変、ネットワーク全体の除外設定、別プロセスを通じた拒否の迂回は行わない。

検証: node --test scripts/personal-app-identity.node-test.mjs。変更範囲、再実行の安定性、Runtimeとの分離、不正なMach-OやUUIDの重複・欠落・不一致時の拒否を架空のバイナリで確認する。
