import { join } from "node:path";
import { installPrivacyBoundary } from "./boundary.ts";
import { installPrivacyConsole } from "./console.ts";
import { LocalDetector } from "./detector.ts";
import { PrivacyGuard } from "./guard.ts";
import { PrivacyVault } from "./vault.ts";

const restoreConsole = installPrivacyConsole();
const detector = new LocalDetector();
const cleanup = installPrivacyBoundary(new PrivacyGuard(new PrivacyVault(join(process.env.OMB_DATA_DIR!, "private")), detector));
process.once("exit", () => { cleanup(); restoreConsole(); });
await detector.detect(["ローカル検出モデルの起動確認です。"]);
