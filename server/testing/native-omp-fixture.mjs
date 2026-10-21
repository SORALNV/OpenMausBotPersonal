import { spawn } from "node:child_process";
import { NativeOmpTransport, nativeOmpCommand } from "../../scripts/native-omp-transport.mjs";
import { NativeOmpCollab } from "../../scripts/native-omp-collab.mjs";

if (!process.env.FAKE_CLAUDE_OMP_ROOT || !process.env.HOME?.includes("omb-omp-fixture-")) throw new Error("Native fixture requires an isolated home");
NativeOmpTransport.connect = binding => {
  const plan = nativeOmpCommand(binding);
  return new NativeOmpTransport(spawn(process.execPath, [new URL("./fake-native-omp.mjs", import.meta.url).pathname, plan.sessionDir],
    { stdio: ["pipe", "pipe", "pipe"], env: { HOME: process.env.HOME, FAKE_CLAUDE_OMP_ROOT: process.env.FAKE_CLAUDE_OMP_ROOT } }), plan.sessionDir, { timeoutMs: 1000, turnTimeoutMs: 20_000 });
};
NativeOmpCollab.connect = NativeOmpTransport.connect;
