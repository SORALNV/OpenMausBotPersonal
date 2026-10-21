import type { PersonalPrivacySettings, PrivacySource } from "../../shared/personal-privacy.ts";
import type { RouteHandler } from "../routes/table.ts";
import { PASS } from "../routes/table.ts";
import { LocalDetector, type Detector } from "./detector.ts";
import { PrivacyGuard } from "./guard.ts";
import { PrivacyVault } from "./vault.ts";
import { PrivacySettingsStore } from "./settings.ts";
import { mapPrivacyStrings, prepareAliases } from "./aliases.ts";
import { PrivacyBlocked } from "./policy.ts";
import { wrapPrivacyIntegrations } from "./integrations.ts";
import type { SendTurnInput } from "../contracts.ts";
import { ChatDiagnostics, ChatFailure, chatDeadline } from "../google-chat-diagnostics.ts";

type Run = { routineId: string; status: string; runOn?: string; target?: string };
export class PersonalPrivacyService {
  protectThread: (thread: string) => boolean = () => false;
  chatDiagnostics?: ChatDiagnostics;
  private store?: PrivacySettingsStore;
  private protection?: PrivacyGuard;
  private readonly detector: Detector;
  private warming?: Promise<void>;
  private state: "off" | "loading" | "ready" | "error" = "off";
  private readonly dir: string;
  private readonly run: (thread: string) => Run | null;
  constructor(dir: string, run: (thread: string) => Run | null, detector: Detector = new LocalDetector()) { this.dir = dir; this.run = run; this.detector = detector; }
  get settings(): PersonalPrivacySettings { return (this.store ??= new PrivacySettingsStore(this.dir)).read(); }
  get guard(): PrivacyGuard { return this.protection ??= new PrivacyGuard(new PrivacyVault(this.dir), this.detector); }
  selected(thread: string, settings?: PersonalPrivacySettings): boolean {
    if (this.protectThread(thread)) return true;
    return this.routineSelected(thread, settings);
  }
  private routineSelected(thread: string, settings?: PersonalPrivacySettings): boolean {
    const run = this.run(thread);
    if (!run || !["running", "waiting"].includes(run.status) || run.runOn === "cloud" || run.target === "room-goal") return false;
    const s = settings ?? this.settings;
    return s.enabled && (s.allRoutines || s.routineIds.includes(run.routineId));
  }
  start(): void {
    if (process.env.OMB_PERSONAL_BUILD !== "1") return;
    try { if (this.settings.enabled || this.settings.toolFiltering) void this.warm().catch(() => {}); } catch { this.state = "error"; }
  }
  private detectionState(state: "ready" | "error"): void { this.state = this.settings.modelDetectionEnabled === false ? "off" : state; }
  private warm(): Promise<void> {
    if (this.settings.modelDetectionEnabled === false) { this.state = "off"; return Promise.resolve(); }
    if (this.warming) return this.warming;
    this.state = "loading";
    this.warming = this.detector.detect([""]).then(() => { this.detectionState("ready"); }, () => { this.detectionState("error"); throw new PrivacyBlocked(); }).finally(() => { this.warming = undefined; });
    return this.warming;
  }
  async mask(scope: string, value: unknown, names: string[] = [], options: { batchTextInputs?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.settings.modelDetectionEnabled === false) return this.literals(scope, value);
    const configured = prepareAliases(scope, this.settings.aliases, this.guard.vault);
    const input = mapPrivacyStrings(value, text => configured.prepare(text));
    try {
      const result = await this.guard.protect(scope, input, options.signal, names.map(text => ({ text, label: "private_person" })), options);
      this.detectionState("ready");
      return mapPrivacyStrings(result, text => configured.finish(text));
    } catch { this.detectionState("error"); throw new PrivacyBlocked("Mac内のフィルターに失敗したため、この取得結果はAIに渡していません。再実行・送信の前に設定を確認してください。"); }
  }
  display(scope: string, text: string): string { return this.guard.vault.restoreForDisplay(scope, text); }
  literals(scope: string, value: unknown): unknown {
    const configured = prepareAliases(scope, this.settings.aliases, this.guard.vault);
    const prepared = mapPrivacyStrings(value, text => configured.prepare(text));
    this.guard.vault.commit();
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
        const settings = (this.store ??= new PrivacySettingsStore(this.dir)).save(await readBody(req, 2_000_000));
        if (settings.modelDetectionEnabled === false) { this.detector.close(); this.state = "off"; }
        else if (settings.enabled || settings.toolFiltering) void this.warm().catch(() => {});
        else this.state = "off";
      }
      return json(res, 200, { settings: this.settings, state: this.state });
    } catch (error) { return json(res, 400, { error: error instanceof PrivacyBlocked ? error.message : "保護設定を保存できません。" }); }
  };
  internalRoute(thread: string, assertActive: () => void): RouteHandler {
    return async ({ req, res, path, method, readBody, json }) => {
      if (!["/api/internal/privacy-filter", "/api/internal/google-chat-diagnostics"].includes(path) || method !== "POST") return PASS;
      res.setHeader("cache-control", "no-store");
      if (process.env.OMB_PERSONAL_BUILD !== "1") return json(res, 404, { error: "Personal版専用です。" });
      assertActive();
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
        if (!["custom", "browser", "composio", "data"].includes(body?.source)) throw new PrivacyBlocked();
        const selected = this.protectThread(thread) || this.selected(thread, settings) && settings.sources.includes(body.source as PrivacySource);
        if (body.model !== undefined && typeof body.model !== "boolean") throw new PrivacyBlocked();
        if (body.model === true && !selected && !settings.toolFiltering) throw new PrivacyBlocked();
        if (!selected && body.model !== true) {
          const value = settings.toolFiltering ? this.literals(thread, body.value) : body.value;
          assertActive();
          return json(res, 200, { value });
        }
        if (diagnostic) this.chatDiagnostics?.stage(diagnostic, "mask");
        const value = await chatDeadline(120000, undefined, signal => this.filterToolResult(thread, body.value, signal), "MASK_TIMEOUT");
        assertActive();
        if (diagnostic) this.chatDiagnostics?.end(diagnostic);
        return json(res, 200, { value });
      } catch (error) {
        const code = error instanceof ChatFailure ? error.code : "MASK_FAILED";
        if (diagnostic) this.chatDiagnostics?.end(diagnostic, code);
        return json(res, 503, { code, error: "自動マスクに失敗・未対応のため取得結果をAIに渡しません。原文への代替送信は行いません。" });
      }
    };
  }
  close(): void { this.detector.close(); }
  async filterToolResult(thread: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.settings.modelDetectionEnabled === false) return this.literals(thread, value);
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
    const strings: string[] = [];
    mapPrivacyStrings(input, text => { strings.push(text); return text; });
    const protectedStrings = await this.mask(thread, strings, [], { batchTextInputs: true, signal }) as string[];
    let index = 0;
    const output = mapPrivacyStrings(input, () => protectedStrings[index++]) as typeof result;
    if (mirrored.length) {
      if (!output?.structuredContent || !Object.hasOwn(output.structuredContent, "result") || !Array.isArray(output.content)) throw new ChatFailure("BODY_INVALID");
      const text = JSON.stringify(output.structuredContent.result);
      for (const index of mirrored) {
        if (output.content[index]?.type !== "text" || output.content[index].text !== "") throw new ChatFailure("BODY_INVALID");
        output.content[index].text = text;
      }
    }
    return output;
  }
}
