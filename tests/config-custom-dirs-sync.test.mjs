// haierkeys/fast-note-sync-service#252: adding custom directories to configSyncOtherDirs after
// config sync is already enabled must scan unbaselined existing files (even with mtime < lastConfigSyncTime),
// clean up old custom-dir watchers before re-registering new ones, refresh fileStates, and reset
// lastConfigSyncTime / trigger full config sync on settings change.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const noop = () => {};
const plain = v => JSON.parse(JSON.stringify(v));

// 1. operator.ts: unbaselined file in newly added dir with mtime < lastConfigSyncTime must NOT be skipped
{
  const sent = [];
  const configFiles = new Map([
    [".obsidian/app.json", { mtime: 1000, ctime: 1000, size: 10, hash: "h-app" }],
    [".claude/settings.json", { mtime: 1000, ctime: 1000, size: 20, hash: "h-claude" }],
  ]);
  const baselined = new Map([[".obsidian/app.json", "h-app"]]);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync("src/lib/sync/operator.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console, WebSocket: { OPEN: 1 }, sleep: async () => {},
    window: { setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop },
    require: id => {
      if (id === "obsidian") return { normalizePath: p => p, TFolder: class {}, TFile: class {}, Platform: {} };
      if (id === "./operator_file") return { sweepStalledDownloadSessions: async () => 0 };
      if (id === "./operator_config") return {
        configAllPaths: async () => [...configFiles.keys()],
      };
      if (id.includes("helpers")) return new Proxy({
        dump: noop, dumpError: noop, showSyncNotice: noop,
        hashContent: s => `p:${s}`, hashContentAsync: async s => `c:${s}`,
        hashFileAsync: async (_app, p) => configFiles.get(p).hash,
        isPathExcluded: () => false, isFolderSyncPathExcluded: () => false, configIsPathExcluded: () => false,
        getConfigSyncCustomDirs: () => [".claude"], generateUUID: () => "ctx-252",
        getPluginDir: () => ".obsidian/plugins/fast-note-sync",
        isLargeBinarySyncRisk: () => false, yieldToMain: async () => {}, formatFileSize: () => "10B",
      }, { get: (t, k) => t[k] ?? noop });
      if (id.includes("sync_log_manager")) return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: noop, addLog: noop }) } };
      if (id.includes("i18n")) return { $: k => k };
      return {};
    },
  });
  const tasks = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 });
  const plugin = {
    isSyncing: false, isSyncRequesting: false, currentSyncType: "incremental", syncTypeCompleteCount: 0, expectedSyncCount: 0,
    settings: { syncEnabled: false, configSyncEnabled: true, readonlySyncEnabled: false, offlineDeleteSyncEnabled: false, isShowNotice: false, vault: "v" },
    menuManager: { ribbonIconStatus: true },
    progressTracker: { reset: noop, recordHashProgress: noop, isTypeFullyDone: () => true, getOverallPct: () => 100, getDetailText: () => "", forceComplete: noop },
    syncPageStateMap: new Map(),
    noteSyncTasks: tasks(), fileSyncTasks: tasks(), folderSyncTasks: tasks(), configSyncTasks: tasks(),
    resetSyncTasks: noop, updateStatusBar: noop,
    pendingFileRenames: [], pendingNoteRenames: new Map(),
    pendingDeleteNotePaths: new Set(), pendingDeleteFilePaths: new Set(), pendingDeleteFolderPaths: new Set(), pendingDeleteConfigPaths: new Set(),
    pendingNoteDeleteAcks: new Set(), pendingFileDeleteAcks: new Set(), pendingConfigDeleteAcks: new Set(),
    pendingNoteModifies: new Map(), pendingUploadHashes: new Map(), pendingConfigModifies: new Map(),
    scannedNoteHashes: new Map(), scannedFileHashes: new Map(), scannedConfigHashes: new Map(),
    fileDownloadSessions: new Map(),
    localStorageManager: { getMetadata: k => k === "lastConfigSyncTime" ? 5000 : 0, setMetadata: noop, savePending: noop, getStorageConfigs: async () => [] },
    configHashManager: {
      isReady: () => true,
      getPathHash: p => baselined.get(p) ?? null,
      getValidHash: (p, m, s) => {
        const h = baselined.get(p);
        const f = configFiles.get(p);
        return h && f && f.mtime === m && f.size === s ? h : null;
      },
      getAllPaths: () => [...baselined.keys()],
      bulkSetFromScanned: noop,
    },
    syncState: {
      conflictedPaths: new Set(), newConflictedPathsThisRound: new Set(),
      pendingNotePushPageIndex: new Map(), pendingFilePushPageIndex: new Map(), pendingConfigPushPageIndex: new Map(),
      pendingSyncEndTime: new Map(), syncTimeBaseline: new Map(),
      syncUpChunkNum: 50, pipelineWindowUp: 0, activeSyncContext: null, progressCheckIntervalId: null,
    },
    app: { vault: { configDir: ".obsidian", adapter: { exists: async () => false, stat: async p => configFiles.get(p) ?? null }, getAllLoadedFiles: () => [] } },
    websocket: { ws: { readyState: 1, bufferedAmount: 0 }, isOpen: true, SendMessage: async (a, d) => sent.push({ a, d }), once: noop, off: noop },
  };
  await module.exports.handleSync(plugin, true, "config");
  const settingReq = sent.find(m => m.a === "SettingSync")?.d;
  assert.ok(settingReq, "SettingSync message sent");
  assert.deepEqual(plain(settingReq.settings.map(s => s.path)), [".claude/settings.json"],
    "unbaselined file in newly added dir with older mtime is scanned, while already-baselined older file stays skipped");
}

// 2. ConfigManager.reloadCustomDirs(): clears old watchers, avoids duplicate watches, refreshes fileStates
{
  const watched = [];
  const unwatched = [];
  const modified = [];
  const deleted = [];
  let currentDirs = [".agents"];
  let diskFiles = new Map([[".agents/a.json", { type: "file", mtime: 100 }]]);

  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync("src/lib/sync/config_manager.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console,
    require: id => id === "obsidian" ? { normalizePath: p => p.replace(/\/$/, "") }
      : id.includes("helpers") ? new Proxy({
        dump: noop, dumpError: noop,
        getFileName: p => p.split("/").pop(),
        getDirNameOrEmpty: p => p,
        configAddPathExcluded: noop,
        isPathInConfigSyncDirs: (p, pl) => p.startsWith(".obsidian/") || pl.settings.dirs.some(d => p === d || p.startsWith(d + "/")),
        getConfigSyncCustomDirs: pl => pl.settings.dirs,
        isInWhitelist: () => false,
        getPluginDir: () => ".obsidian/plugins/fast-note-sync",
        configIsPathExcluded: () => false,
      }, { get: (t, k) => t[k] ?? noop })
      : id.includes("operator_config") ? {
        CONFIG_PLUGIN_EXTS_TO_WATCH: [".json"], CONFIG_ROOT_FILES_EXCLUDE: [], CONFIG_THEME_EXTS_TO_WATCH: [".css"],
        configModify: async p => modified.push(p),
        configDelete: async p => deleted.push(p),
        configAllPaths: async () => [...diskFiles.keys()],
        isPluginConfigPathExcluded: () => false,
      }
      : {},
  });

  const adapter = {
    watchHiddenRecursive: async p => { watched.push(p); },
    unwatch: async p => { unwatched.push(p); },
    stat: async p => diskFiles.get(p) ?? null,
    exists: async () => false,
  };
  const plugin = {
    isSyncing: false,
    manifest: { dir: ".obsidian/plugins/fast-note-sync" },
    settings: { configSyncEnabled: true, get dirs() { return currentDirs; } },
    ignoredConfigFiles: new Set(),
    lastSyncPathDeleted: new Set(),
    app: { vault: { adapter, configDir: ".obsidian" } },
  };

  const cm = new module.exports.ConfigManager(plugin);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(watched, [".agents"]);
  assert.equal(typeof cm.reloadCustomDirs, "function", "ConfigManager exposes reloadCustomDirs");

  // User adds .claude and removes .agents in settings
  currentDirs = [".claude"];
  diskFiles = new Map([[".claude/settings.json", { type: "file", mtime: 200 }]]);
  await cm.reloadCustomDirs();
  assert.deepEqual(unwatched, [".agents"], "old custom dir watcher is cleaned up before re-registering");
  assert.deepEqual(watched, [".agents", ".claude"], "new custom dir watcher is registered");
  assert.equal(cm.fileStates.has(".agents/a.json"), false, "removed dir fileState cleaned up");
  assert.equal(cm.fileStates.get(".claude/settings.json"), 200, "existing file in newly added dir added to fileStates");

  // Real-time edit and delete in newly added .claude dir now work
  diskFiles.set(".claude/settings.json", { type: "file", mtime: 300 });
  await cm.handleRawEvent(".claude/settings.json", true);
  assert.deepEqual(modified, [".claude/settings.json"]);
  diskFiles.delete(".claude/settings.json");
  await cm.handleRawEvent(".claude/settings.json", true);
  assert.deepEqual(deleted, [".claude/settings.json"]);

  // Without adapter.unwatch, reloadCustomDirs must not re-register already-watched dirs
  delete adapter.unwatch;
  const beforeCount = watched.length;
  await cm.reloadCustomDirs();
  assert.equal(watched.length, beforeCount, "already watched dir is not registered twice when unwatch is absent");
  currentDirs = [".claude", ".codex"];
  await cm.reloadCustomDirs();
  assert.deepEqual(watched.slice(beforeCount), [".codex"], "only newly added dir is watched");
}

// 3. setting.tsx + main.ts: saving configSyncOtherDirs resets lastConfigSyncTime and triggers reloadCustomDirs + full config sync
{
  const reloadCalls = [];
  const meta = new Map([["lastConfigSyncTime", 9999]]);
  let capturedOnSave = null;
  let scheduledSyncTimerFn = null;
  const fullSyncCalls = [];
  const stub = new Proxy(function () {}, { get: (t, k) => k === "prototype" ? {} : stub, apply: () => stub, construct: () => ({}) });
  const chainStub = new Proxy(function () {}, {
    get: (_t, k) => {
      if (k === "then") return undefined;
      return (...args) => {
        if (k !== "onChange") {
          for (const a of args) {
            if (typeof a === "function") {
              try { a(chainStub); } catch { /* ignore */ }
            }
          }
        }
        return chainStub;
      };
    },
    construct: () => chainStub,
  });

  // Load setting.tsx and inspect configSyncOtherDirs addRuleSetting callback
  const settingModule = { exports: {} };
  const settingCode = ts.transpileModule(fs.readFileSync("src/setting.tsx", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(codeOrSetting(settingCode), {
    module: settingModule, exports: settingModule.exports, console, window: { setTimeout: () => 1, clearTimeout: noop },
    require: id => id === "obsidian" ? { PluginSettingTab: class {}, Setting: chainStub, Platform: {}, Modal: class {}, SearchComponent: class {}, MarkdownRenderer: {}, Component: class {}, requestUrl: noop, setIcon: noop }
      : id.includes("helpers") ? new Proxy({ parseRules: s => s ? JSON.parse(s) : [] }, { get: (t, k) => t[k] ?? noop })
      : id.includes("i18n") ? { $: k => k }
      : new Proxy({}, { get: (_, k) => k === "__esModule" ? false : stub }),
  });

  function codeOrSetting(c) { return c; }

  const SettingTab = settingModule.exports.SettingTab;
  const fakeTab = Object.create(SettingTab.prototype);
  fakeTab.plugin = {
    settings: { configSyncEnabled: true, configSyncOtherDirs: "[]" },
    localStorageManager: { getMetadata: k => meta.get(k), setMetadata: (k, v) => meta.set(k, v) },
    saveAndReloadServices: async (item) => reloadCalls.push(item),
  };
  fakeTab.setDescWithBreaks = noop;
  fakeTab.refresh = noop;
  fakeTab.addRuleSetting = (_set, name, _desc, _getRules, onSave) => {
    if (name === "setting.sync.config_dirs") capturedOnSave = onSave;
  };
  const fakeEl = { lastElementChild: {} };
  fakeTab.renderSyncSettings(fakeEl);
  reloadCalls.length = 0;
  assert.ok(capturedOnSave, "captured configSyncOtherDirs onSave handler");
  await capturedOnSave([{ pattern: ".claude/", caseSensitive: false }]);
  assert.equal(meta.get("lastConfigSyncTime"), 0, "lastConfigSyncTime reset to 0 when configSyncOtherDirs changes");
  assert.deepEqual(reloadCalls, ["configSyncOtherDirs"], "saveAndReloadServices called with configSyncOtherDirs");

  // Load main.ts and verify reloadServices('configSyncOtherDirs') reloads custom dirs and schedules full config sync
  const mainModule = { exports: {} };
  const mainCode = ts.transpileModule(fs.readFileSync("src/main.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(mainCode, {
    module: mainModule, exports: mainModule.exports, console,
    window: { setTimeout: fn => { scheduledSyncTimerFn = fn; return 1; }, clearTimeout: noop },
    require: id => id === "obsidian" ? { Plugin: class {}, Platform: {}, Notice: class {}, normalizePath: x => x, moment: stub }
      : id.includes("sync/operator") ? { handleSync: (...args) => fullSyncCalls.push(args.slice(1)), cleanupConfigReloadTimer: noop, clearAllTempChunks: async () => {}, abortAllFileOperations: noop, resetFileOperations: noop, resetSettingSyncTime: noop, rebuildAllHashes: noop, clearAllHashes: noop, receiveSyncMessage: noop }
      : new Proxy({}, { get: (_, k) => k === "__esModule" ? false : stub }),
  });

  let customDirReloadCount = 0;
  const self = {
    settings: { api: "https://a", apiToken: "tok", configSyncEnabled: true, autoRedirectEnabled: false, wsPreProbeEnabled: false, logEnabled: "off" },
    runApi: "https://a", runWsApi: "wss://a",
    isFirstSync: true, wsSettingChange: false, syncTimer: null,
    websocket: { isRegister: false, isAuth: true, register: noop, unRegister: noop },
    configManager: { reloadCustomDirs: async () => { customDirReloadCount++; } },
    ignoredFiles: new Set(), ignoredConfigFiles: new Set(), lastSyncMtime: new Map(),
    lastSyncPathDeleted: new Set(), lastSyncPathRenamed: new Set(), fileDownloadSessions: new Map(),
  };
  mainModule.exports.default.prototype.reloadServices.call(self, true, "configSyncOtherDirs");
  assert.equal(customDirReloadCount, 1, "reloadServices calls configManager.reloadCustomDirs()");
  assert.ok(scheduledSyncTimerFn, "sync timer scheduled");
  scheduledSyncTimerFn();
  assert.deepEqual(fullSyncCalls, [[false, "config"]], "triggers full config sync (isLoadLastTime=false, mode='config')");
}

console.log("config custom dirs sync tests passed");
