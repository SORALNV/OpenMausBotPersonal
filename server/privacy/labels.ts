export const LABELS = {
  private_person: "人物", private_address: "住所", private_email: "メール", private_phone: "電話",
  account_number: "口座", secret: "秘密", private_url: "URL", private_date: "日付",
} as const;
export type PrivacyLabel = keyof typeof LABELS;
export interface ProtectedTerm { text: string; label: PrivacyLabel }
