import assert from 'node:assert/strict';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const host = process.argv[2];
assert.ok(['opencode', 'kilo'].includes(host));
// Fail before writing state or starting a host if the caller omitted isolation.
await access('/.dockerenv');
assert.deepEqual(await readdir('/sys/class/net'), ['lo'], 'Docker --network none is required');
const pluginPath = process.argv[3];
const root = '/tmp/host-probe';
for (const path of ['config', 'data', 'cache', 'state', 'home', 'project', `config/${host}`]) {
  await mkdir(`${root}/${path}`, { recursive: true });
}
const config = {
  plugin: pluginPath ? [[`file://${pluginPath}`, { autoRecall: false, autoSave: false, baseUrl: 'http://127.0.0.1:9' }]] : [],
  provider: {},
  enabled_providers: [],
  autoupdate: false,
  experimental: { openTelemetry: false },
};
const configFile = `${root}/config/${host}/${host}.json`;
await writeFile(configFile, JSON.stringify(config));
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data`,
  XDG_CACHE_HOME: `${root}/cache`, XDG_STATE_HOME: `${root}/state`, TMPDIR: '/tmp',
  DO_NOT_TRACK: '1', CI: '1',
  npm_config_offline: 'true', npm_config_fetch_retries: '0',
};
for (const prefix of ['KILO', 'OPENCODE']) {
  env[`${prefix}_TEST_HOME`] = `${root}/home`;
  env[`${prefix}_CONFIG`] = configFile;
  for (const flag of ['DISABLE_AUTOUPDATE', 'DISABLE_DEFAULT_PLUGINS', 'DISABLE_MODELS_FETCH', 'DISABLE_PROJECT_CONFIG', 'DISABLE_CLAUDE_CODE', 'DISABLE_EXTERNAL_SKILLS', 'DISABLE_LSP_DOWNLOAD', 'EXPERIMENTAL_DISABLE_FILEWATCHER']) {
    env[`${prefix}_${flag}`] = '1';
  }
}
let logs = '';
const proc = spawn(`/usr/local/bin/${host}`, ['serve', '--hostname', '127.0.0.1', '--port', '4096', '--print-logs', '--log-level', 'DEBUG'], { cwd: `${root}/project`, env, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [proc.stdout, proc.stderr]) stream.on('data', x => { logs = (logs + x).slice(-100_000); });
let exit;
proc.on('exit', (code, signal) => { exit = { code, signal }; });
try {
  let health;
  for (let n = 0; n < 100; n++) {
    if (exit) throw new Error(`host exited ${JSON.stringify(exit)}`);
    try { health = await fetch('http://127.0.0.1:4096/global/health', { signal: AbortSignal.timeout(500) }); if (health.ok) break; } catch {}
    await delay(200);
  }
  assert.ok(health?.ok, 'host health');
  const response = await fetch('http://127.0.0.1:4096/experimental/tool/ids?directory=' + encodeURIComponent(`${root}/project`), { signal: AbortSignal.timeout(50_000) });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const ids = JSON.parse(body);
  const registered = ids.filter(x => x.startsWith('noosphere_')).sort();
  let schemaChecked = false;
  if (pluginPath) {
    assert.deepEqual(registered, ['noosphere_recall', 'noosphere_save', 'noosphere_status', 'noosphere_topics']);
    assert.doesNotMatch(logs, /failed to load plugin|plugin incompatible|Plugin export is not a function/);
    const schemaResponse = await fetch('http://127.0.0.1:4096/experimental/tool?provider=openai&model=gpt-4.1&directory=' + encodeURIComponent(`${root}/project`), { signal: AbortSignal.timeout(10_000) });
    const schemaBody = await schemaResponse.text();
    assert.equal(schemaResponse.status, 200, schemaBody);
    const save = JSON.parse(schemaBody).find(x => x.id === 'noosphere_save');
    assert.ok(save, 'save tool exposed by host schema endpoint');
    assert.equal(save.parameters.properties.restrictedTags.type, 'array');
    schemaChecked = true;
  }
  console.log(JSON.stringify({ host, status: 'PASS', pluginPath: pluginPath ?? null, registered, totalTools: ids.length, schemaChecked, network: 'Only loopback interface verified inside Docker', providerCalls: 'No model invocation requested', warnings: logs.split('\n').filter(x => /background dependency install failed|WARN|ERROR/.test(x)).slice(-8) }, null, 2));
} catch (error) {
  console.error(String(error));
  console.error(logs.slice(-15000));
  process.exitCode = 1;
} finally {
  proc.kill('SIGTERM');
  for (let n = 0; n < 20 && !exit; n++) await delay(100);
  if (!exit) proc.kill('SIGKILL');
}
