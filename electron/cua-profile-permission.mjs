import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const policyName = "cua-existing-profile.json";

export function existingProfileAllowed(userData) {
  try {
    const directory = fs.lstatSync(userData);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) return false;
    const file = path.join(userData, policyName);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o077)) return false;
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    return saved.version === 1 && saved.allowed === true;
  } catch { return false; }
}

export function saveExistingProfilePermission(userData, allowed) {
  if (typeof allowed !== "boolean") throw new Error("Invalid Chrome permission");
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(userData);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw new Error("Chrome permission directory must be private");
  const temporary = path.join(userData, `${policyName}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, allowed }), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, path.join(userData, policyName));
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function existingProfileHostBinary(binary, userData) {
  if (!existingProfileAllowed(userData)) return binary;
  const wrapper = path.join(userData, "cua-profile-launch");
  const temporary = `${wrapper}.${randomUUID()}.tmp`;
  const quoted = `'${binary.replaceAll("'", "'\\''")}'`;
  // SDK 0.28.2 owns the child lifecycle but has no startup-grants option. exec preserves its PID and liveness pipe.
  fs.writeFileSync(temporary, `#!/bin/sh\n[ "$1" = serve ] || exit 64\nexec ${quoted} "$@" --grant existing-profile\n`, { flag: "wx", mode: 0o700 });
  try { fs.renameSync(temporary, wrapper); } finally { fs.rmSync(temporary, { force: true }); }
  return wrapper;
}

export async function configureExistingProfilePermission({ userData, showMessageBox, restart }) {
  const allowed = existingProfileAllowed(userData);
  const result = await showMessageBox({
    type: "warning",
    title: "Chromeへの接続許可",
    message: allowed ? "ログイン済みChromeへの接続許可を取り消しますか？" : "PersonalのBotにログイン済みChromeへの接続を許可しますか？",
    detail: "このMacのChromeに保存されたログイン状態で、ページを読み取り・操作できるようになる許可です。USEAIだけに限定されません。通常のBot承認とmacOSの許可は維持します。変更後にPersonalを再起動するため、実行中の作業は先に完了してください。",
    buttons: ["キャンセル", allowed ? "取り消して再起動" : "許可して再起動"],
    defaultId: 0, cancelId: 0, noLink: true,
  });
  if (result.response !== 1) return false;
  saveExistingProfilePermission(userData, !allowed);
  restart();
  return true;
}
