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

type Run = { routineId: string; status: string; runOn?: string; target?: string };
export class PersonalPrivacyService {
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
    const run = this.run(thread);
    if (!run || !["running", "waiting"].includes(run.status) || run.runOn === "cloud" || run.target === "room-goal") return false;
    const s = settings ?? this.settings;
    return s.enabled && (s.allRoutines || s.routineIds.includes(run.routineId));
  }
  start(): void {
    if (process.env.OMB_PERSONAL_BUILD !== "1") return;
    try { if (this.settings.enabled) void this.warm().catch(() => {}); } catch { this.state = "error"; }
  }
  private warm(): Promise<void> {
    if (this.warming) return this.warming;
    this.state = "loading";
    this.warming = this.detector.detect([""]).then(() => { this.state = "ready"; }, () => { this.state = "error"; throw new PrivacyBlocked(); }).finally(() => { this.warming = undefined; });
    return this.warming;
  }
  async mask(scope: string, value: unknown, names: string[] = []): Promise<unknown> {
    const configured = prepareAliases(scope, this.settings.aliases, this.guard.vault);
    const input = mapPrivacyStrings(value, text => configured.prepare(text));
    try {
      const result = await this.guard.protect(scope, input, undefined, names.map(text => ({ text, label: "private_person" })));
      this.state = "ready";
      return mapPrivacyStrings(result, text => configured.finish(text));
    } catch { this.state = "error"; throw new PrivacyBlocked("Mac内のフィルターに失敗したため、この取得結果はAIに渡していません。再実行・送信の前に設定を確認してください。"); }
  }
  display(scope: string, text: string): string { return this.guard.vault.restoreForDisplay(scope, text); }
  async prompt(thread: string, text: string): Promise<string> {
    return process.env.OMB_PERSONAL_BUILD === "1" && this.selected(thread) ? await this.mask(thread, text) as string : text;
  }
  wrap(thread: string, integrations: SendTurnInput["integrations"]): SendTurnInput["integrations"] {
    if (process.env.OMB_PERSONAL_BUILD !== "1" || !this.selected(thread)) return integrations;
    return wrapPrivacyIntegrations(integrations, this.settings.sources);
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
        if (settings.enabled) void this.warm().catch(() => {});
        else this.state = "off";
      }
      return json(res, 200, { settings: this.settings, state: this.state });
    } catch (error) { return json(res, 400, { error: error instanceof PrivacyBlocked ? error.message : "保護設定を保存できません。" }); }
  };
  internalRoute(thread: string, assertActive: () => void): RouteHandler {
    return async ({ req, res, path, method, readBody, json }) => {
      if (path !== "/api/internal/privacy-filter" || method !== "POST") return PASS;
      res.setHeader("cache-control", "no-store");
      if (process.env.OMB_PERSONAL_BUILD !== "1") return json(res, 404, { error: "Personal版専用です。" });
      assertActive();
      const body = await readBody(req, 2_000_000);
      try {
        const settings = this.settings;
        if (!["custom", "browser", "composio", "data"].includes(body?.source)) throw new PrivacyBlocked();
        const selected = this.selected(thread, settings) && settings.sources.includes(body.source as PrivacySource);
        if (!selected) return json(res, 200, { value: body.value });
        const check = (value: unknown, depth = 0): void => {
          if (depth > 32) throw new PrivacyBlocked();
          if (value && typeof value === "object") {
            const type = (value as { type?: unknown }).type;
            if (["image", "audio", "resource", "resource_link", "video"].includes(String(type))) throw new PrivacyBlocked("画像・音声・リソースを含む結果は自動マスクに未対応のため遮断しました。");
            for (const item of Object.values(value)) check(item, depth + 1);
          }
        };
        check(body.value);
        const strings: string[] = [];
        mapPrivacyStrings(body.value, text => { strings.push(text); return text; });
        const protectedStrings = await this.mask(thread, strings) as string[];
        let index = 0;
        const value = mapPrivacyStrings(body.value, () => protectedStrings[index++]);
        assertActive();
        return json(res, 200, { value });
      } catch { return json(res, 503, { error: "自動マスクに失敗・未対応のため取得結果をAIに渡しません。原文への代替送信は行いません。" }); }
    };
  }
  close(): void { this.detector.close(); }
}
