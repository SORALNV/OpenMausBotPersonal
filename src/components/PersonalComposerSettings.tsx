import { COMPOSER_CHORDS, setComposerBinding, useComposerKeymap, type ComposerAction } from "@/lib/composer-keymap";
import { sendKeyLabel } from "@/lib/send-key";

export function PersonalComposerSettings() {
  const keys = useComposerKeymap();
  const rows: { action: ComposerAction; label: string }[] = [{ action: "queue", label: "送信・キューに追加" }, { action: "steer", label: "実行中に差し込む" }, { action: "newline", label: "改行" }];
  return <section aria-label="送信キーの設定" className="space-y-3">
    <h3 className="text-sm font-medium">送信・差し込み・改行のキー</h3>
    <p className="text-xs text-ink-secondary">この端末の設定です。キーが重なる場合は入れ替えます。日本語変換の確定では送信しません。差し込みは対応する接続方式で使えます。</p>
    {rows.map(({ action, label }) => <label key={action} className="flex items-center justify-between gap-3 text-sm">{label}<select aria-label={label} className="rounded-lg border border-hairline bg-inset p-2" value={keys[action]} onChange={event => setComposerBinding(action, event.target.value as typeof COMPOSER_CHORDS[number])}>{COMPOSER_CHORDS.map(chord => <option key={chord} value={chord}>{sendKeyLabel(chord)}</option>)}</select></label>)}
  </section>;
}
