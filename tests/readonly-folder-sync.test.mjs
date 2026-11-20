// #220: in read-only mode, startup/incremental sync must not send local folders or delFolders
// in FolderSync (which causes the server to create and broadcast folders), while still sending
// lastTime and missingFolders to pull server folders. Real-time folder events must also be blocked.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const noop = () => {};
class TFolder { constructor(p) { this.path = p; } }
class TFile { constructor(p) { this.path = p; this.extension = p.split(".").pop(); this.stat = { size: 10, mtime: 100, ctime: 100 }; } }

function load(file, extraRequire) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console, WebSocket: { OPEN: 1 }, sleep: async () => {},
    window: { setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop },
    require: id => {
      if (id.includes("baseline_scope")) return { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) };
    if (id.includes("conflict_store")) return { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" };
          if (id === "obsidian") return { normalizePath: p => p, TFolder, TFile, Platform: {}, Menu: class {}, MenuItem: class {} };
      if (extraRequire && extraRequire(id) !== undefined) return extraRequire(id);
      if (id.includes("helpers")) return new Proxy({
        dump: noop, dumpError: noop, showSyncNotice: noop,
        hashContent: s => `h:${s}`, hashContentAsync: async s => `h:${s}`,
        isPathExcluded: () => false, isFolderSyncPathExcluded: () => false, configIsPathExcluded: () => false,
        getConfigSyncCustomDirs: () => [], generateUUID: () => "ctx-1", getPluginDir: () => ".obsidian/plugins/fast-note-sync",
        isLargeBinarySyncRisk: () => false, yieldToMain: async () => {}, formatFileSize: () => "10B",
        isPathInConfigSyncDirs: () => false,
      }, { get: (t, k) => t[k] ?? noop });
      if (id.includes("sync_log_manager")) return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: noop, addLog: noop }) } };
      if (id.includes("i18n")) return { $: k => k };
      return {};
    },
  });
  return module.exports;
}

const op = load("src/lib/sync/operator.ts", id => id === "./operator_file" ? { sweepStalledDownloadSessions: async () => 0 } : undefined);
const folderOps = load("src/lib/sync/operator_folder.ts");
const { EventManager } = load("src/lib/utils/events_manager.ts", id => id.includes("operator_folder") ? folderOps : undefined);

const tasks = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 });
function makePlugin({ readonly, offlineDelete = false, folders = [], trackedFolders = [] }) {
  const sent = [];
  const snapshotSetCalls = [];
  const meta = new Map([["lastNoteSyncTime", 10], ["lastFileSyncTime", 10], ["lastConfigSyncTime", 10], ["lastFolderSyncTime", 500]]);
  const plugin = {
    isSyncing: false,
    isSyncRequesting: false,
    currentSyncType: "incremental",
    syncTypeCompleteCount: 0,
    expectedSyncCount: 0,
    settings: {
      syncEnabled: true, configSyncEnabled: false, readonlySyncEnabled: readonly,
      offlineDeleteSyncEnabled: offlineDelete, isShowNotice: false, manualSyncEnabled: false,
      vault: "v", cloudPreviewEnabled: false, cloudPreviewTypeRestricted: true,
    },
    menuManager: { ribbonIconStatus: true },
    progressTracker: { reset: noop, recordHashProgress: noop, isTypeFullyDone: () => true, getOverallPct: () => 100, getDetailText: () => "", forceComplete: noop },
    syncPageStateMap: new Map(),
    noteSyncTasks: tasks(), fileSyncTasks: tasks(), folderSyncTasks: tasks(), configSyncTasks: tasks(),
    resetSyncTasks: noop, updateStatusBar: noop,
    pendingFileRenames: [], pendingNoteRenames: new Map(),
    pendingDeleteNotePaths: new Set(), pendingDeleteFilePaths: new Set(),
    pendingDeleteFolderPaths: new Set(), pendingDeleteConfigPaths: new Set(),
    pendingNoteDeleteAcks: new Set(), pendingFileDeleteAcks: new Set(), pendingConfigDeleteAcks: new Set(),
    pendingNoteModifies: new Map(), pendingUploadHashes: new Map(), pendingConfigModifies: new Map(),
    scannedNoteHashes: new Map(), scannedFileHashes: new Map(), scannedConfigHashes: new Map(),
    fileDownloadSessions: new Map(),
    localStorageManager: { getMetadata: k => meta.get(k) ?? 0, setMetadata: (k, v) => meta.set(k, v), savePending: noop },
    fileHashManager: { isReady: () => true, getPathHash: () => null, getValidHash: () => null, getAllPaths: () => [], bulkSetFromScanned: noop },
    folderSnapshotManager: {
      isReady: () => true,
      getMtime: () => undefined,
      getAllPaths: () => trackedFolders,
      setFolderMtimes: (paths) => snapshotSetCalls.push(paths),
      setFolderMtime: noop,
      removeFolder: noop,
    },
    syncState: {
      conflictedPaths: new Set(), newConflictedPathsThisRound: new Set(),
      pendingNotePushPageIndex: new Map(), pendingFilePushPageIndex: new Map(), pendingConfigPushPageIndex: new Map(),
      pendingSyncEndTime: new Map(), syncTimeBaseline: new Map(),
      syncUpChunkNum: 50, pipelineWindowUp: 0, activeSyncContext: null, progressCheckIntervalId: null,
    },
    lockManager: { withLock: async (_k, fn) => fn() },
    addIgnoredFile: noop, removeIgnoredFile: noop, isIgnoredFile: () => false,
    lastSyncPathDeleted: new Set(), lastSyncPathRenamed: new Set(),
    app: { vault: { adapter: { exists: async () => false }, getAllLoadedFiles: () => folders.map(p => new TFolder(p)) } },
    websocket: {
      isAuth: true, ws: { readyState: 1, bufferedAmount: 0 }, isOpen: true,
      SendMessage: async (action, payload) => sent.push({ action, payload }),
      once: noop, off: noop,
    },
  };
  return { plugin, sent, snapshotSetCalls };
}

const plain = v => JSON.parse(JSON.stringify(v));

// 1. handleSync in read-only mode with local folders and offline-missing tracked folder
{
  const { plugin, sent, snapshotSetCalls } = makePlugin({
    readonly: true,
    offlineDelete: false,
    folders: ["LocalOnlyDir", "ExistingDir"],
    trackedFolders: ["ExistingDir", "MissingOnLocalDir"],
  });
  await op.handleSync(plugin, true, "note");
  const folderReq = sent.find(m => m.action === "FolderSync")?.payload;
  assert.ok(folderReq, "FolderSync message is still sent to pull server changes");
  assert.deepEqual(plain(folderReq.folders), [], "read-only mode must not send local folders in FolderSync");
  assert.equal(folderReq.delFolders, undefined, "read-only mode must not send delFolders");
  assert.equal(folderReq.lastTime, 500, "lastTime is preserved for incremental pull");
  assert.deepEqual(plain(folderReq.missingFolders), [{ path: "MissingOnLocalDir", pathHash: "h:MissingOnLocalDir" }], "missingFolders is still sent to restore missing local folders");
  assert.equal(snapshotSetCalls.length, 0, "snapshot mtimes not bumped for unsent folders");
}

// 2. handleRequestSend directly in read-only mode with offlineDeleteSyncEnabled=true
{
  const { plugin, sent } = makePlugin({ readonly: true, offlineDelete: true });
  await op.handleRequestSend(
    plugin, "auto",
    { lastTime: 10, notes: [], delNotes: [], missingNotes: [], context: "c" },
    { lastTime: 10, files: [], delFiles: [], missingFiles: [], context: "c" },
    { lastTime: 10, configs: [], delConfigs: [], missingConfigs: [], context: "c" },
    {
      lastTime: 321,
      folders: [{ path: "LocalDir", pathHash: "h:LocalDir" }],
      delFolders: [{ path: "DeletedDir", pathHash: "h:DeletedDir" }],
      missingFolders: [{ path: "MissingDir", pathHash: "h:MissingDir" }],
      context: "c",
    }
  );
  const folderReq = sent.find(m => m.action === "FolderSync")?.payload;
  assert.deepEqual(plain(folderReq.folders), [], "handleRequestSend strips folders in read-only mode");
  assert.equal("delFolders" in folderReq, false, "handleRequestSend omits delFolders in read-only mode");
  assert.equal(folderReq.lastTime, 321);
  assert.deepEqual(plain(folderReq.missingFolders), [{ path: "MissingDir", pathHash: "h:MissingDir" }]);
  assert.equal(plugin.pendingDeleteFolderPaths.size, 0, "no pendingDeleteFolderPaths recorded in read-only mode");
}

// 3. Non-read-only mode still sends local folders and delFolders
{
  const { plugin, sent } = makePlugin({
    readonly: false,
    offlineDelete: true,
    folders: ["LocalDir"],
    trackedFolders: ["LocalDir", "DeletedDir"],
  });
  await op.handleSync(plugin, true, "note");
  const folderReq = sent.find(m => m.action === "FolderSync")?.payload;
  assert.deepEqual(plain(folderReq.folders), [{ path: "LocalDir", pathHash: "h:LocalDir" }]);
  assert.deepEqual(plain(folderReq.delFolders), [{ path: "DeletedDir", pathHash: "h:DeletedDir" }]);
}

// 4. Real-time folder events are blocked in read-only mode (both EventManager and operator_folder)
{
  const { plugin, sent } = makePlugin({ readonly: true });
  const dir = new TFolder("NewDir");
  await folderOps.folderModify(dir, plugin, true);
  await folderOps.folderDelete(dir, plugin, true);
  await folderOps.folderDeleteByPath("NewDir", plugin);
  await folderOps.folderRename(dir, "OldDir", plugin, true);
  const em = new EventManager(plugin);
  em.watchModify(dir);
  em.watchDelete(dir);
  em.watchRename(dir, "OldDir");
  assert.deepEqual(sent, [], "real-time folder create/rename/delete must not send in read-only mode");
}

console.log("read-only folder sync tests passed");
