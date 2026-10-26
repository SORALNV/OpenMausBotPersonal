import { describe, expect, it, vi } from "vitest";
import { nativeReviewCandidate, reviewNativeQuestion } from "./native-omp-review.ts";
import type { NativeOmpBinding } from "../shared/native-omp.ts";

const cwd = "/home/rasp/workspace";
const question = (command: string) => ({ id: "native-1", method: "select", title: "Allow tool: bash", message: `Allow tool: bash\nCommand: ${command}`, options: ["Approve", "Approve bash for this session", "Deny"] });
const binding: NativeOmpBinding = { botId: "pi", enabled: true, host: "pi.test", user: "rasp", binary: "/bin/omp", stateRoot: "/state", profile: "fixture", cwd, model: "fixture", approvalPolicy: "mediator", mediator: { providerId: "fixture", modelId: "small", timeoutMs: 1000 } };

describe("native execution review", () => {
  it("routes ordinary Pi inspection to the mediator", async () => {
    const generate = vi.fn(async () => '{"decision":"allow","importance":"low"}');
    expect(nativeReviewCandidate(question("lsblk -o NAME,TRAN,SIZE,FSTYPE,LABEL,MOUNTPOINTS,MODEL"), cwd)).toBe("inspection");
    expect(await reviewNativeQuestion(binding, "接続ディスクを調べて", question("lsblk -o NAME,SIZE"), generate, new AbortController().signal)).toBe(true);
    expect(generate).toHaveBeenCalledWith("fixture", "small", expect.stringContaining("接続ディスクを調べて"), expect.any(AbortSignal));
  });

  it("important shell actions never reach automatic model authorization", async () => {
    const generate = vi.fn(async () => '{"decision":"allow","importance":"low"}');
    for (const command of ["rm -rf /data", "mkfs.ext4 /dev/sda", "sudo reboot", "systemctl restart ssh", "ip link set eth0 down", "ip -batch /tmp/actions route", "ip route show -batch /tmp/actions", "lsblk; reboot", "lsblk $(reboot)", "lsblk > /etc/fstab", "curl example.org", "python3 /tmp/run.py", "cat /home/rasp/.ssh/id_ed25519", "hostname changed-name", "dmesg --clear", "ps auxe"]) {
      expect(await reviewNativeQuestion(binding, "管理して", question(command), generate, new AbortController().signal), command).toBe(false);
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it("allows routine OS, network and version inspections as review candidates", () => {
    for (const command of ["command -v omp omb omb-native", "cat /etc/os-release", "cat /proc/meminfo /proc/cpuinfo", "hostname -I", "dmesg --human --nopager", "ip -br addr", "systemctl status ssh --no-pager", "python3 --version"]) expect(nativeReviewCandidate(question(command), cwd), command).toBe("inspection");
  });

  it("native safety overrides and generic confirmations cannot be auto-answered", async () => {
    const generate = vi.fn(async () => '{"decision":"allow","importance":"low"}');
    expect(await reviewNativeQuestion(binding, "調査", { ...question("lsblk"), message: "Reason: Critical pattern detected\nCommand: lsblk" }, generate, new AbortController().signal)).toBe(false);
    expect(await reviewNativeQuestion(binding, "調査", { ...question("lsblk"), method: "confirm" }, generate, new AbortController().signal)).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it("understands the standard Collab full-title approval without dropping native risk reasons", () => {
    const q = { ...question("uname -s"), title: "Allow tool: bash\nCommand: uname -s", message: undefined };
    expect(nativeReviewCandidate(q, cwd)).toBe("inspection");
    expect(nativeReviewCandidate({ ...q, title: "Allow tool: bash\nReason: Critical pattern detected\nCommand: uname -s" }, cwd)).toBeNull();
  });

  it("workspace notes are reviewable, but executable and sensitive targets require the owner", () => {
    const write = (path: string) => ({ ...question(""), title: "Allow tool: write", message: `Allow tool: write\nPath: ${path}\nContent: note` });
    expect(nativeReviewCandidate(write(`${cwd}/notes.md`), cwd)).toBe("workspace-change");
    for (const path of ["/etc/fstab", `${cwd}/../secret.md`, `${cwd}/auth.json`, `${cwd}/run.sh`, `${cwd}/.git/config`, `${cwd}/.hidden.txt`, `${cwd}/AGENTS.md`, `${cwd}/WATCHDOG.md`]) expect(nativeReviewCandidate(write(path), cwd)).toBeNull();
  });

  it("reviews ordinary relative project source and config saves without granting execution or escapes", async () => {
    const generate = vi.fn(async () => '{"decision":"allow","importance":"low"}');
    for (const path of ["wol_mcp.py", "tests/test_wol.py", ".gitignore", "requirements.txt", "computers.toml", "src/index.ts"]) {
      const q = { ...question(""), title: `Allow tool: write\nPath: ${path}\nContent: ${"x".repeat(8500)}`, message: undefined };
      expect(nativeReviewCandidate(q, cwd), path).toBe("workspace-change");
      expect(await reviewNativeQuestion(binding, "専用のMCPを開発して", q, generate, new AbortController().signal)).toBe(true);
    }
    for (const path of ["../other/file.py", "src/../../file.py", "/etc/config.toml", ".git/hooks/start.py", ".venv/start.py", "src/.hidden/file.py", "sitecustomize.py", "run.sh", "AGENTS.md", "auth.json", "proc://process/input.py", "~/start.py"]) {
      expect(nativeReviewCandidate({ ...question(""), title: `Allow tool: write\nPath: ${path}\nContent: x`, message: undefined }, cwd), path).toBeNull();
    }
  });

  it("reviews a limited project unittest command only with successfully saved test source evidence", async () => {
    const generate = vi.fn(async (_provider: string, _model: string, _prompt: string, _signal: AbortSignal) => '{"decision":"allow","importance":"low"}');
    const q = question(".venv/bin/python -m unittest discover -s tests -v");
    expect(nativeReviewCandidate(q, cwd)).toBe("workspace-test");
    expect(await reviewNativeQuestion(binding, "とりあえずWOL", q, generate, new AbortController().signal)).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    const files = [{ path: "tests/test_wol.py", content: "import unittest\nclass T(unittest.TestCase):\n def test_value(self): self.assertEqual(1, 1)" }];
    expect(await reviewNativeQuestion(binding, "とりあえずWOL", q, generate, new AbortController().signal, { files, priorRequests: ["自分用のMCPを開発して"] })).toBe(true);
    expect(generate.mock.calls[0]![2]).toContain("自分用のMCPを開発して");
    expect(generate.mock.calls[0]![2]).toContain("test_value");
    for (const command of [".venv/bin/python -m unittest discover -s /etc", "python3 -m unittest --locals", "python3 -m unittest discover -s tests/../other", ".venv/bin/python -m pip install example", "python3 -c arbitrary", "command -v omp; reboot"]) expect(nativeReviewCandidate(question(command), cwd), command).toBeNull();
    expect(await reviewNativeQuestion(binding, "検証して", q, generate, new AbortController().signal, { files: [{ ...files[0]!, path: "/other/tests/test_wol.py" }] })).toBe(false);
  });

  it("only a valid low-importance allow verdict permits execution", async () => {
    for (const reply of ['{"decision":"allow","importance":"high"}', '{"decision":"ask","importance":"low"}', "Approve", '{"decision":"allow","importance":"low","override":true}', "invalid"]) {
      expect(await reviewNativeQuestion(binding, "調査", question("lsblk"), async () => reply, new AbortController().signal)).toBe(false);
    }
    expect(await reviewNativeQuestion(binding, "調査", question("lsblk"), async () => { throw new Error("offline"); }, new AbortController().signal)).toBe(false);
  });

  it("requires the exact saved smoke-test script before review, rather than trusting its name", async () => {
    const generate = vi.fn(async () => '{"decision":"allow","importance":"low"}');
    const q = question(".venv/bin/python _smoke_wol.py");
    expect(nativeReviewCandidate(q, cwd)).toBe("workspace-test");
    for (const files of [[], [{ path: "tests/test_wol.py", content: "pass" }], [{ path: "_smoke_other.py", content: "pass" }]]) {
      expect(await reviewNativeQuestion(binding, "MCPを検証して", q, generate, new AbortController().signal, { files })).toBe(false);
    }
    expect(generate).not.toHaveBeenCalled();
    expect(await reviewNativeQuestion(binding, "MCPを検証して", q, generate, new AbortController().signal, { files: [{ path: `${cwd}/_smoke_wol.py`, content: "assert 1 == 1" }] })).toBe(true);
    for (const command of ["python3 app.py", "python3 ../_smoke_wol.py", "python3 /tmp/_smoke_wol.py", "python3 _smoke_wol.py --send", "python3 .hidden/test_wol.py", "python3 _smoke_wol.py; reboot"]) expect(nativeReviewCandidate(question(command), cwd), command).toBeNull();
    expect(await reviewNativeQuestion(binding, "MCPを検証して", q, async () => '{"decision":"ask","importance":"high"}', new AbortController().signal, { files: [{ path: "_smoke_wol.py", content: "import os; os.system('sudo reboot')" }] })).toBe(false);
  });

  it("explicit human policy and Stop do not use the reviewer", async () => {
    const generate = vi.fn(async () => '{"decision":"allow","importance":"low"}');
    expect(await reviewNativeQuestion({ ...binding, approvalPolicy: "human" }, "調査", question("lsblk"), generate, new AbortController().signal)).toBe(false);
    const controller = new AbortController(); controller.abort();
    expect(await reviewNativeQuestion(binding, "調査", question("lsblk"), generate, controller.signal)).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it("an uncooperative reviewer cannot stall a cancelled native request", async () => {
    const controller = new AbortController();
    const decision = reviewNativeQuestion(binding, "調査", question("lsblk"), () => new Promise(() => {}), controller.signal);
    controller.abort();
    expect(await decision).toBe(false);
  });
});
