import { describe, expect, it, vi } from "vitest";
import { classifyNativeRisk, nativeHighRiskReason } from "./native-omp-review.ts";
import type { NativeOmpBinding } from "../shared/native-omp.ts";
const binding: NativeOmpBinding = { botId: "pi", enabled: true, host: "pi.test", user: "rasp", binary: "/bin/omp", stateRoot: "/state", profile: "fixture", cwd: "/home/rasp/workspace", model: "fixture", approvalPolicy: "mediator", mediator: { providerId: "fixture", modelId: "small", timeoutMs: 1000 } };
const question = (command: string) => ({ id: "native-1", method: "select", title: "Allow tool: bash", message: `Allow tool: bash\nCommand: ${command}`, options: ["Approve", "Approve bash for this session", "Deny"] });

describe("high-risk-only native confirmation", () => {
  it("proceeds with unlisted commands, arbitrary script names and missing source when no high risk is detected", async () => {
    const generate = vi.fn(async () => '{"highRisk":false}');
    for (const command of ["make check", "python3 /tmp/verify_project.py --verbose", ".venv/bin/python -m pip install httpx", "python3 -c \"print(1)\"", "curl --silent http://127.0.0.1:8081/api/wol/status", "custom-project-tool inspect"]) {
      expect(await classifyNativeRisk(binding, "依頼した開発を進めて", question(command), generate, new AbortController().signal), command).toEqual({ kind: "proceed" });
    }
    expect(generate).toHaveBeenCalledTimes(6);
  });

  it("does not classify an outside-workspace path, file extension or missing edit patch as high risk", async () => {
    for (const command of ["rm -rf .pytest_cache", "git clean -nd", "git push --dry-run"]) expect(nativeHighRiskReason(question(command))).toBeUndefined();
    for (const path of ["/home/rasp/agent-home/docs/guide.md", "../notes/Makefile", "AGENTS.md", "tests/test_secrets.py", ".mcp.json", "data.custom"]) {
      const q = { ...question(""), title: `Allow tool: edit\nFile: ${path}`, message: undefined };
      expect(nativeHighRiskReason(q), path).toBeUndefined();
      expect(await classifyNativeRisk(binding, "開発してドキュメントも整えて", q, async () => '{"highRisk":false}', new AbortController().signal)).toEqual({ kind: "proceed" });
    }
  });

  it("always confirms detected major effects, even if the model would report no risk", async () => {
    const generate = vi.fn(async () => '{"highRisk":false}');
    for (const command of ["rm -rf /data", "mkfs.ext4 /dev/sda", "sudo reboot", "systemctl restart ssh", "ip link set eth0 down", "git push origin main", "cat /home/rasp/.ssh/id_ed25519"]) {
      expect(await classifyNativeRisk(binding, "管理して", question(command), generate, new AbortController().signal)).toMatchObject({ kind: "high-risk", reason: expect.any(String) });
    }
    expect(generate).not.toHaveBeenCalled();
    for (const path of ["/etc/fstab", "/home/rasp/.config/systemd/user/example.service", "/home/rasp/.ssh/authorized_keys", "/home/rasp/.env"]) {
      expect(nativeHighRiskReason({ ...question(""), title: `Allow tool: write\nPath: ${path}\nContent: x`, message: undefined })).toBeTruthy();
    }
  });

  it("preserves native safety reasons without confusing code text with a native reason", async () => {
    const q = { ...question("uname -s"), title: "Allow tool: bash\nReason: Critical pattern detected\nCommand: uname -s", message: undefined };
    expect(await classifyNativeRisk(binding, "確認", q, async () => '{"highRisk":false}', new AbortController().signal)).toMatchObject({ kind: "high-risk" });
    expect(nativeHighRiskReason({ ...question(""), title: "Allow tool: write\nPath: note.txt\nContent:\nReason: an example", message: undefined })).toBeUndefined();
  });

  it("asks only for a concrete high-risk finding, with its reason", async () => {
    expect(await classifyNativeRisk(binding, "テストして", question("python3 verify.py"), async () => '{"highRisk":true,"reason":"検証コードが依頼していない実機を停止します。"}', new AbortController().signal)).toEqual({ kind: "high-risk", reason: "検証コードが依頼していない実機を停止します。" });
  });

  it("treats failed, ambiguous and legacy allow/low verdicts as retry, never a confirmation or permission", async () => {
    for (const result of ['{"decision":"allow","importance":"low"}', '{"highRisk":false,"extra":true}', '{"highRisk":true}', '{"highRisk":true,"reason":"unknown"}', 'unknown', 'null']) {
      expect(await classifyNativeRisk(binding, "進めて", question("make test"), async () => result, new AbortController().signal)).toEqual({ kind: "retry" });
    }
    expect(await classifyNativeRisk(binding, "進めて", question("make test"), async () => { throw Error("offline"); }, new AbortController().signal)).toEqual({ kind: "retry" });
  });

  it("cancels an uncooperative classifier and respects human-only bindings", async () => {
    const controller = new AbortController();
    const decision = classifyNativeRisk(binding, "進めて", question("make test"), () => new Promise(() => {}), controller.signal); controller.abort();
    expect(await decision).toEqual({ kind: "retry" });
    const generate = vi.fn(async () => '{"highRisk":false}');
    expect(await classifyNativeRisk({ ...binding, approvalPolicy: "human" }, "進めて", question("make test"), generate, new AbortController().signal)).toEqual({ kind: "retry" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("passes actual operation, current code and existing approvals to the risk detector", async () => {
    const generate = vi.fn(async (_p: string, _m: string, _text: string) => '{"highRisk":false}');
    const operation = { name: "edit", arguments: { input: "*** Begin Patch\n[source.py#1234]\nPUT >1:\n+print(1)\n*** End Patch" } };
    expect(await classifyNativeRisk(binding, "既存NAS連携の続き", { ...question(""), title: "Allow tool: edit\nFile: source.py", message: undefined }, generate, new AbortController().signal, { operation, files: [{ path: "source.py", content: "latest source" }], humanApprovals: ["同じ対象のWOL検証を承認済み"], priorRequests: ["NASをMCP化して"] })).toEqual({ kind: "proceed" });
    expect(generate.mock.calls[0]![2]).toContain("高リスク検出器");
    expect(generate.mock.calls[0]![2]).toContain("latest source");
    expect(generate.mock.calls[0]![2]).toContain("同じ対象のWOL検証を承認済み");
    expect(generate.mock.calls[0]![2]).toContain("print(1)");
  });
});
