import { serverLine } from "./server-lines.ts";

const reason: Record<string, string> = { FEED_TIMEOUT: "監視サーバーの応答期限超過", FEED_CONNECTION: "監視サーバーとの通信失敗", FEED_AUTH: "ローカル接続認証の失敗", FEED_HTTP: "監視サーバーのHTTPエラー", FEED_INVALID: "差分データの解析失敗", MASK_TIMEOUT: "ローカルマスクの期限超過", MASK_FAILED: "ローカルマスク失敗", CONTEXT_TIMEOUT: "スレッド確認の期限超過", CONTEXT_FAILED: "スレッドを確認できません", CLASSIFIER_TIMEOUT: "通知判定の期限超過", CLASSIFIER_FAILED: "通知判定に失敗しました。該当投稿は未処理のまま保持しています", QUEUE_FAILED: "通知処理の保存に失敗しました。該当投稿は未処理のまま保持しています", COLLECTOR_STALE: "管理ブラウザの収集更新が途絶えています", BROWSER_OFFLINE: "管理ブラウザが停止しています", LOGIN_REQUIRED: "大学アカウントの再ログインが必要です", CURSOR_RESET: "受信位置の再接続確認が必要です" };

export function googleChatMonitorLine(language: string | undefined, status: string): string {
  return status === "OK" ? serverLine(language, "server.personal.googleChat.recovered")
    : serverLine(language, "server.personal.googleChat.attention", { reason: language?.split(/[-_]/)[0] === "ja" ? reason[status] ?? status : status });
}
