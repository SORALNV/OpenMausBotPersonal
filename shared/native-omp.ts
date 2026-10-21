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
  connection?: "shared-tui";
  /** mediator reviews bounded low-risk native requests; important, unknown or failed reviews still require the owner's Allow. */
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
}
