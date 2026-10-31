import { z } from "zod";
import { canAccessTeam, peerAllowed } from "../peer-roster.ts";
import type { BotRecord, TaskRecord } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ThreadWaitSnapshot {
  token: string;
  kind: "input" | "teammates" | "computer";
}

export interface AssignmentWaitSnapshot extends ThreadWaitSnapshot {
  waitId: string;
  botId: string;
  threadId: string;
  groupId: string;
  title: string;
  summary?: string;
  requesterBotId?: string;
  requesterThreadId?: string;
}

/** Dispatch only behind the calling turn's internal capability gate. Cancellation never answers an approval. */
export function createInternalThreadWaitRoutes(deps: {
  caller(): BotRecord | null;
  callerThreadId: string;
  bots(): readonly BotRecord[];
  tasks(botId: string): readonly TaskRecord[];
  snapshot(botId: string, threadId: string): ThreadWaitSnapshot | null;
  assignments?(): AssignmentWaitSnapshot[];
  clearAssignment?(waitId: string, reason: string): boolean;
  clear(botId: string, threadId: string, reason: string): Promise<{ teammatesLeftRunning: number }>;
  audit(botId: string, threadId: string, reason: string, groupId?: string): void;
  requireActive(): void;
  readBody(): Promise<unknown>;
}): RouteHandler {
  return async ({ path, method, res, json }) => {
    if (path !== "/api/internal/thread-waits" || method !== "POST") return PASS;
    const input = z.discriminatedUnion("action", [
      z.object({ action: z.literal("list"), toBotId: z.string().min(1).optional(), fromBotId: z.string().optional(), fromThreadId: z.string().optional() }).strict(),
      z.object({ action: z.literal("clear"), toBotId: z.string().min(1), toThreadId: z.string().min(1), waitId: z.string().min(1).optional(), expectedToken: z.string().min(1), reason: z.string().trim().min(1).max(500), fromBotId: z.string().optional(), fromThreadId: z.string().optional() }).strict(),
    ]).safeParse(await deps.readBody());
    deps.requireActive();
    const chief = deps.caller();
    if (!chief?.chiefOfStaff || chief.hidden) return json(res, 403, { error: "Chief権限が必要です。" });
    if (!input.success) return json(res, 400, { error: "一覧取得、または対象Bot・スレッド・最新の待機トークン・解除理由を指定してください。" });
    const body = input.data;
    const reachable = deps.bots().filter(bot => !bot.hidden && canAccessTeam(chief, bot.section) && (bot.id === chief.id || peerAllowed(chief, bot)));
    const assignments = () => (deps.assignments?.() ?? []).filter(wait => reachable.some(bot => bot.id === wait.botId));
    if (body.toBotId && !reachable.some(bot => bot.id === body.toBotId)) return json(res, 403, { error: "このChiefが管理できるBotを指定してください。" });
    if (body.action === "list") {
      const waits = reachable.filter(bot => !body.toBotId || bot.id === body.toBotId).flatMap(bot => deps.tasks(bot.id).flatMap(task => {
        if (task.threadId === deps.callerThreadId) return [];
        const wait = deps.snapshot(bot.id, task.threadId);
        return wait ? [{ botId: bot.id, botName: bot.name, threadId: task.threadId, title: task.title, ...wait }] : [];
      }));
      return json(res, 200, { waits: [...waits, ...assignments().filter(wait => !body.toBotId || (wait.botId === body.toBotId || wait.requesterBotId === body.toBotId)).map(wait => ({ ...wait, botName: reachable.find(bot => bot.id === wait.botId)!.name }))] });
    }
    if (body.waitId) {
      const current = assignments().find(wait => wait.waitId === body.waitId && wait.botId === body.toBotId && wait.threadId === body.toThreadId);
      if (!current || current.token !== body.expectedToken || !deps.clearAssignment?.(body.waitId, body.reason)) return json(res, 409, { error: "依頼の待機状態が変わりました。一覧を取り直してください。" });
      deps.audit(body.toBotId, body.toThreadId, body.reason, current.groupId);
      return json(res, 200, { cleared: true, teammatesLeftRunning: 0, message: "指定した依頼の待機を取り消しました。グループの別作業や承認には触れていません。依頼元には取消結果が返ります。" });
    }
    if (body.toThreadId === deps.callerThreadId) return json(res, 409, { error: "この操作を実行中の会話自身は解除できません。" });
    if (!deps.tasks(body.toBotId).some(task => task.threadId === body.toThreadId)) return json(res, 404, { error: "対象Botのスレッドが見つかりません。" });
    const current = deps.snapshot(body.toBotId, body.toThreadId);
    if (!current) return json(res, 409, { error: "待機状態ではありません。実行中の作業は停止していません。" });
    if (current.token !== body.expectedToken) return json(res, 409, { error: "待機状態が変わりました。一覧を取り直してください。" });
    const result = await deps.clear(body.toBotId, body.toThreadId, body.reason);
    deps.audit(body.toBotId, body.toThreadId, body.reason);
    return json(res, 200, { cleared: true, ...result, message: "待機を取り消しました。承認やログインの代行、作業の完了扱い、履歴の削除は行っていません。" });
  };
}
