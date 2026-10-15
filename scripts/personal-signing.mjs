import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error(`Local signing operation failed: ${command}`);
  return result.stdout;
}

function searchList() {
  return [...run("/usr/bin/security", ["list-keychains", "-d", "user"]).matchAll(/"([^"\n]+)"/g)].map(match => match[1]);
}

function assertPrivateFile(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) || info.uid !== process.getuid()) {
    throw new Error("Local signing material must be an owner-only regular file");
  }
}

function privateFile(file) {
  assertPrivateFile(file);
  return readFileSync(file, "utf8").trim();
}

function initialize(directory) {
  // Never replace a partial or existing identity: TCC grants depend on this key.
  mkdirSync(directory, { mode: 0o700 });
  const keychain = join(directory, "identity.keychain-db");
  const password = randomBytes(32).toString("base64url");
  writeFileSync(join(directory, "password"), password, { mode: 0o600, flag: "wx" });
  const config = join(directory, "openssl.cnf");
  writeFileSync(config, "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=code_sign\n[dn]\nCN=OpenMausBot Personal Local Signing\n[code_sign]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n", { mode: 0o600, flag: "wx" });
  const key = join(directory, "key.pem"), certificate = join(directory, "certificate.pem"), p12 = join(directory, "identity.p12");
  const before = searchList();
  try {
    run("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "3650", "-config", config, "-keyout", key, "-out", certificate]);
    chmodSync(key, 0o600);
    run("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", key, "-in", certificate, "-out", p12, "-passout", `file:${join(directory, "password")}`]);
    chmodSync(p12, 0o600);
    run("/usr/bin/security", ["create-keychain", "-p", password, keychain]);
    run("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
    run("/usr/bin/security", ["set-keychain-settings", "-lut", "300", keychain]);
    run("/usr/bin/security", ["import", p12, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign"]);
    chmodSync(keychain, 0o600);
    const fingerprint = run("/usr/bin/openssl", ["x509", "-in", certificate, "-noout", "-fingerprint", "-sha1"]).trim().split("=").at(-1).replaceAll(":", "");
    if (!/^[A-F0-9]{40}$/i.test(fingerprint)) throw new Error("Cannot identify the local signing certificate");
    writeFileSync(join(directory, "identity.json"), JSON.stringify({ version: 1, fingerprint }), { mode: 0o600, flag: "wx" });
  } finally {
    for (const file of [key, p12]) if (existsSync(file)) unlinkSync(file);
    const after = searchList();
    if (!before.includes(keychain) && after.includes(keychain)) {
      run("/usr/bin/security", ["list-keychains", "-d", "user", "-s", ...after.filter(file => file !== keychain)]);
    }
    if (existsSync(keychain)) run("/usr/bin/security", ["lock-keychain", keychain]);
  }
}

export function withPersonalSigning(directory, action) {
  if (process.platform !== "darwin") throw new Error("Personal signing requires macOS");
  if (!existsSync(directory)) initialize(directory);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== resolve(directory) || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error("Local signing directory must belong only to the current user");
  }
  const identity = JSON.parse(privateFile(join(directory, "identity.json")));
  if (identity.version !== 1 || !/^[A-F0-9]{40}$/i.test(identity.fingerprint)) throw new Error("Invalid local signing identity");
  const keychain = join(directory, "identity.keychain-db");
  assertPrivateFile(keychain);
  const password = privateFile(join(directory, "password"));
  run("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
  try {
    return action({ identity: identity.fingerprint, keychain });
  } finally {
    run("/usr/bin/security", ["lock-keychain", keychain]);
  }
}

export function personalSigningRequirement(app, fingerprint) {
  const result = spawnSync("/usr/bin/codesign", ["-d", "-r-", app], { encoding: "utf8" });
  const requirement = `${result.stdout}\n${result.stderr}`.split("\n").find(line => /^(?:# )?designated => /.test(line));
  if (result.status !== 0 || !requirement || !requirement.toLowerCase().includes(`certificate leaf = h"${fingerprint.toLowerCase()}"`) || requirement.includes("cdhash")) {
    throw new Error("Personal application must retain its certificate-pinned signing identity");
  }
  return requirement;
}
