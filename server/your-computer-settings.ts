import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import { PASS, type RouteHandler } from "./routes/table.ts";
import { ownerOrAdmin } from "./request-auth.ts";

const FILE = "your-computer-permission.json";
const SCOPE = ["画面の表示", "クリック", "キー入力", "文字入力", "スクロール", "アプリの起動・切替"] as const;
type State = { version: 1; deviceId: string; hostFingerprint: string; enabled: boolean };
type Challenge = { deviceId: string; expiresAt: number };
const reject = (message: string) => Object.assign(new Error(message), { status: 400 });

function safeName(): string {
  const raw = hostname().replace(/\.local$/i, "").trim().slice(0, 120);
  const name = raw.replace(/[\p{Cc}<>"']/gu, "").trim();
  const machine = platform() === "darwin" ? "Mac" : platform() === "win32" ? "Windows PC" : "Linux PC";
  return name ? `${name}（${machine}）` : machine;
}

function localHostFingerprint(): string {
  let identity = "";
  try {
    if (platform() === "darwin") {
      const output = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 2_000, encoding: "utf8", maxBuffer: 512 * 1024 });
      identity = output.match(/"IOPlatformUUID"\s*=\s*"([0-9A-F-]{36})"/i)?.[1] ?? "";
    } else if (platform() === "win32") {
      const output = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { timeout: 2_000, encoding: "utf8", maxBuffer: 64 * 1024 });
      identity = output.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i)?.[1] ?? "";
    } else {
      for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try { identity = readFileSync(file, "utf8").trim(); if (identity) break; } catch { /* Try the next OS machine-id location. */ }
      }
    }
  } catch { /* A missing platform identity fails over to the local installation identity below. */ }
  if (!identity) identity = `${platform()}:${hostname()}`;
  return createHash("sha256").update(`openmausbot-local-computer-v1:${identity}`).digest("hex");
}

export class YourComputerSettings {
  private readonly file: string;
  private readonly name = safeName();
  private readonly challenges = new Map<string, Challenge>();

  constructor(privateDir: string, hostFingerprint = localHostFingerprint()) {
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const dir = lstatSync(privateDir);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (process.getuid && dir.uid !== process.getuid())) throw reject("PC操作設定の保存先を確認できません。");
    chmodSync(privateDir, 0o700);
    this.file = join(privateDir, FILE);
    this.hostFingerprint = createHash("sha256").update(`${hostFingerprint}\0${realpathSync(privateDir)}`).digest("hex");
    if (!existsSync(this.file)) this.write({ version: 1, deviceId: randomUUID(), hostFingerprint: this.hostFingerprint, enabled: false });
    else this.read();
  }

  private readonly hostFingerprint: string;

  private read(): State {
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 4096) throw new Error();
      const state = JSON.parse(readFileSync(this.file, "utf8")) as State;
      if (state.version !== 1 || typeof state.deviceId !== "string" || !/^[0-9a-f-]{36}$/i.test(state.deviceId) || typeof state.hostFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(state.hostFingerprint) || typeof state.enabled !== "boolean") throw new Error();
      if (state.hostFingerprint !== this.hostFingerprint) {
        const fresh = { version: 1 as const, deviceId: randomUUID(), hostFingerprint: this.hostFingerprint, enabled: false };
        this.write(fresh);
        this.challenges.clear();
        return fresh;
      }
      return state;
    } catch {
      throw reject("PC操作設定を安全に読み込めません。確認を省略せず停止しました。");
    }
  }

  private write(state: State): void {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    renameSync(temp, this.file);
  }

  snapshot() {
    const state = this.read();
    return { enabled: state.enabled, deviceId: state.deviceId, deviceName: this.name, scope: [...SCOPE] };
  }

  enabled(): boolean { return this.read().enabled; }

  challenge() {
    const state = this.read();
    for (const [id, challenge] of this.challenges) if (challenge.expiresAt < Date.now()) this.challenges.delete(id);
    if (this.challenges.size >= 32) this.challenges.delete(this.challenges.keys().next().value!);
    const confirmationId = randomUUID();
    this.challenges.set(confirmationId, { deviceId: state.deviceId, expiresAt: Date.now() + 120_000 });
    return { confirmationId, deviceId: state.deviceId, deviceName: this.name, scope: [...SCOPE], expiresInMs: 120_000 };
  }

  configure(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw reject("設定が不正です。");
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(key => !["enabled", "confirmationId"].includes(key)) || typeof body.enabled !== "boolean") throw reject("設定が不正です。");
    const state = this.read();
    if (body.enabled) {
      const confirmationId = typeof body.confirmationId === "string" ? body.confirmationId : "";
      const challenge = this.challenges.get(confirmationId);
      this.challenges.delete(confirmationId);
      if (!challenge || challenge.expiresAt < Date.now() || challenge.deviceId !== state.deviceId) throw reject("有効化の確認が期限切れです。もう一度確認してください。");
    } else {
      this.challenges.clear();
    }
    this.write({ ...state, enabled: body.enabled });
    return this.snapshot();
  }
}

export function yourComputerSettingsRoute(settings: YourComputerSettings): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/your-computer/settings" && path !== "/api/your-computer/confirmation") return PASS;
    res.setHeader("cache-control", "no-store");
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "所有者の設定権限が必要です。" });
    try {
      if (path === "/api/your-computer/settings" && method === "GET") return json(res, 200, settings.snapshot());
      if (path === "/api/your-computer/confirmation" && method === "POST") return json(res, 200, settings.challenge());
      if (path === "/api/your-computer/settings" && method === "PUT") return json(res, 200, settings.configure(await readBody(req)));
      return json(res, 405, { error: "この操作は許可されていません。" });
    } catch (error) {
      return json(res, Number((error as { status?: unknown })?.status) || 400, { error: error instanceof Error ? error.message : "設定を保存できません。" });
    }
  };
}
