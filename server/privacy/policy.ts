export class PrivacyBlocked extends Error {
  constructor(reason = "ローカル保護層で送信を停止しました。") {
    super(reason);
    this.name = "PrivacyBlocked";
  }
}

export function assertPrivacyMode(): void {
  if (process.env.OMB_PRIVACY_MODE && process.env.OMB_PRIVACY_MODE !== "off") {
    throw new PrivacyBlocked("モデルによる検出機能は削除済みです。旧保護モードでは起動できません。登録語句の置換設定を使用してください。");
  }
}
