import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// #294: a server copy of a plugin whose manifest version is older than the local one must not replace
// the local plugin, whichever order manifest.json and main.js arrive in; the newer local files are
// uploaded again. Same or newer versions, and non-code files, are written as before.
const code = ts.transpileModule(fs.readFileSync("src/lib/sync/operator_config.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const logs = [];
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports, console, TextDecoder, TextEncoder,
  window: { setTimeout: () => 1, clearTimeout() {} },
  require: id => id === "obsidian" ? { normalizePath: p => p }
    : id.includes("helpers") ? new Proxy({ isPathInConfigSyncDirs: () => true, configIsPathExcluded: () => false,
        hashFileAsync: async () => "local-hash", hashContent: () => "p", getSafeCtime: s => s.ctime }, { get: (t, k) => t[k] ?? (() => undefined) })
    : id.includes("sync_log_manager") ? { SyncLogManager: { getInstance: () => ({ addLog: (...a) => logs.push(a) }) } }
    : id.includes("i18n") ? { $: k => k } : {} });
const ops = module.exports;
const enc = s => new TextEncoder().encode(s).buffer, dec = b => new TextDecoder().decode(b);
const dir = ".obsidian/plugins/qa";

function fixture(localVersion) {
  const disk = new Map([[`${dir}/manifest.json`, JSON.stringify({ version: localVersion })], [`${dir}/main.js`, "new code"], [`${dir}/data.json`, "{}"]]);
  const sent = [];
  const plugin = {
    settings: { configSyncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    localStorageManager: { syncPathPrefix: "__ls__/", getMetadata: () => 0, setMetadata() {}, savePending() {} },
    app: { vault: { configDir: ".obsidian", adapter: {
      exists: async p => disk.has(p) || p === dir || p === ".obsidian/plugins",
      stat: async p => (disk.has(p) ? { mtime: 7, ctime: 1, size: disk.get(p).length } : null),
      read: async p => disk.get(p), readBinary: async p => enc(disk.get(p)),
      write: async (p, c) => disk.set(p, c), writeBinary: async (p, b) => disk.set(p, dec(b)), mkdir: async () => {},
    } } },
    ignoredConfigFiles: new Set(), addIgnoredConfigFile(p) { this.ignoredConfigFiles.add(p); }, removeIgnoredConfigFile(p) { this.ignoredConfigFiles.delete(p); },
    pendingConfigModifies: new Map(), pendingConfigDeleteAcks: new Set(), lastSyncMtime: new Map(),
    configHashManager: { isReady: () => true, getPathHash: () => "local-hash", getValidHash: () => null, setFileHash() {} },
    configManager: { updateFileState() {}, enabledPlugins: new Set() },
    concurrencyLimiter: { waitForSlot: async () => true },
    websocket: { SendMessage: async (action, d) => sent.push(d.path) },
    configSyncTasks: { failed: 0 }, recordSyncCompleted() {},
  };
  const push = (file, content) => ops.receiveConfigSyncModify({ path: `${dir}/${file}`, content, contentHash: "r", mtime: 9, ctime: 1 }, plugin);
  return { disk, sent, push, plugin };
}
const settle = () => new Promise(r => setImmediate(r));

// main.js first, then an older manifest: main.js is restored and both are uploaded again
{
  const f = fixture("2.1.0");
  await f.push("main.js", "old code");
  assert.equal(f.disk.get(`${dir}/main.js`), "old code");
  await f.push("manifest.json", JSON.stringify({ version: "2.0.9" }));
  await settle();
  assert.equal(f.disk.get(`${dir}/main.js`), "new code", "main.js restored");
  assert.equal(JSON.parse(f.disk.get(`${dir}/manifest.json`)).version, "2.1.0", "manifest kept");
  assert.deepEqual([...f.sent].sort(), [`${dir}/main.js`, `${dir}/manifest.json`], "newer local files uploaded again");
  // a later main.js for the blocked plugin is skipped too
  await f.push("main.js", "old code");
  assert.equal(f.disk.get(`${dir}/main.js`), "new code");
  // data files are not version-guarded
  await f.push("data.json", '{"a":1}');
  assert.equal(f.disk.get(`${dir}/data.json`), '{"a":1}');
  ops.cleanupConfigReloadTimer();
}
// manifest first, then main.js
{
  const f = fixture("1.10.0");
  await f.push("manifest.json", JSON.stringify({ version: "1.2.5" }));
  await f.push("main.js", "old code");
  assert.equal(f.disk.get(`${dir}/main.js`), "new code");
  assert.equal(JSON.parse(f.disk.get(`${dir}/manifest.json`)).version, "1.10.0");
  ops.cleanupConfigReloadTimer();
}
// same or newer server version is applied
for (const remote of ["2.1.0", "2.2.0", "not-a-version"]) {
  const f = fixture("2.1.0");
  await f.push("main.js", "server code");
  await f.push("manifest.json", JSON.stringify({ version: remote }));
  assert.equal(f.disk.get(`${dir}/main.js`), "server code", remote);
  assert.equal(JSON.parse(f.disk.get(`${dir}/manifest.json`)).version, remote, remote);
  assert.deepEqual(f.sent, [], remote);
  ops.cleanupConfigReloadTimer();
}
assert.equal(ops.isVersionLower("1.2.9", "1.10.0"), true);
assert.equal(ops.isVersionLower("v2.0", "2.0.0"), false);
assert(logs.some(l => l[1] === "ConfigDowngradeSkipped"));
console.log("plugin downgrade guard tests passed");
