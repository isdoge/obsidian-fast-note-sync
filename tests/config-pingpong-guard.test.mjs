// #114: two online devices must not ping-pong configs when mtime refreshes without content changes
// or when configReload applies received settings via setConfig / setTheme / onExternalSettingsChange.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const noop = () => {};
const timers = [];
const windowStub = {
  setTimeout: (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, ms, cleared: false }); return id; },
  clearTimeout: id => { const t = timers.find(x => x.id === id); if (t) t.cleared = true; },
};

const cache = new Map();
let diskHashes = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(`src/lib/sync/${name}.ts`, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console, TextDecoder, TextEncoder,
    window: windowStub,
    require: id => id === "obsidian" ? { normalizePath: p => p }
      : id.includes("helpers") ? new Proxy({
        dump: noop, dumpError: noop, showSyncNotice: noop,
        isPathInConfigSyncDirs: () => true, configIsPathExcluded: () => false, isInWhitelist: () => false,
        getFileName: p => p.split("/").pop(), getDirNameOrEmpty: p => p,
        configAddPathExcluded: noop, getConfigSyncCustomDirs: () => [], getPluginDir: () => ".obsidian/plugins/fast-note-sync",
        isLargeBinarySyncRisk: () => false,
        hashFileAsync: async (_app, p) => diskHashes.get(p) ?? "hash-default",
        hashContent: s => `h:${s}`,
        getSafeCtime: s => s.ctime ?? 1,
      }, { get: (t, k) => t[k] ?? noop })
      : id === "./operator_config" ? load("operator_config")
      : id.includes("sync_log_manager") ? { SyncLogManager: { getInstance: () => ({ addLog: noop }) } }
      : id.includes("i18n") ? { $: k => k }
      : {},
  });
  cache.set(name, module.exports);
  return module.exports;
}

const ops = load("operator_config");
const { ConfigManager } = load("config_manager");

function makeFixture() {
  timers.length = 0;
  const disk = new Map([[".obsidian/app.json", { content: '{"tabSize":2}', mtime: 1000, ctime: 1 }]]);
  diskHashes = new Map([[".obsidian/app.json", "hash-v1"]]);
  const sent = [];
  const configHashStore = new Map([[".obsidian/app.json", { hash: "hash-v1", mtime: 1000, size: 13 }]]);
  const enc = s => new TextEncoder().encode(s).buffer;

  const plugin = {
    isSyncing: false,
    manifest: { id: "fast-note-sync", dir: ".obsidian/plugins/fast-note-sync", version: "2.5.0" },
    settings: { configSyncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    ignoredConfigFiles: new Set(),
    addIgnoredConfigFile(p) { this.ignoredConfigFiles.add(p); },
    removeIgnoredConfigFile(p) { this.ignoredConfigFiles.delete(p); },
    pendingConfigModifies: new Map(),
    pendingConfigDeleteAcks: new Set(),
    lastSyncMtime: new Map([[".obsidian/app.json", 1000]]),
    localStorageManager: { syncPathPrefix: "__ls__/", getMetadata: () => 0, setMetadata: noop, savePending: noop },
    configHashManager: {
      isReady: () => true,
      getPathHash: p => configHashStore.get(p)?.hash ?? null,
      getValidHash: (p, m, s) => {
        const c = configHashStore.get(p);
        return c && c.mtime === m && c.size === s && m !== 0 ? c.hash : null;
      },
      setFileHash: (p, hash, mtime, size) => configHashStore.set(p, { hash, mtime, size }),
    },
    concurrencyLimiter: { waitForSlot: async () => true },
    websocket: { SendMessage: async (action, data) => sent.push({ action, data }) },
    configSyncTasks: { failed: 0 },
    recordSyncCompleted: noop,
    app: {
      vault: {
        configDir: ".obsidian",
        getConfig: () => 4,
        setConfig: () => {
          // Simulate Obsidian rewriting app.json with a fresh mtime when applying settings
          const entry = disk.get(".obsidian/app.json");
          disk.set(".obsidian/app.json", { ...entry, mtime: 2500 });
        },
        adapter: {
          exists: async p => disk.has(p) || p === ".obsidian",
          stat: async p => disk.has(p) ? { type: "file", mtime: disk.get(p).mtime, ctime: disk.get(p).ctime, size: disk.get(p).content.length } : null,
          read: async p => disk.get(p)?.content,
          readBinary: async p => enc(disk.get(p).content),
          write: async (p, content, opts = {}) => {
            disk.set(p, { content, mtime: opts.mtime ?? Date.now(), ctime: opts.ctime ?? 1 });
          },
          mkdir: async () => {},
          list: async () => ({ files: [...disk.keys()], folders: [] }),
        },
      },
      plugins: { enabledPlugins: new Set(), plugins: {}, disablePlugin: async () => {}, enablePlugin: async () => {} },
    },
  };
  const cm = Object.create(ConfigManager.prototype);
  cm.plugin = plugin;
  cm.fileStates = new Map([[".obsidian/app.json", 1000]]);
  cm.rootFilesExclude = ops.CONFIG_ROOT_FILES_EXCLUDE;
  cm.pluginExtsToWatch = ops.CONFIG_PLUGIN_EXTS_TO_WATCH;
  cm.themeExtsToWatch = ops.CONFIG_THEME_EXTS_TO_WATCH;
  cm.enabledPlugins = new Set();
  plugin.configManager = cm;

  return { plugin, cm, disk, sent, configHashStore };
}

// 1. Mtime refreshes without content change: configModify must NOT upload, and must update local mtime
{
  const { plugin, cm, disk, sent, configHashStore } = makeFixture();
  disk.set(".obsidian/app.json", { content: '{"tabSize":2}', mtime: 2000, ctime: 1 });
  await cm.handleRawEvent(".obsidian/app.json", true);
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 0, "unchanged content with refreshed mtime must not upload SettingModify");
  assert.equal(plugin.lastSyncMtime.get(".obsidian/app.json"), 2000, "lastSyncMtime updated to new mtime");
  assert.equal(configHashStore.get(".obsidian/app.json").mtime, 2000, "configHashManager mtime updated");

  // Real content edit still uploads
  disk.set(".obsidian/app.json", { content: '{"tabSize":4}', mtime: 3000, ctime: 1 });
  diskHashes.set(".obsidian/app.json", "hash-v2");
  await cm.handleRawEvent(".obsidian/app.json", true);
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1, "actual content change still uploads SettingModify");
  assert.equal(sent[0].action, "SettingModify");
}

// 2. receiveConfigSyncModify -> configReload keeps path ignored until checkAndReload finishes writing
{
  const { plugin, cm, disk, sent } = makeFixture();
  diskHashes.set(".obsidian/app.json", "hash-v2");
  await ops.receiveConfigSyncModify({
    path: ".obsidian/app.json",
    content: '{"tabSize":2}',
    contentHash: "hash-v2",
    mtime: 1500,
    ctime: 1,
  }, plugin);

  assert.equal(plugin.ignoredConfigFiles.has(".obsidian/app.json"), true,
    "path must remain ignored while waiting for deferred checkAndReload");

  // Any raw event firing during the 1s delay before checkAndReload runs is ignored
  await cm.handleRawEvent(".obsidian/app.json", true);
  assert.equal(sent.length, 0, "event before checkAndReload is ignored");

  // Run the scheduled checkAndReload (which calls app.vault.setConfig and bumps mtime to 2500)
  const activeTimer = [...timers].reverse().find(t => !t.cleared);
  assert.ok(activeTimer, "reload timer scheduled");
  await activeTimer.fn();
  await new Promise(r => setImmediate(r));

  assert.equal(plugin.ignoredConfigFiles.has(".obsidian/app.json"), false,
    "ignore protection is released once checkAndReload finishes applying config");
  assert.equal(cm.fileStates.get(".obsidian/app.json"), 2500,
    "ConfigManager fileStates updated with post-reload disk mtime");

  // Subsequent raw event with the same post-reload mtime does not upload
  await cm.handleRawEvent(".obsidian/app.json", true);
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 0, "no ping-pong upload after checkAndReload finishes");

  // Even if Obsidian asynchronously rewrites again later with a newer mtime but identical content, it still does not upload
  const entry = disk.get(".obsidian/app.json");
  disk.set(".obsidian/app.json", { ...entry, mtime: 3100 });
  await cm.handleRawEvent(".obsidian/app.json", true);
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 0, "delayed async rewrite with identical content does not upload");
  ops.cleanupConfigReloadTimer();
}

// 3. A newer server push arriving during the 1s checkAndReload window is applied, not dropped
{
  const { plugin, disk, sent } = makeFixture();
  diskHashes.set(".obsidian/app.json", "hash-v2");
  await ops.receiveConfigSyncModify({
    path: ".obsidian/app.json",
    content: '{"tabSize":2}',
    contentHash: "hash-v2",
    mtime: 1500,
    ctime: 1,
  }, plugin);
  await ops.receiveConfigSyncModify({
    path: ".obsidian/app.json",
    content: '{"tabSize":8}',
    contentHash: "hash-v3",
    mtime: 1600,
    ctime: 1,
  }, plugin);
  assert.equal(disk.get(".obsidian/app.json").content, '{"tabSize":8}',
    "newer server update during reload window is not dropped by ignoredConfigFiles");
  const activeTimer = [...timers].reverse().find(t => !t.cleared);
  await activeTimer.fn();
  await new Promise(r => setImmediate(r));
  assert.equal(plugin.ignoredConfigFiles.has(".obsidian/app.json"), false);
  assert.equal(sent.length, 0);
  ops.cleanupConfigReloadTimer();
}

console.log("config ping-pong guard tests passed");
