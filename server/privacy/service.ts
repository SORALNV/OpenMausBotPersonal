import type { PersonalPrivacySettings, PrivacySource } from "../../shared/personal-privacy.ts";
import type { RouteHandler } from "../routes/table.ts";
import { PASS } from "../routes/table.ts";
import { PrivacyVault } from "./vault.ts";
import { PrivacySettingsStore } from "./settings.ts";
import { mapPrivacyStrings, prepareAliases } from "./aliases.ts";
import { PrivacyBlocked } from "./policy.ts";
import { wrapPrivacyIntegrations } from "./integrations.ts";
import type { SendTurnInput } from "../contracts.ts";
import { ChatDiagnostics, ChatFailure } from "../google-chat-diagnostics.ts";

type Run = { routineId: string; status: string; runOn?: string; target?: string };
export class PersonalPrivacyService {
  protectThread: (thread: string) => boolean = () => false;
  chatDiagnostics?: ChatDiagnostics;
  private store?: PrivacySettingsStore;
  private vault?: PrivacyVault;
  private readonly dir: string;
  private readonly run: (thread: string) => Run | null;
  constructor(dir: string, run: (thread: string) => Run | null) { this.dir = dir; this.run = run; }
  get settings(): PersonalPrivacySettings { return (this.store ??= new PrivacySettingsStore(this.dir)).read(); }
  private get mapping(): PrivacyVault { return this.vault ??= new PrivacyVault(this.dir); }
  selected(thread: string, settings?: PersonalPrivacySettings): boolean {
    return this.protectThread(thread) || this.routineSelected(thread, settings);
  }
  private routineSelected(thread: string, settings?: PersonalPrivacySettings): boolean {
    const run = this.run(thread);
    if (!run || !["running", "waiting"].includes(run.status) || run.runOn === "cloud" || run.target === "room-goal") return false;
    const s = settings ?? this.settings;
    return s.enabled && (s.allRoutines || s.routineIds.includes(run.routineId));
  }
  start(): void {
    if (process.env.OMB_PERSONAL_BUILD === "1") (this.store ??= new PrivacySettingsStore(this.dir)).retireModelSetting();
  }
  async mask(scope: string, value: unknown, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    options.signal?.throwIfAborted();
    const result = this.literals(scope, value);
    options.signal?.throwIfAborted();
    return result;
  }
  display(scope: string, text: string): string { return this.mapping.restoreForDisplay(scope, text); }
  literals(scope: string, value: unknown): unknown {
    const configured = prepareAliases(scope, this.settings.aliases, this.mapping);
    const prepared = mapPrivacyStrings(value, text => configured.prepare(text));
    this.mapping.commit();
    return mapPrivacyStrings(prepared, text => configured.finish(text));
  }
  async prompt(thread: string, text: string): Promise<string> {
    return process.env.OMB_PERSONAL_BUILD === "1" && this.routineSelected(thread) ? await this.mask(thread, text) as string : text;
  }
  wrap(thread: string, integrations: SendTurnInput["integrations"]): SendTurnInput["integrations"] {
    if (process.env.OMB_PERSONAL_BUILD !== "1") return integrations;
    const settings = this.settings;
    if (!this.selected(thread, settings) && !settings.toolFiltering) return integrations;
    return wrapPrivacyIntegrations(integrations, this.selected(thread, settings) ? this.protectThread(thread) ? ["custom", "browser", "composio", "data"] : settings.sources : [], settings.toolFiltering);
  }
  settingsRoute: RouteHandler = async ({ req, res, path, method, auth, readBody, json }) => {
    if (path !== "/api/privacy/settings" || !["GET", "PUT"].includes(method)) return PASS;
    res.setHeader("cache-control", "no-store");
    if (process.env.OMB_PERSONAL_BUILD !== "1") return json(res, 404, { error: "Personal版専用です。" });
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "所有者の設定権限が必要です。" });
    try {
      if (method === "PUT") {
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSONが必要です。" });
        (this.store ??= new PrivacySettingsStore(this.dir)).save(await readBody(req, 2_000_000));
      }
      return json(res, 200, { settings: this.settings, mode: "registered-words" });
    } catch (error) { return json(res, 400, { error: error instanceof PrivacyBlocked ? error.message : "置換設定を保存できません。" }); }
  };
  internalRoute(thread: string, assertActive: () => void): RouteHandler {
    return async ({ req, res, path, method, readBody, json }) => {
      if (!["/api/internal/registered-words", "/api/internal/privacy-filter", "/api/internal/google-chat-diagnostics"].includes(path) || method !== "POST") return PASS;
      res.setHeader("cache-control", "no-store");
      if (process.env.OMB_PERSONAL_BUILD !== "1") return json(res, 404, { error: "Personal版専用です。" });
      assertActive();
      if (path === "/api/internal/privacy-filter") return json(res, 410, { code: "MODEL_FILTER_REMOVED", error: "モデルによる検出機能は削除済みです。登録語句の置換のみ利用できます。" });
      const body = await readBody(req, 2_000_000);
      if (path.endsWith("/google-chat-diagnostics")) {
        if (!this.protectThread(thread) || !this.chatDiagnostics || !/^[a-f0-9-]{36}$/.test(body?.id ?? "")) return json(res, 400, { error: "Invalid diagnostic event" });
        if (body.phase === "start") this.chatDiagnostics.begin("body", "upstream", body.id);
        else if (body.phase === "upstream_complete") this.chatDiagnostics.stage(body.id, "parse");
        else if (["UPSTREAM_TIMEOUT", "UPSTREAM_FAILED", "MASK_TIMEOUT", "MASK_FAILED", "BODY_INVALID"].includes(body.phase)) this.chatDiagnostics.end(body.id, body.phase);
        else return json(res, 400, { error: "Invalid diagnostic event" });
        return json(res, 200, { ok: true });
      }
      const diagnostic = this.protectThread(thread) && /^[a-f0-9-]{36}$/.test(body?.chatDiagnosticId ?? "") ? body.chatDiagnosticId as string : undefined;
      try {
        const settings = this.settings;
        if (!["custom", "browser", "composio", "data"].includes(body?.source) || body.model !== undefined) throw new PrivacyBlocked();
        const selected = this.protectThread(thread) || this.selected(thread, settings) && settings.sources.includes(body.source as PrivacySource);
        if (diagnostic) this.chatDiagnostics?.stage(diagnostic, "mask");
        const value = selected || settings.toolFiltering ? await this.filterToolResult(thread, body.value) : body.value;
        assertActive();
        if (diagnostic) this.chatDiagnostics?.end(diagnostic);
        return json(res, 200, { value });
      } catch (error) {
        const code = error instanceof ChatFailure ? error.code : "MASK_FAILED";
        if (diagnostic) this.chatDiagnostics?.end(diagnostic, code);
        return json(res, 503, { code, error: "登録語句の置換に失敗・未対応のため取得結果をAIに渡しません。原文への代替送信は行いません。" });
      }
    };
  }
  async filterToolResult(thread: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
    const check = (item: unknown, depth = 0): void => {
      if (depth > 32) throw new ChatFailure("BODY_INVALID");
      if (item && typeof item === "object") {
        if (["image", "audio", "resource", "resource_link", "video"].includes(String((item as { type?: unknown }).type))) throw new ChatFailure("BODY_INVALID");
        for (const child of Object.values(item)) check(child, depth + 1);
      }
    };
    check(value);
    const result = value as { content?: { type?: string; text?: string }[]; structuredContent?: { result?: unknown } } | null;
    const mirror = result?.structuredContent?.result;
    const mirrored = mirror !== undefined && Array.isArray(result?.content)
      ? result.content.flatMap((block, index) => block.type === "text" && block.text === JSON.stringify(mirror) ? [index] : []) : [];
    const input = mirrored.length ? { ...result, content: result!.content!.map((block, index) => mirrored.includes(index) ? { ...block, text: "" } : block) } : value;
    const output = await this.mask(thread, input, { signal }) as typeof result;
    if (mirrored.length) {
      const text = JSON.stringify(output!.structuredContent!.result);
      for (const index of mirrored) output!.content![index].text = text;
    }
    return output;
  }
}
