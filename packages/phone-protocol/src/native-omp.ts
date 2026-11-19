import type { ReplyFormatterSelection } from "./direct-codex.ts";

/** Owner-selected Pi destination. Each existing Bot thread receives its own persistent remote conversation. */
export interface NativeOmpBinding {
  botId: string;
  enabled: boolean;
  host: string;
  user: string;
  binary: string;
  stateRoot: string;
  profile: string;
  cwd: string;
  model: string;
  /** shared-tui attaches to the standard native TUI; no second session writer is started. */
  connection?: "shared-tui" | "shared-web";
  /** deepseek uses the unmodified DSH Web operator interface over SSH. */
  harness?: "deepseek";
  /** mediator asks the owner only for concrete high-risk findings; classifier failures retry without creating approval cards. */
  approvalPolicy?: "human" | "mediator";
  /** Enable OhMyPi's native passive advisor for a managed standard TUI, using the configured worker model. */
  advisor?: boolean;
  mediator: ReplyFormatterSelection;
  formatter?: ReplyFormatterSelection;
}

/** Original native answer is retained locally; formatted display text never returns to the native session. */
export interface NativeOmpMessage {
  sessionId: string;
  requestId: string;
  originalText: string;
  formatted?: boolean;
  formatterFailure?: string;
  entryId?: string;
  source?: "human" | "bot";
  sharedTurn?: boolean;
  /** Per-project originals are retained even when the combined chat answer is shortened. */
  projects?: { project: string; sessionId: string; requestId: string; text: string; sharedTurn?: boolean }[];
}

/** Native profile metadata only; filenames are resolved by the connector, never chosen by a model. */
export interface NativeOmpSessionInfo {
  id: string;
  name: string;
  directory: string;
  file?: string;
  cwd?: string;
  running: boolean;
  shared: boolean;
  busy?: boolean;
}

/** Management conversations keep their own native history and may manage other sessions without merging their histories. */
export interface NativeOmpThreadTarget {
  kind: "manager" | "session";
  session: NativeOmpSessionInfo;
}

/** Owner-curated project aliases refer to catalogued sessions, preserving their native IDs and histories. */
export interface NativeOmpProject {
  name: string;
  sessionId: string;
  description: string;
}
