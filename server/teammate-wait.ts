export function teammateWaitMessage(name: string, question: string): string {
  const login = /^Waiting on the person: sign in to ([\w.-]+)$/iu.exec(question.trim());
  const reason = login ? `${login[1]}へのログインが必要です。` : question.trim().slice(0, 500);
  return `${name}への依頼は、本人の確認待ちで停止しています。${reason}\n依頼先の会話で確認して続行できます。取り消す場合は、このチャットの停止ボタンで待機を終了できます。`;
}
