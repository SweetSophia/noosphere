import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { getVerifiedInstallerCommands } from "../../../openclaw-noosphere-memory/src/cli";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ref = "b2401da057dd90d96b28656c5e402bfd705d04d3";
const backendHash = "0ea396c1e523ec07c2428799f36edf0cdf3730459f8bd7f509605c8cdce0251c";

for (const tamper of [undefined, "install.sh", "install-openclaw.sh"] as const) {
  test(`verified CLI delivery ${tamper ? `rejects modified ${tamper}` : "resolves the paired backend without executing it"}`, async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "noosphere-installer-delivery-"));
    try {
      const bin = path.join(fixture, "bin");
      const downloads = path.join(fixture, "downloads");
      await mkdir(bin);
      await mkdir(downloads);
      for (const name of ["install.sh", "install-openclaw.sh"]) {
        const source = await readFile(path.join(root, name), "utf8");
        await writeFile(path.join(fixture, name), source + (tamper === name ? "\n# corrupted download\n" : ""));
      }
      await writeFile(path.join(bin, "curl"), `#!/bin/bash
set -eu
url=$2
target=$4
case "$url" in
  https://raw.githubusercontent.com/SweetSophia/noosphere/${ref}/install.sh) source=install.sh ;;
  https://raw.githubusercontent.com/SweetSophia/noosphere/${ref}/install-openclaw.sh) source=install-openclaw.sh ;;
  *) echo "Unexpected network request" >&2; exit 90 ;;
esac
printf '%s\\n' "$url" >> "$FIXTURE/requests"
stat -c '%a' "$(dirname "$target")" >> "$FIXTURE/modes"
cp "$FIXTURE/$source" "$target"
`, { mode: 0o755 });
      await writeFile(path.join(bin, "docker"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
      await writeFile(path.join(bin, "bash"), `#!/bin/bash
case "$1" in
  */install.sh) exec /bin/bash "$@" ;;
  *) touch "$FIXTURE/backend-executed"; exit 91 ;;
esac
`, { mode: 0o755 });
      const secret = "noo_delivery_regression_secret";
      const result = spawnSync("/bin/bash", ["-c", 'export PATH="$FIXTURE/bin:$PATH"\n' + getVerifiedInstallerCommands().join("\n")], {
        cwd: fixture,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          TMPDIR: downloads,
          FIXTURE: fixture,
          NOOSPHERE_HOME: path.join(fixture, "runtime"),
          NOOSPHERE_CREDENTIALS_FILE: path.join(fixture, "credentials.json"),
          NOOSPHERE_BOOTSTRAP_API_KEY: secret,
          NOOSPHERE_INSTALLER_TEST_MODE: "resolve-backend",
          // An inherited override must not replace the verified sibling.
          NOOSPHERE_BACKEND_PATH: path.join(fixture, "unverified.sh"),
          NOOSPHERE_BACKEND_OVERRIDE_SHA256: "0".repeat(64),
        },
      });
      assert.ifError(result.error);
      const output = result.stdout + result.stderr;
      assert.ok(!output.includes(secret), "must not print inherited credentials");
      const requests = await readFile(path.join(fixture, "requests"), "utf8").catch((cause) => {
        throw new Error(`Download stub was not called: ${output}`, { cause });
      });
      assert.deepEqual(requests.trim().split("\n"), [
        `https://raw.githubusercontent.com/SweetSophia/noosphere/${ref}/install.sh`,
        `https://raw.githubusercontent.com/SweetSophia/noosphere/${ref}/install-openclaw.sh`,
      ]);
      assert.equal(await readFile(path.join(fixture, "modes"), "utf8"), "700\n700\n");
      assert.deepEqual(await readdir(downloads), [], "temporary downloads must be removed on success and failure");
      await assert.rejects(stat(path.join(fixture, "backend-executed")), { code: "ENOENT" });
      if (tamper) {
        assert.notEqual(result.status, 0, output);
        assert.match(output, /FAILED/);
        assert.doesNotMatch(output, /resolved_backend_sha256=/);
      } else {
        assert.equal(result.status, 0, output);
        assert.match(output, /Mode:\s+fresh installation/);
        assert.ok(output.includes(`resolved_backend_sha256=${backendHash}`), output);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
