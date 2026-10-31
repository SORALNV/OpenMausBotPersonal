# 会話ごとの一括許可と待機先案内

所有者のPersonal端末か、admin権限でペアリングした端末から、次の単独メッセージを送る。

- `/allow-all`：現在の個別Bot会話、またはALLなどのグループ会話をFull accessにする。
- `/ask`：その会話をAskへ戻す。
- `/permissions`：設定値とコマンドを表示する。

コマンドはモデルに渡さずサーバーで処理し、入力と結果を履歴に残す。同じ送信IDは再適用しない。
グループの設定はそのスレッドの各発言Botに適用する。他のグループ・個別会話の権限は変更しない。
個別会話は通常の保存済みタスク権限を変更する。グループの指定値とNativeConnectへの明示的な許可は
`private/conversation-permissions.json`に保存する。読み取り確認のコマンドは許可を更新しない。

質問・秘密情報入力・OS権限・安全上の禁止操作を自動で回答する機能ではない。
既存のCustom権限や共有サーバーのFull accessポリシーを迂回しない。
通常のBotでは次の操作から適用する。OhMyPiの仲介モードは既に表示された操作確認も再評価し、
実行の開始・終了は既存の監査カードで表示する。人間が標準TUIから始めた別の作業に許可を貸さない。

実際に入力がキューへ入った場合だけ、元の会話へ日本語の案内と既存形式の`comm`／`threadRef`を記録する。
同じ処理に対する案内は重複させない。Personal以外の端末も通常の会話本文を受け取れる。
非公開のiPhoneアプリについて、リンクの表示・タップを実機で確認したとは扱わない。
開けないクライアント向けに、Threadsから選ぶ会話名も本文に記す。
Team Cloudの他人の私的会話を漏らさないため、待機先案内はTeam Cloudには追加しない。
上流の「別のグループ会話で作業中でも本人の個別会話を受け付ける」改善を維持する。

## 検証

通常のアプリや会話を使わず、一時HOME・一時DB・偽エンジンの隔離環境で行う。

```sh
pnpm exec vitest run server/conversation-permissions.test.ts server/wait-location-notice.test.ts server/room-turn-level.test.ts
pnpm build:server
node scripts/conversation-controls-acceptance.mjs dist-server/index.js
node scripts/chief-waits-acceptance.mjs dist-server/index.js
```

HTTP検証では通常のペアリング手順で一時端末を作り、その端末からコマンドを送る。
モデルを起動しない制御、重複抑止、他の会話の設定保持、ALLで実際にドライバーへ渡す権限、
キュー受理後の案内と会話リンク、別接続・再起動後の解除を確認する。
ログに認証トークン・実機の認証情報・実ファイル本文を出さない。
