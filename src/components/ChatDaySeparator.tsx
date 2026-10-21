import { dayLabel } from "@/lib/transcript-derivations";
import { formatTime } from "@/state/store";

export function DaySeparator({ at, today }: { at: number; today: number }) {
  return (
    <div className="py-3 text-center text-[13px] text-ink-secondary">
      {dayLabel(at, today)} {formatTime(at)}
    </div>
  );
}

