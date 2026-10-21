import { ArrowUp, Clock } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export function ComposerSendControls({ busy, canSteer, personal, pending, sendLabel, steerLabel, onSend }: {
  busy: boolean; canSteer: boolean; personal: boolean; pending: boolean; sendLabel: string; steerLabel: string;
  onSend(delivery?: "queue" | "steer"): void;
}) {
  const queued = busy && (!canSteer || personal);
  const label = busy ? queued ? t("composer.send.queue") : t("composer.send.steer") : t("composer.send.message");
  return <>
    <button type="button" onClick={() => onSend(personal ? "queue" : undefined)} disabled={pending} aria-label={label}
      title={`${busy ? label : t("chat.send")} (${sendLabel})`}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-white", queued ? "bg-raised text-ink-secondary hover:bg-raised-hover" : "bg-accent hover:brightness-110")}>
      {queued ? <Clock size={15} /> : <ArrowUp size={17} />}
    </button>
    {personal && busy && canSteer && <button type="button" disabled={pending} onClick={() => onSend("steer")} aria-label="実行中に差し込む" title={`実行中に差し込む (${steerLabel})`} className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink"><ArrowUp size={17} /></button>}
  </>;
}
