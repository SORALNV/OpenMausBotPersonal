import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { approvalModeFor } from "../shared/approval-mode.ts";
import { ownerOrAdmin, type RequestAuth } from "./request-auth.ts";
import type { Message, Store } from "./store.ts";

const savedSchema = z.record(z.string().regex(/^[\w-]{1,128}$/u), z.enum(["ask", "full"]));
export type ConversationCommand = "/allow-all" | "/ask" | "/permissions";
export const conversationCommand = (text: string): ConversationCommand | undefined => {
  const line = text.trim();
  return line === "/allow-all" || line === "/ask" || line === "/permissions" ? line : undefined;
};
export type ConversationControl = {
  auth: RequestAuth; threadId: string; botId?: string; groupId?: string; text: string;
  sendId?: string; sender?: Message["sender"];
};
type ControlResult = { message: Message } | { status: number; error: string };

/** Owner-only conversation grants. No model/tool output reaches control(); existing Custom and host policy stay authoritative. */
export class ConversationPermissions {
  private saved: z.infer<typeof savedSchema> = {};
  private readonly deps: {
    file: string; store: Pick<Store, "bot" | "group" | "groupTaskByThread" | "taskByThread" | "projectBotForTask" | "patchTask" | "messagesFor" | "appendMessage">;
    hosted?: boolean; changed?(threadId: string): void;
  };
  constructor(deps: ConversationPermissions["deps"]) {
    this.deps = deps;
    if (existsSync(deps.file)) {
      if (!lstatSync(deps.file).isFile() || lstatSync(deps.file).isSymbolicLink()) throw Error("Invalid conversation permissions file");
      this.saved = savedSchema.parse(JSON.parse(readFileSync(deps.file, "utf8")));
    }
  }
  mode(threadId: string): "ask" | "full" | undefined { return this.saved[threadId]; }
  private save(threadId: string, mode: "ask" | "full") {
    const next = { ...this.saved, [threadId]: mode };
    mkdirSync(dirname(this.deps.file), { recursive: true, mode: 0o700 });
    const temp = `${this.deps.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      renameSync(temp, this.deps.file);
      this.saved = next;
    } finally { rmSync(temp, { force: true }); }
  }
  control(input: ConversationControl): ControlResult | undefined {
    const command = conversationCommand(input.text);
    if (!command) return undefined;
    if (!ownerOrAdmin(input.auth)) return { status: 403, error: "この設定は所有者の端末から変更してください。" };
    const { store } = this.deps;
    const group = input.groupId ? store.group(input.groupId) : undefined;
    const bot = input.botId ? store.projectBotForTask(input.botId, input.threadId) : undefined;
    if (input.groupId ? !group || (group.dm ? group.threadId !== input.threadId : !store.groupTaskByThread(group.id, input.threadId))
      : !bot || !store.taskByThread(bot.id, input.threadId)) return { status: 404, error: "対象の会話が見つかりません。" };
    if (input.sendId) {
      const prior = store.messagesFor(input.threadId).find(row => row.sendId === input.sendId);
      if (prior) return prior.text === input.text ? { message: prior } : { status: 409, error: "この送信IDは別の入力で使用済みです。" };
    }
    const current = group ? this.mode(input.threadId) : approvalModeFor(bot!);
    if (command !== "/permissions") {
      const mode = command === "/allow-all" ? "full" : "ask";
      if (mode === "full" && this.deps.hosted) return { status: 403, error: "共有サーバーの全許可は管理ポリシーから設定してください。" };
      const members = group ? group.memberIds.map(id => store.bot(id)).filter(member => member !== undefined && member !== null) : [bot!];
      if ((!group || mode === "full") && members.some(member => member.approvalGrant || approvalModeFor(member) === "custom")) {
        return { status: 403, error: "Customの権限変更はPersonalアプリの設定から行ってください。" };
      }
      this.save(input.threadId, mode);
      if (bot) store.patchTask(bot.id, input.threadId, { approvalMode: mode, autoApprove: false, alwaysAllow: [] });
    }
    const message = store.appendMessage(input.threadId, { role: "user", kind: "text", text: input.text, sendId: input.sendId, sender: input.sender });
    const mode = command === "/permissions" ? current : command === "/allow-all" ? "full" : "ask";
    store.appendMessage(input.threadId, { role: "bot", kind: "text", text: command === "/permissions"
      ? `この会話の許可設定：${mode === "full" ? "すべて許可" : mode === "ask" ? "操作ごとに確認" : "Botごとの設定"}。\n/allow-all：この会話ですべて許可\n/ask：確認に戻す\n他の会話の設定は変更しません。`
      : mode === "full" ? "この会話を「すべて許可」にしました。ALLでは、この会話で動く各Botに適用します。次の操作から適用し、/askで解除できます。質問・認証・OSの許可・禁止操作の確認は残ります。"
        : "この会話を「操作ごとに確認」に戻しました。既に実行した操作は取り消されません。" });
    if (command !== "/permissions") this.deps.changed?.(input.threadId);
    return { message };
  }
}
