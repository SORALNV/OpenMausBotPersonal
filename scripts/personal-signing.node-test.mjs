import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPersonalSigning, personalSigningRequirement } from "./personal-signing.mjs";

test("local signer survives changed code, stays private, and rejects tampering", { skip: process.platform !== "darwin" }, () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "omb-signing-")));
  const signing = join(fixture, "signing"), requirements = [];
  const execute = args => {
    const result = spawnSync("/usr/bin/codesign", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    for (const name of ["true", "false"]) {
      const app = join(fixture, name);
      const arches = spawnSync("/usr/bin/lipo", ["-archs", `/usr/bin/${name}`], { encoding: "utf8" });
      const arch = process.arch === "arm64" ? (/\barm64e?\b/.exec(arches.stdout)?.[0]) : "x86_64";
      assert(arch);
      const thin = spawnSync("/usr/bin/lipo", [`/usr/bin/${name}`, "-thin", arch, "-output", app], { encoding: "utf8" });
      assert.equal(thin.status, 0, thin.stderr);
      withPersonalSigning(signing, ({ identity, keychain }) => {
        execute(["--force", "--sign", identity, "--keychain", keychain, "--identifier", "dev.sora.openmausbot.personal.fixture", "--timestamp=none", app]);
        execute(["--verify", "--strict", app]);
        requirements.push(personalSigningRequirement(app, identity));
      });
    }
    assert.equal(requirements[0], requirements[1]);
    assert(!requirements[0].includes("cdhash"));
    assert(!existsSync(join(signing, "key.pem")));
    assert(!existsSync(join(signing, "identity.p12")));
    const modified = join(fixture, "true"), bytes = readFileSync(modified);
    const sections = spawnSync("/usr/bin/otool", ["-l", modified], { encoding: "utf8" });
    assert.equal(sections.status, 0);
    const codeOffset = /sectname __text[\s\S]*?\boffset (\d+)/.exec(sections.stdout);
    assert(codeOffset);
    bytes[Number(codeOffset[1])] ^= 1;
    writeFileSync(modified, bytes);
    assert.notEqual(spawnSync("/usr/bin/codesign", ["--verify", "--strict", modified]).status, 0);
  } finally {
    if (existsSync(join(signing, "identity.keychain-db"))) {
      const deleted = spawnSync("/usr/bin/security", ["delete-keychain", join(signing, "identity.keychain-db")]);
      assert.equal(deleted.status, 0);
    }
    rmSync(fixture, { recursive: true, force: true });
  }
});
