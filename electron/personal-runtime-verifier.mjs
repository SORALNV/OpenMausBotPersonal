import { execFile } from "node:child_process";
import * as nativeFs from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export function runtimeRequirement(fingerprint) {
  if (!/^[a-f0-9]{40}$/i.test(fingerprint)) throw new Error("Invalid runtime signer");
  return `=identifier "dev.sora.openmausbot.personal.runtime" and certificate leaf = H"${fingerprint}"`;
}

export async function verifyPersonalRuntime({ root, fingerprint, uid = process.getuid(), fileSystem = nativeFs, verifySignature = async (app, requirement) => {
  await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--test-requirement", requirement, app], { stdio: "pipe", timeout: 60_000 });
} }) {
  const { lstatSync, readFileSync, realpathSync } = fileSystem;
  const privateDirectory = path => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path) || stat.uid !== uid || (stat.mode & 0o077)) throw new Error("Runtime directory must be private and owned by this user");
  };
  privateDirectory(root);
  const activePath = join(root, "active.json");
  const activeStat = lstatSync(activePath);
  if (!activeStat.isFile() || activeStat.isSymbolicLink() || activeStat.nlink !== 1 || activeStat.uid !== uid || (activeStat.mode & 0o077) || activeStat.size > 512) throw new Error("Invalid runtime activation file");
  const active = JSON.parse(readFileSync(activePath, "utf8"));
  if (active.version !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(active.id) || Object.keys(active).some(key => !["version", "id"].includes(key))) throw new Error("Invalid runtime version");
  const versions = join(root, "versions"), version = join(versions, active.id);
  privateDirectory(versions); privateDirectory(version);
  const app = join(version, "OpenMausBot Runtime.app");
  for (const path of [app, join(app, "Contents"), join(app, "Contents", "Resources")]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022)) throw new Error("Invalid runtime bundle path");
  }
  const resources = join(app, "Contents", "Resources"), archive = join(resources, "app.asar");
  const archiveStat = lstatSync(archive);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.nlink !== 1 || archiveStat.uid !== uid || (archiveStat.mode & 0o022)) throw new Error("Invalid runtime archive");
  // No code or metadata from the mutable runtime is loaded before this check.
  await verifySignature(app, runtimeRequirement(fingerprint));
  return { id: active.id, app, resources, entry: join(archive, "electron", "personal-main.mjs") };
}
