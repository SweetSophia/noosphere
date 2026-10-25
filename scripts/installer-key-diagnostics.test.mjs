import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [
  { name: "success", status: "201", code: 0, expected: /noo_fixture_created/ },
  { name: "forbidden", status: "403", code: 22, expected: /ADMIN bootstrap key with explicit full scope/ },
  { name: "unauthorized", status: "401", code: 22, expected: /authentication.*401/i },
  { name: "server error", status: "500", code: 22, expected: /HTTP 500/ },
  { name: "rate limit", status: "429", code: 22, expected: /HTTP 429/ },
  { name: "transport error", status: "000", code: 7, expected: /transport.*curl exit 7/i },
  { name: "timeout", status: "000", code: 28, expected: /transport.*curl exit 28/i },
];

for (const [file, fn] of [["install-openclaw.sh", "create_scoped_integration_key"], ["install.sh", "create_tool_api_key"]]) {
  const source = readFileSync(path.join(root, file), "utf8");
  const start = source.indexOf(`${fn}() {\n`);
  assert.ok(start >= 0, `missing ${fn}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `missing end of ${fn}`);
  // Execute the actual function, not the installer main or a rewritten approximation.
  const body = source.slice(start, end + 3);
  for (const sample of cases) {
    test(`${file}: scoped-key creation diagnoses ${sample.name} without guessing scope`, () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "installer-diagnostic-"));
      try {
        const fixture = `
set -euo pipefail
work_dir=$TMPDIR
API_KEY=noo_fixture_bootstrap
APP_URL=http://127.0.0.1:6578
NOOSPHERE_PORT=6578
credential_field() { printf '%s' "$API_KEY"; }
validated_local_app_url() { printf '%s' "$APP_URL"; }
installer_validated_local_base_url() { printf '%s' "$APP_URL"; }
json_get() { node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]])' "$1" "$2"; }
local_no_proxy_curl() {
  local output=''
  while (($#)); do
    if [[ "$1" == --output ]]; then output=$2; shift 2; else shift; fi
  done
  printf '{"key":"noo_fixture_created"}' > "$output"
  printf '%s' "$FIXTURE_HTTP_STATUS"
  return "$FIXTURE_CURL_CODE"
}
${body}
${fn} fixture
`;
        const result = spawnSync("bash", ["-c", fixture], {
          env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, FIXTURE_HTTP_STATUS: sample.status, FIXTURE_CURL_CODE: String(sample.code) },
          encoding: "utf8", timeout: 10_000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status === 0, sample.name === "success", result.stderr);
        assert.match(result.stdout + result.stderr, sample.expected);
        if (!["success", "forbidden"].includes(sample.name)) {
          assert.doesNotMatch(result.stderr, /requires an ADMIN bootstrap key with explicit full scope/);
        }
        if (sample.name !== "success") assert.equal(result.stdout, "", "failed provisioning returned a key");
        assert.deepEqual(readdirSync(tmp), [], "temporary credential/request/response files leaked");
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    });
  }
}
