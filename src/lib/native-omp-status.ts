import type { WireTask } from "../../shared/wire";

export function nativeOmpStatusLabel(status: WireTask["nativeOmpStatus"]): string | undefined {
  switch (status?.state) {
    case "reconnecting": return "Piへの接続を復旧中";
    case "disconnected": return "Piとの接続が切れています";
    case "native-queued": return "Pi側のキューで待機中";
    case "reconciling": return "Piの状態を照合中";
    case "waiting-on-you": return "Pi側の確認待ち";
    default: return undefined;
  }
}
