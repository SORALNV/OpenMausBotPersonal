import type { DirectThreadBinding, ReplyFormatterSelection } from "../shared/direct-codex.ts";
export type { DirectThreadBinding, ReplyFormatterSelection } from "../shared/direct-codex.ts";

export interface DirectTurnInput {
  requestId: string;
  text: string;
}

export interface DirectTurnReply {
  codexThreadId: string;
  turnId: string;
  text: string;
}

/** Implementations must submit a native user turn to the owning runtime, without injecting bot instructions or recreating a missing thread. */
export interface DirectThreadTransport {
  submit(binding: Readonly<DirectThreadBinding>, input: Readonly<DirectTurnInput>): Promise<DirectTurnReply>;
}

/** Formatting is a separate, tool-free request. Its output is presentation data and must never be submitted back to the native thread. */
export interface ReplyFormatter {
  format(input: {
    providerId: string;
    modelId: string;
    question: string;
    answer: string;
    signal: AbortSignal;
  }): Promise<string>;
}

export interface ReplyPresentation {
  text: string;
  formatted: boolean;
  failure?: "unavailable" | "timeout" | "invalid" | "failed";
}

function sourceKey(botId: string, threadId: string): string {
  return JSON.stringify([botId, threadId]);
}

export function presentDirectReply(
  question: string,
  answer: string,
  formatter: ReplyFormatter | undefined,
  selection: Readonly<ReplyFormatterSelection> | undefined,
): Promise<ReplyPresentation> {
  if (!selection) return Promise.resolve({ text: answer, formatted: false });
  if (!formatter) return Promise.resolve({ text: answer, formatted: false, failure: "unavailable" });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<ReplyPresentation>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ text: answer, formatted: false, failure: "timeout" });
    }, selection.timeoutMs);
  });
  const formatted = Promise.resolve().then(() => formatter.format({
    providerId: selection.providerId, modelId: selection.modelId,
    question, answer, signal: controller.signal,
  })).then((text): ReplyPresentation => typeof text === "string" && text.trim()
    ? { text, formatted: true }
    : { text: answer, formatted: false, failure: "invalid" },
  (): ReplyPresentation => ({ text: answer, formatted: false, failure: "failed" }));
  return Promise.race([deadline, formatted]).finally(() => clearTimeout(timer));
}

/** A bridge instance has immutable source-to-native bindings. Transport errors propagate without retrying or selecting another runtime. */
export class DirectThreadBridge {
  private readonly bindings = new Map<string, Readonly<DirectThreadBinding>>();
  private readonly targets = new Map<string, Promise<void>>();
  private readonly transport: DirectThreadTransport;
  private readonly formatter: ReplyFormatter | undefined;

  constructor(bindings: readonly DirectThreadBinding[], transport: DirectThreadTransport, formatter?: ReplyFormatter) {
    this.transport = transport;
    this.formatter = formatter;
    for (const binding of bindings) {
      if ([binding.botId, binding.threadId, binding.codexThreadId, binding.hostId].some(value => !value.trim())) {
        throw new Error("A direct thread binding requires explicit source, host and native thread IDs.");
      }
      const key = sourceKey(binding.botId, binding.threadId);
      if (this.bindings.has(key)) throw new Error("A source thread has more than one native binding.");
      this.bindings.set(key, Object.freeze({ ...binding }));
    }
  }

  async send(botId: string, threadId: string, input: DirectTurnInput, selection?: ReplyFormatterSelection): Promise<{
    binding: Readonly<DirectThreadBinding>;
    requestId: string;
    turnId: string;
    rawText: string;
    presentation: Promise<ReplyPresentation>;
  }> {
    const binding = this.bindings.get(sourceKey(botId, threadId));
    if (!binding) throw new Error("No native thread is bound to this source thread.");
    if (!input.requestId.trim()) throw new Error("A direct turn requires a request ID.");
    if (selection && (!selection.providerId.trim() || !selection.modelId.trim()
      || !Number.isInteger(selection.timeoutMs) || selection.timeoutMs < 1 || selection.timeoutMs > 60_000)) {
      throw new Error("Invalid reply formatter selection.");
    }
    const turnInput = Object.freeze({ ...input });
    const formatterSelection = selection && Object.freeze({ ...selection });
    const targetKey = sourceKey(binding.hostId, binding.codexThreadId);
    const previous = this.targets.get(targetKey) ?? Promise.resolve();
    const pending = previous.then(() => this.transport.submit(binding, turnInput));
    const settled = pending.then(() => {}, () => {});
    this.targets.set(targetKey, settled);
    void settled.then(() => { if (this.targets.get(targetKey) === settled) this.targets.delete(targetKey); });
    const reply = await pending;
    if (reply.codexThreadId !== binding.codexThreadId) throw new Error("The native reply belongs to a different thread.");
    return {
      binding, requestId: turnInput.requestId, turnId: reply.turnId, rawText: reply.text,
      presentation: presentDirectReply(turnInput.text, reply.text, this.formatter, formatterSelection),
    };
  }
}
