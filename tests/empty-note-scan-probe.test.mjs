import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Scan-path empty-note probe: a zero-byte, never-synced note listed in NoteSync with
// baseHashMissing makes the server's baseline decision a no_baseline conflict and nothing is
// downloaded — a new device's empty daily note stays empty forever. The scan must mirror the
// live path and probe with NoteRePush before listing it. Read-only mode, compatibility mode
// (legacy server) and a deliberate clear with an existing baseline must not change behavior.
//
// 扫描路径空笔记探测：0 字节、从未同步的笔记若照常以 baseHashMissing 进清单，服务端基线决策
// 会判 no_baseline 冲突且不下发内容，新设备上的空白日记永远补不上。扫描必须与实时路径一致，
// 先 NoteRePush 探测再决定是否进清单；只读模式、兼容模式（旧服务端）与已有基线的有意清空不变。
const root = path.resolve(import.meta.dirname, "..");
const noop = () => undefined;

class TFile {
  constructor(filePath, ext, size, mtime = 200) {
    this.path = filePath;
    this.extension = ext;
    this.stat = { mtime, ctime: mtime, size };
  }
}
class TFolder {}

const transpileAndRun = (relPath, customRequire) => {
  const absPath = path.join(root, relPath);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(absPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    console,
    Map,
    Set,
    WebSocket: { OPEN: 1 },
    sleep: async () => {},
    window: { setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop },
    require: customRequire,
  });
  return module.exports;
};

const realHelpers = transpileAndRun("src/lib/utils/helpers.ts", (id) => {
  if (id.includes("baseline_scope")) {
    return {
      buildBaselineFields: (plugin, kind, p) => {
        if (kind === "folder" || !plugin) return {};
        const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager;
        const b = m && typeof m.getPathHash === "function" ? m.getPathHash(p) : null;
        return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true };
      },
      buildDeleteBaselineFields: () => ({}),
      baselineFieldsFromDeleteRecord: () => ({}),
      computeRemoteScope: () => "scope",
      parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }),
      serializeScopedState: (state) => JSON.stringify(state),
    };
  }
  if (id.includes("conflict_store")) {
    return { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" };
  }
  if (id === "obsidian") {
    return { Notice: class {}, normalizePath: (x) => x, TFolder, TFile, Platform: { isMobile: false } };
  }
  if (id.includes("i18n")) return { $: (k) => k };
  if (id.includes("sync_log_manager")) return { SyncLogManager: { getInstance: () => ({ addLog: noop }) } };
  if (id.includes("helpers_obsidian_bypass")) {
    return { nativeFetch: noop, vaultDelete: noop, dump: noop, dumpError: noop, setLogEnabled: noop, logLevel: "off" };
  }
  return {};
});

const { SyncState } = transpileAndRun("src/lib/sync/sync_state.ts", () => ({}));

const probes = [];
const op = transpileAndRun("src/lib/sync/operator.ts", (id) => {
  if (id.includes("baseline_scope")) {
    return {
      buildBaselineFields: (plugin, kind, p) => {
        if (kind === "folder" || !plugin) return {};
        const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager;
        const b = m && typeof m.getPathHash === "function" ? m.getPathHash(p) : null;
        return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true };
      },
      buildDeleteBaselineFields: () => ({}),
      baselineFieldsFromDeleteRecord: () => ({}),
      computeRemoteScope: () => "scope",
      parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }),
      serializeScopedState: (state) => JSON.stringify(state),
    };
  }
  if (id.includes("conflict_store")) {
    return { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" };
  }
  if (id === "obsidian") return { normalizePath: (x) => x, TFile, TFolder, Platform: {} };
  if (id.includes("helpers")) {
    return {
      ...realHelpers,
      dump: noop,
      dumpError: noop,
      isPathExcluded: () => false,
      isFolderSyncPathExcluded: () => false,
      configIsPathExcluded: () => false,
      getConfigSyncCustomDirs: () => [],
      generateUUID: () => "ctx-1",
      showSyncNotice: noop,
      hashContent: (x) => `ph_${x}`,
      hashContentAsync: async (x) => `ch_${x}`,
      hashFileAsync: async (_app, p) => `fh_${p}`,
      yieldToMain: async () => {},
      getPluginDir: () => ".obsidian/plugins/fast-note-sync",
    };
  }
  if (id.includes("sync_log_manager")) return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: noop, addLog: noop }) } };
  if (id.includes("i18n")) return { $: (k) => k };
  if (id === "./operator_file") return { sweepStalledDownloadSessions: async () => 0, invalidateFileDownloads: noop };
  if (id === "./operator_config") return { configAllPaths: async () => [] };
  if (id === "./operator_note") {
    return {
      probeEmptyNoteInsteadOfUpload: (plugin, p, content, baseHash) => {
        probes.push({ path: p, content, baseHash });
        return true;
      },
    };
  }
  return {};
});

const tasks = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 });

function mkPlugin(fileList, settingsOverride = {}, options = {}) {
  const meta = new Map([
    ["lastNoteSyncTime", 0],
    ["lastFileSyncTime", 0],
    ["lastFolderSyncTime", 0],
    ["lastConfigSyncTime", 0],
    ["isInitSync", true],
  ]);
  const sentActions = [];
  const syncState = new SyncState();
  const baseHashes = options.baseHashes ?? {};
  const baselineMode = options.baselineMode ?? true;
  const plugin = {
    sentActions,
    syncState,
    settings: {
      syncEnabled: true,
      configSyncEnabled: false,
      isShowNotice: false,
      hashSyncLimitEnabled: false,
      hashSyncLimit: 50000,
      noteSyncLimit: 20,
      binarySyncLimitEnabled: true,
      attachmentSyncLimit: 50,
      vault: "v1",
      offlineDeleteSyncEnabled: false,
      readonlySyncEnabled: false,
      cloudPreviewEnabled: false,
      ...settingsOverride,
    },
    isSyncing: false,
    isSyncRequesting: false,
    currentSyncType: "full",
    syncTypeCompleteCount: 0,
    expectedSyncCount: 3,
    totalFilesToDownload: 0,
    downloadedFilesCount: 0,
    totalChunksToDownload: 0,
    downloadedChunksCount: 0,
    totalChunksToUpload: 0,
    uploadedChunksCount: 0,
    noteSyncTasks: tasks(),
    fileSyncTasks: tasks(),
    folderSyncTasks: tasks(),
    configSyncTasks: tasks(),
    pendingFileRenames: [],
    pendingNoteRenames: new Map(),
    pendingDeleteNotePaths: new Set(),
    pendingDeleteFilePaths: new Set(),
    pendingDeleteFolderPaths: new Set(),
    pendingDeleteConfigPaths: new Set(),
    pendingNoteDeleteAcks: new Set(),
    pendingFileDeleteAcks: new Set(),
    pendingConfigDeleteAcks: new Set(),
    pendingNoteModifies: new Map(),
    pendingUploadHashes: new Map(),
    pendingConfigModifies: new Map(),
    scannedNoteHashes: new Map(),
    scannedFileHashes: new Map(),
    scannedConfigHashes: new Map(),
    fileDownloadSessions: new Map(),
    syncPageStateMap: new Map(),
    menuManager: { ribbonIconStatus: true },
    statusBarManager: { updateConflictBadge: noop },
    concurrencyLimiter: { activeKeys: new Set(), queue: [] },
    resetSyncTasks: noop,
    updateStatusBar: noop,
    progressTracker: {
      reset: noop,
      recordHashProgress: noop,
      isTypeFullyDone: () => false,
      getOverallPct: () => 50,
      getDetailText: () => "",
      forceComplete: noop,
    },
    localStorageManager: {
      getMetadata: (k) => meta.get(k) ?? 0,
      setMetadata: (k, v) => meta.set(k, v),
      savePending: noop,
    },
    fileHashManager: {
      getPathHash: (p) => (p in baseHashes ? baseHashes[p] : null),
      getValidHash: () => null,
      isBaselineConfirmed: (p) => p in baseHashes,
      bulkSetFromScanned: noop,
    },
    folderSnapshotManager: { getMtime: () => undefined, isReady: () => false },
    websocket: {
      ws: { readyState: 1, bufferedAmount: 0 },
      isOpen: true,
      SendMessage: async (action, payload, _x, cb) => {
        sentActions.push({ action, payload });
        cb?.();
      },
    },
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: { exists: async () => false },
        getAllLoadedFiles: () => fileList,
        read: async (f) => (f.stat.size === 0 ? "" : `content:${f.path}`),
      },
    },
  };
  plugin.isSyncBaselineModeEnabled = () => baselineMode;
  return plugin;
}

const reportedNotePaths = (plugin) =>
  plugin.sentActions
    .filter((a) => a.action === "NoteSync")
    .flatMap((a) => (a.payload.notes || []).map((n) => n.path));

// 1. Baseline mode, zero-byte, no baseline: probe instead of listing.
{
  probes.length = 0;
  const p = mkPlugin([new TFile("diary/2026-11-18.md", "md", 0)]);
  await op.handleSync(p, false);
  assert.deepEqual(probes.map((x) => x.path), ["diary/2026-11-18.md"], "scan probes the empty unsynced note");
  assert.deepEqual(probes[0].content, "", "probe reads the note as empty");
  assert.equal(probes[0].baseHash, null, "probe passes the missing baseline");
  assert.deepEqual(reportedNotePaths(p), [], "probed note is not listed with baseHashMissing");
}

// 2. Baseline mode, zero-byte WITH a baseline (deliberate clear): lists normally, no probe.
{
  probes.length = 0;
  const p = mkPlugin([new TFile("diary/cleared.md", "md", 0)], {}, { baseHashes: { "diary/cleared.md": "base-hash" } });
  await op.handleSync(p, false);
  assert.deepEqual(probes, [], "a cleared note with a baseline is never probed");
  assert.deepEqual(reportedNotePaths(p), ["diary/cleared.md"], "the deliberate clear is uploaded as before");
}

// 3. Compatibility mode (legacy server): unchanged, no probe.
{
  probes.length = 0;
  const p = mkPlugin([new TFile("diary/legacy.md", "md", 0)], {}, { baselineMode: false });
  await op.handleSync(p, false);
  assert.deepEqual(probes, [], "compatibility mode never probes");
  assert.deepEqual(reportedNotePaths(p), ["diary/legacy.md"], "compatibility mode lists the note as before");
}

// 4. Read-only mode: unchanged, no probe.
{
  probes.length = 0;
  const p = mkPlugin([new TFile("diary/readonly.md", "md", 0)], { readonlySyncEnabled: true });
  await op.handleSync(p, false);
  assert.deepEqual(probes, [], "read-only mode never probes");
  assert.deepEqual(reportedNotePaths(p), ["diary/readonly.md"], "read-only mode lists the note as before");
}

// 5. Manual-only mode: unchanged, no probe.
{
  probes.length = 0;
  const p = mkPlugin([new TFile("diary/manual.md", "md", 0)], { manualSyncEnabled: true });
  await op.handleSync(p, false);
  assert.deepEqual(probes, [], "manual-only mode never probes");
  assert.deepEqual(reportedNotePaths(p), ["diary/manual.md"], "manual-only mode lists the note as before");
}

// 6. Baseline mode, non-empty note without baseline: lists normally, no probe.
{
  probes.length = 0;
  const p = mkPlugin([new TFile("diary/written.md", "md", 5)]);
  await op.handleSync(p, false);
  assert.deepEqual(probes, [], "non-empty notes are not probed");
  assert.deepEqual(reportedNotePaths(p), ["diary/written.md"], "non-empty note is listed");
}

// 7. Mixed scan: only the empty unsynced note is withheld.
{
  probes.length = 0;
  const p = mkPlugin([
    new TFile("diary/blank.md", "md", 0),
    new TFile("diary/filled.md", "md", 3),
  ]);
  await op.handleSync(p, false);
  assert.deepEqual(probes.map((x) => x.path), ["diary/blank.md"], "only the blank unsynced note is probed");
  assert.deepEqual(reportedNotePaths(p), ["diary/filled.md"], "other notes are still listed");
}

console.log("empty note scan probe tests passed");
