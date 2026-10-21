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
    for (const command of ["cat /etc/os-release", "cat /proc/meminfo /proc/cpuinfo", "hostname -I", "dmesg --human --nopager", "ip -br addr", "systemctl status ssh --no-pager", "python3 --version"]) expect(nativeReviewCandidate(question(command), cwd), command).toBe("inspection");
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

  it("only a valid low-importance allow verdict permits execution", async () => {
    for (const reply of ['{"decision":"allow","importance":"high"}', '{"decision":"ask","importance":"low"}', "Approve", '{"decision":"allow","importance":"low","override":true}', "invalid"]) {
      expect(await reviewNativeQuestion(binding, "調査", question("lsblk"), async () => reply, new AbortController().signal)).toBe(false);
    }
    expect(await reviewNativeQuestion(binding, "調査", question("lsblk"), async () => { throw new Error("offline"); }, new AbortController().signal)).toBe(false);
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
