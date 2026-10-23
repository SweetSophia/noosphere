import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const host = process.argv[2];
assert.ok(['opencode', 'kilo'].includes(host));
// Fail before writing state or starting a host if the caller omitted isolation.
await access('/.dockerenv');
assert.deepEqual(await readdir('/sys/class/net'), ['lo'], 'Docker --network none is required');
const pluginPath = process.argv[3];
// Existing file mode: HOST /fixture/node_modules/<adapter>
// Host-managed install: HOST /artifacts/adapter.tgz npm-tarball /npm-cache
const mode = process.argv[4] ?? 'file';
assert.ok(['file', 'npm-tarball'].includes(mode), 'Unknown probe mode');
const adapterName = `@sweetsophia/${host === 'opencode' ? 'opencode' : 'kilocode'}-noosphere-memory`;
const sdkName = host === 'opencode' ? '@opencode-ai/plugin' : '@kilocode/plugin';
const maintainedSdkName = `@sweetsophia/noosphere-${host === 'opencode' ? 'opencode' : 'kilocode'}-plugin`;
const npmCache = process.argv[5];
const root = '/tmp/host-probe';
if (mode === 'npm-tarball') {
  assert.ok(pluginPath && isAbsolute(pluginPath) && pluginPath.endsWith('.tgz'), 'An absolute .tgz path is required');
  assert.ok((await stat(pluginPath)).isFile(), 'Adapter tarball must be a file');
  assert.ok(npmCache && isAbsolute(npmCache), 'An absolute preseeded npm cache path is required');
  assert.ok((await stat(npmCache)).isDirectory(), 'npm cache must be a directory');
  // Registry cache may be preseeded, but the host installation itself must be new.
  await assert.rejects(access(root), { code: 'ENOENT' }, 'Host state must start empty');
} else {
  assert.equal(npmCache, undefined, 'npm cache argument requires npm-tarball mode');
}
const pluginSpec = mode === 'npm-tarball' ? `${adapterName}@file:${pluginPath}` : pluginPath && `file://${pluginPath}`;
for (const path of ['config', 'data', 'cache', 'state', 'home', 'project', `config/${host}`]) {
  await mkdir(`${root}/${path}`, { recursive: true });
}
const config = {
  plugin: pluginSpec ? [[pluginSpec, { autoRecall: false, autoSave: false, baseUrl: 'http://127.0.0.1:9' }]] : [],
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
  ...(npmCache ? { npm_config_cache: npmCache } : {}),
};
for (const prefix of ['KILO', 'OPENCODE']) {
  env[`${prefix}_TEST_HOME`] = `${root}/home`;
  env[`${prefix}_CONFIG`] = configFile;
  for (const flag of ['DISABLE_AUTOUPDATE', 'DISABLE_DEFAULT_PLUGINS', 'DISABLE_MODELS_FETCH', 'DISABLE_PROJECT_CONFIG', 'DISABLE_CLAUDE_CODE', 'DISABLE_EXTERNAL_SKILLS', 'DISABLE_LSP_DOWNLOAD', 'EXPERIMENTAL_DISABLE_FILEWATCHER']) {
    env[`${prefix}_${flag}`] = '1';
  }
}

async function readPackage(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

async function resolvedDependency(fromDir, name, packagesRoot) {
  // SDK exports are import-only. Inspect Node's package search locations without
  // incorrectly requiring a CommonJS entry point from an ESM-only package.
  for (const modules of createRequire(join(fromDir, 'package.json')).resolve.paths(name)) {
    const candidate = join(modules, name);
    const manifest = await readPackage(join(candidate, 'package.json'));
    if (!manifest) continue;
    const dir = await realpath(candidate);
    const within = relative(packagesRoot, dir);
    assert.ok(within !== '..' && !within.startsWith('../') && !isAbsolute(within), 'Dependency escaped host installation');
    return { dir, manifest };
  }
  assert.fail(`Missing installed dependency: ${name}`);
}

async function inspectHostInstallation() {
  const packagesRoot = `${root}/cache/${host}/packages`;
  // Both pinned Linux hosts use the unmodified spec as Npm.add's cache key,
  // including its scope and file-path slashes (sanitize only changes Windows).
  const dir = join(packagesRoot, pluginSpec, 'node_modules', adapterName);
  const manifest = await readPackage(join(dir, 'package.json'));
  assert.ok(manifest, 'Expected a fresh host-installed adapter');
  assert.equal(manifest.name, adapterName);
  const { dir: sdkDir, manifest: sdk } = await resolvedDependency(dir, sdkName, packagesRoot);
  assert.equal(sdk.name, maintainedSdkName);
  assert.match(sdk.dependencies.effect, /^npm:@sweetsophia\/noosphere-effect@/);
  const { dir: effectDir, manifest: effect } = await resolvedDependency(sdkDir, 'effect', packagesRoot);
  assert.equal(effect.name, '@sweetsophia/noosphere-effect');
  assert.equal(effect.dependencies.toml, '5.0.1');
  const { manifest: toml } = await resolvedDependency(effectDir, 'toml', packagesRoot);
  assert.equal(toml.name, 'toml');
  assert.equal(toml.version, '5.0.1');
  return { directory: dir, adapter: manifest.version, sdk: sdk.version, effect: effect.version, toml: toml.version };
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
  const installation = mode === 'npm-tarball' ? await inspectHostInstallation() : undefined;
  console.log(JSON.stringify({ host, status: 'PASS', mode, pluginPath: pluginPath ?? null, pluginSpec: pluginSpec ?? null, installation, registered, totalTools: ids.length, schemaChecked, network: 'Only loopback interface verified inside Docker', providerCalls: 'No model invocation requested', dependencyScope: 'Noosphere adapter graph only; independent host SDK bootstrap is outside this check', warnings: logs.split('\n').filter(x => /background dependency install failed|WARN|ERROR/.test(x)).slice(-8) }, null, 2));
} catch (error) {
  console.error(String(error));
  console.error(logs.slice(-15000));
  process.exitCode = 1;
} finally {
  proc.kill('SIGTERM');
  for (let n = 0; n < 20 && !exit; n++) await delay(100);
  if (!exit) proc.kill('SIGKILL');
}
