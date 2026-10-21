# Xの本人スレッド取得

`skills/x-thread-reader` は既存のComputer UseでChromeのUse AIプロファイルを読むスキル。Xの公式API・内部GraphQL・認証データ抽出・新しいブラウザ拡張は使わない。投稿URLで自動選択され、通常は本人の返信・本人の関連引用・埋め込まれた引用元が対象。他人の返信と他人による引用は別々に明示依頼が必要。

`scripts/x-post-result.mjs` は画面で取得したJSONのオフライン整形器。URL・同じ作者・会話スコープ・重複・サイズを検証し、第三者本文は既定で除外する。ブラウザから自動収集するエンジンでも、モデルの全操作を強制的に制限するゲートでもない。表示された文脈と関係性の確認はComputer Useを行うエージェントの責任。常にpartial coverageを返し、未表示投稿の全件取得を主張しない。

```sh
node --test scripts/x-post-result.node-test.mjs
pnpm exec vitest run server/x-thread-reader.test.ts server/skill-library.test.ts
```

必ず `scripts/control-omb.ts launch` の使い捨てfixtureを起動する。X URLだけを渡し、fake engineのdumpのsystemPromptに本スキルが含まれることを確認する。実ユーザーのブラウザや認証情報をfixtureへ持ち込まない。fake engineは実際にXを読まない。

実ブラウザでは、依頼された公開投稿URLをUse AI（X @use_ai84242）で読み、連投の先頭・末尾・投稿者と件数、本文保存、本人以外の除外、引用元と他人による引用の区別を確認する。取得確認は投稿・返信作成・いいねなどを行わず、既存の承認・Privacy Filter設定を変更しない。

PersonalはDATA_DIR/skillsも毎ターン読み込むため、本スキルの専用ディレクトリをそこに追加すればアプリの置き換え・再起動は不要。既存ディレクトリがあるときは上書きせず差分を確認する。OFFは当該ディレクトリのmanifest.jsonのdefaultEnabledをfalseにする。これはスキルの起動設定でありX側の設定ではない。

適用先は通常のOMBハーネスで実行するBotのターン。M1MacControlやPiの既存セッションへ入力をそのまま流すNativeConectは、通常Botのスキル自動選択を通らないため、この追加だけで同じ機能が使えるとは扱わない。リモート側やComputerツールのないBotではローカルChromeを操作できない。
