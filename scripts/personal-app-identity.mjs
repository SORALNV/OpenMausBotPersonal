import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const uuidPattern = /^[0-9A-F]{32}$/u;
const allowedId = value => /^dev\.sora\.openmausbot\.personal(?:\.runtime)?$/u.test(value);
const derive = (bundleId, sourceUuid) => {
  const bytes = createHash("sha256").update(`OpenMausBot-Personal-build-identity-v1\0${bundleId}\0${sourceUuid}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  return bytes;
};

// macOS local-network privacy keys partly on LC_UUID; Electron apps otherwise share it. Apple TN3179 / TN3178.
export function personalExecutableIdentity(input, bundleId, prior) {
  if (!allowedId(bundleId) || !Buffer.isBuffer(input) || input.length < 32 || input.readUInt32LE(0) !== 0xfeedfacf) throw new Error("Expected a Personal thin 64-bit Mach-O executable");
  const count = input.readUInt32LE(16), size = input.readUInt32LE(20), end = 32 + size;
  if (!count || count > 65535 || end > input.length) throw new Error("Invalid Mach-O load commands");
  let cursor = 32, uuidOffset;
  for (let i = 0; i < count; i++) {
    if (cursor + 8 > end) throw new Error("Invalid Mach-O load command bounds");
    const command = input.readUInt32LE(cursor), length = input.readUInt32LE(cursor + 4);
    if (length < 8 || length % 8 || cursor + length > end) throw new Error("Invalid Mach-O load command size");
    if (command === 0x1b) {
      if (length !== 24 || uuidOffset !== undefined) throw new Error("Expected one LC_UUID command");
      uuidOffset = cursor + 8;
    }
    cursor += length;
  }
  if (cursor !== end || uuidOffset === undefined) throw new Error("Missing Mach-O build UUID");
  const current = input.subarray(uuidOffset, uuidOffset + 16).toString("hex").toUpperCase();
  let sourceUuid = current;
  if (prior !== undefined) {
    if (prior?.version !== 1 || !allowedId(prior.bundleId) || typeof prior.sourceUuid !== "string" || !uuidPattern.test(prior.sourceUuid)) throw new Error("Invalid Personal executable identity metadata");
    sourceUuid = prior.sourceUuid;
    if (current !== derive(prior.bundleId, sourceUuid).toString("hex").toUpperCase()) throw new Error("Personal executable identity does not match its metadata");
  }
  const output = Buffer.from(input), uuid = derive(bundleId, sourceUuid);
  uuid.copy(output, uuidOffset);
  return { bytes: output, marker: { version: 1, sourceUuid, bundleId }, uuid: uuid.toString("hex").toUpperCase() };
}

function appIdentityInput(app) {
  const infoPath = join(app, "Contents/Info.plist");
  const info = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPath], { encoding: "utf8" }));
  if (typeof info.CFBundleExecutable !== "string" || !/^[\w ()-]+$/u.test(info.CFBundleExecutable)) throw new Error("Invalid Personal executable name");
  const executable = join(app, "Contents/MacOS", info.CFBundleExecutable);
  return { infoPath, info, executable, bytes: readFileSync(executable) };
}

export function assertPersonalAppIdentity(app) {
  const { info, bytes } = appIdentityInput(app);
  if (!info.OMBPersonalExecutableIdentity || !info.NSLocalNetworkUsageDescription) throw new Error("Personal launcher needs its application build identity; use an explicit launcher migration");
  const expected = personalExecutableIdentity(bytes, info.CFBundleIdentifier, info.OMBPersonalExecutableIdentity);
  if (!expected.bytes.equals(bytes)) throw new Error("Personal build identity does not match the bundle");
}

export function setPersonalAppIdentity(app) {
  if (resolve(app).startsWith("/Applications/")) throw new Error("Personal build identity can only be set on a staged app");
  const { infoPath, info, executable, bytes } = appIdentityInput(app);
  const result = personalExecutableIdentity(bytes, info.CFBundleIdentifier, info.OMBPersonalExecutableIdentity);
  writeFileSync(executable, result.bytes);
  execFileSync("/usr/bin/plutil", ["-replace", "OMBPersonalExecutableIdentity", "-json", JSON.stringify(result.marker), infoPath]);
  execFileSync("/usr/bin/plutil", ["-replace", "NSLocalNetworkUsageDescription", "-string", "設定した家庭内のNASやRaspberry Piなどの機器と通信するために使用します。", infoPath]);
  return result.uuid;
}
