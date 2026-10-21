export interface DirectThreadBinding {
  botId: string;
  threadId: string;
  codexThreadId: string;
  hostId: string;
}

export interface ReplyFormatterSelection {
  providerId: string;
  modelId: string;
  timeoutMs: number;
}

/** Personal-only mapping; IDs identify existing threads and never authorize creating or replacing one. */
export interface DirectCodexSettings {
  bindings: Array<DirectThreadBinding & { enabled: boolean; mediator?: ReplyFormatterSelection; formatter?: ReplyFormatterSelection; lastNativeTurnId?: string }>;
}

/** The native original is retained locally; the displayed short answer never becomes native conversation history. */
export interface DirectCodexMessage {
  threadId: string;
  turnId: string;
  itemId?: string;
  originalText?: string;
  formatted?: boolean;
  formatterFailure?: string;
}
