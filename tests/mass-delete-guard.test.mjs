import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 大批消失护栏 / mass-disappearance guard:
// - 纯函数边界（小库、空基线、正常删除、>=100 且 >80%）
// - 真实 operator 扫描链路：触发时清空待上报删除并冻结游标；未触发时照常上报

const root = path.resolve(import.meta.dirname, "..");
const noop = () => {};

function loadModule(relPath, requireStub = () => ({}), extraGlobals = {}) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: requireStub,
    console,
    window: { setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop },
    setTimeout,
    clearTimeout,
    Date,
    ...extraGlobals,
  });
  return module.exports;
}

// ─── Part 1: pure decision function ───────────────────────────────────────────
const guard = loadModule("src/lib/sync/mass_delete_guard.ts");
const { evaluateMassDeleteGuard, MASS_DELETE_GUARD_MIN_BASELINE, MASS_DELETE_GUARD_MISSING_RATIO } = guard;

assert.equal(MASS_DELETE_GUARD_MIN_BASELINE, 100);
assert.equal(MASS_DELETE_GUARD_MISSING_RATIO, 0.8);

{
  const small = evaluateMassDeleteGuard({ confirmedBaselineCount: 99, pendingDeleteCount: 99 });
  assert.equal(small.triggered, false, "small vault (<100 confirmed) never triggers");

  const empty = evaluateMassDeleteGuard({ confirmedBaselineCount: 0, pendingDeleteCount: 0 });
  assert.equal(empty.triggered, false, "empty baseline never triggers");
  assert.equal(empty.missingRatio, 0);

  const firstSync = evaluateMassDeleteGuard({ confirmedBaselineCount: 0, pendingDeleteCount: 5000 });
  assert.equal(firstSync.triggered, false, "first sync / no confirmed baseline never triggers");

  const normal = evaluateMassDeleteGuard({ confirmedBaselineCount: 1000, pendingDeleteCount: 7 });
  assert.equal(normal.triggered, false, "deleting a few files from a large vault is not blocked");

  const boundaryBelow = evaluateMassDeleteGuard({ confirmedBaselineCount: 100, pendingDeleteCount: 80 });
  assert.equal(boundaryBelow.triggered, false, "exactly 80% does not trigger");

  const boundaryHit = evaluateMassDeleteGuard({ confirmedBaselineCount: 100, pendingDeleteCount: 81 });
  assert.equal(boundaryHit.triggered, true, "100 confirmed and 81% missing triggers");

  const mass = evaluateMassDeleteGuard({ confirmedBaselineCount: 5, pendingDeleteCount: 5 });
  assert.equal(mass.triggered, false, "100% missing but only 5 confirmed still does not trigger");

  const clamped = evaluateMassDeleteGuard({ confirmedBaselineCount: 10, pendingDeleteCount: 99 });
  assert.equal(clamped.pendingDeleteCount, 10, "pending delete count is clamped to the baseline total");
  assert.equal(clamped.triggered, false);

  const custom = evaluateMassDeleteGuard({ confirmedBaselineCount: 4, pendingDeleteCount: 4, minBaselineCount: 4 });
  assert.equal(custom.triggered, true, "thresholds are overridable for tests");
}

// ─── Part 2: operator scan wiring ─────────────────────────────────────────────
class TFile {
  constructor(p, ext = "md", mtime = 50, size = 10) {
    this.path = p;
    this.extension = ext;
    this.stat = { mtime, ctime: mtime, size };
  }
}
class TFolder {}

const notices = [];
const logs = [];
const sent = [];

const { SyncState } = loadModule("src/lib/sync/sync_state.ts");

const helpersStub = {
  dump: noop,
  dumpError: noop,
  isPathExcluded: () => false,
  isFolderSyncPathExcluded: () => false,
  configIsPathExcluded: () => false,
  getConfigSyncCustomDirs: () => [],
  generateUUID: () => "ctx-guard",
  showSyncNotice: (msg) => notices.push(msg),
  isLargeBinarySyncRisk: () => false,
  describeBinarySyncLimit: () => "100MB",
  hashContent: (x) => `ph_${x}`,
  hashContentAsync: async (x) => `ch_${x}`,
  hashFileAsync: async (_app, p) => `fh_${p}`,
  formatFileSize: (n) => `${n}B`,
  yieldToMain: async () => {},
  getPluginDir: () => ".obsidian/plugins/fast-note-sync",
  checkAndNotifyCaseConflict: () => false,
  getSafeCtime: (s) => s?.ctime ?? 0,
  normalizeServerTimestamp: (t) => t,
};

const baselineScopeStub = {
  buildBaselineFields: () => ({}),
  buildDeleteBaselineFields: () => ({}),
};

const operatorRequire = (id) => {
  if (id === "obsidian") return { normalizePath: (x) => x, TFile, TFolder, Platform: {} };
  if (id === "./mass_delete_guard") return guard;
  if (id.includes("helpers")) return helpersStub;
  if (id.includes("baseline_scope")) return baselineScopeStub;
  if (id.includes("sync_log_manager")) {
    return {
      SyncLogManager: {
        getInstance: () => ({
          addOrUpdateLog: noop,
          addLog: (type, action, message, status) => logs.push({ type, action, message, status }),
        }),
      },
    };
  }
  if (id.includes("i18n")) return { $: (k, params) => `${k}:${JSON.stringify(params ?? {})}` };
  if (id.includes("conflict_store")) return { conflictKindToSyncType: () => "note", normalizeConflict: () => null, storeSyncConflict: async () => false };
  if (id.includes("file_cloud_preview")) return { FileCloudPreview: class {} };
  return {};
};

const op = loadModule("src/lib/sync/operator.ts", operatorRequire, {
  sleep: async () => {},
  WebSocket: { OPEN: 1 },
  activeDocument: undefined,
});

const tasks = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, needConflict: 0, completed: 0, failed: 0 });

function makePlugin(trackedPaths, liveFiles) {
  const meta = new Map([
    ["lastNoteSyncTime", 100],
    ["lastFileSyncTime", 100],
    ["lastFolderSyncTime", 100],
    ["lastConfigSyncTime", 100],
    ["isInitSync", true],
  ]);
  const liveHashes = new Map(liveFiles.map((f) => [f.path, `ph_${f.path}`]));
  const confirmed = new Set(trackedPaths);
  const syncState = new SyncState();
  // Keep every scenario in a single upload batch so the legacy stop-and-wait path
  // (which waits for a real BatchAck) never blocks the test.
  syncState.syncUpChunkNum = 10000;
  return {
    meta,
    sent,
    syncState,
    settings: {
      syncEnabled: true,
      configSyncEnabled: false,
      isShowNotice: true,
      hashSyncLimitEnabled: false,
      hashSyncLimit: 0,
      noteSyncLimit: 20,
      attachmentSyncLimit: 100,
      vault: "v1",
      offlineDeleteSyncEnabled: true,
      readonlySyncEnabled: false,
      cloudPreviewEnabled: false,
      cloudPreviewTypeRestricted: true,
    },
    isSyncing: false,
    isSyncRequesting: false,
    currentSyncType: "incremental",
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
    resetSyncTasks: function () { this.syncState.resetSession(); },
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
      getAllPaths: () => trackedPaths,
      getBaselineProvenance: (p) => (confirmed.has(p) ? "confirmed" : "none"),
      isBaselineConfirmed: (p) => confirmed.has(p),
      getPathHash: (p) => liveHashes.get(p) ?? null,
      getValidHash: (p) => liveHashes.get(p) ?? null,
      bulkSetFromScanned: noop,
    },
    folderSnapshotManager: {
      getMtime: () => undefined,
      isReady: () => false,
      isBaselineConfirmed: () => false,
    },
    websocket: {
      ws: { readyState: 1, bufferedAmount: 0 },
      isOpen: true,
      SendMessage: (action, payload, _x, cb) => {
        sent.push({ action, payload });
        cb?.();
      },
      on: noop,
      off: noop,
    },
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: { exists: async () => false },
        getAllLoadedFiles: () => liveFiles,
      },
    },
  };
}

async function runRound(trackedPaths, liveFiles) {
  notices.length = 0;
  logs.length = 0;
  sent.length = 0;
  const plugin = makePlugin(trackedPaths, liveFiles);
  await op.handleSync(plugin, true);
  return plugin;
}

const payloadFor = (action) => sent.find((entry) => entry.action === action)?.payload;
const guardLogs = () => logs.filter((entry) => entry.action === "MassDeleteGuard");
const guardNotices = () => notices.filter((n) => n.includes("ui.notice.mass_delete_guard"));

// Normal round: 1000 confirmed, 2 gone -> deletes are reported as usual.
{
  const tracked = Array.from({ length: 1000 }, (_, i) => `notes/n${i}.md`);
  const live = tracked.slice(2).map((p) => new TFile(p));
  const plugin = await runRound(tracked, live);
  const notePayload = payloadFor("NoteSync");
  assert.ok(notePayload, "NoteSync is sent");
  assert.equal(notePayload.delNotes?.length, 2, "a few genuine deletes are still reported");
  assert.equal(guardLogs().length, 0, "guard stays silent for normal deletes");
  assert.equal(guardNotices().length, 0, "no guard notice for normal deletes");
  assert.equal(plugin.syncState.truncatedSyncFields.size, 0, "cursors are not frozen for normal deletes");
  assert.equal(plugin.pendingDeleteNotePaths.size, 2, "normal delete paths stay pending for SyncEnd");
}

// Mass round: 200 confirmed, 199 gone -> guard clears deletes and freezes cursors.
{
  const tracked = Array.from({ length: 200 }, (_, i) => `notes/n${i}.md`);
  const live = [new TFile(tracked[0])];
  const plugin = await runRound(tracked, live);
  const notePayload = payloadFor("NoteSync");
  assert.ok(notePayload, "NoteSync is still sent for live items / empty list");
  assert.equal(notePayload.delNotes?.length ?? 0, 0, "mass deletes are blocked from reaching the server");
  assert.equal(payloadFor("FileSync")?.delFiles?.length ?? 0, 0, "no attachment deletes reach the server");
  assert.equal(guardLogs().length, 1, "one failure-closed log entry");
  assert.equal(guardLogs()[0].status, "error", "guard log is an error");
  assert.equal(guardNotices().length, 1, "user gets exactly one clear notice");
  const notice = guardNotices()[0];
  assert.ok(notice.includes('"deleted":"199"'), "notice reports how many were blocked");
  assert.ok(notice.includes('"total":"200"'), "notice reports the confirmed baseline size");
  assert.equal(plugin.syncState.truncatedSyncFields.has("lastNoteSyncTime"), true, "note cursor is frozen");
  assert.equal(plugin.syncState.truncatedSyncFields.has("lastFileSyncTime"), true, "file cursor is frozen");
  assert.equal(plugin.pendingDeleteNotePaths.size, 0, "blocked deletes never become pending removals");
  assert.equal(plugin.pendingDeleteFilePaths.size, 0, "blocked attachment deletes never become pending removals");
}

// Small round: 50 confirmed, all gone -> below the 100 threshold, still reported.
{
  const tracked = Array.from({ length: 50 }, (_, i) => `notes/s${i}.md`);
  const plugin = await runRound(tracked, []);
  assert.equal(payloadFor("NoteSync")?.delNotes?.length, 50, "small-vault deletes are not blocked");
  assert.equal(guardLogs().length, 0, "small vault never triggers the guard");
  assert.equal(plugin.syncState.truncatedSyncFields.size, 0, "small-vault cursors are not frozen");
}

// Unconfirmed baselines: 200 tracked but only 50 confirmed, all 200 missing.
// Confirmed baseline is below 100 -> no trigger; legacy caches never inflate the denominator.
{
  notices.length = 0;
  logs.length = 0;
  sent.length = 0;
  const tracked = Array.from({ length: 200 }, (_, i) => `notes/u${i}.md`);
  const plugin = makePlugin(tracked, []);
  const extras = new Set(tracked.slice(0, 50));
  plugin.fileHashManager.getBaselineProvenance = (p) => (extras.has(p) ? "confirmed" : "none");
  await op.handleSync(plugin, true);
  assert.equal(guardLogs().length, 0, "fewer than 100 confirmed baselines never triggers");
  assert.equal(payloadFor("NoteSync")?.delNotes?.length, 200, "unconfirmed-only vault deletes are not blocked by denominator tricks");
}

console.log("PASS: mass-delete guard boundaries and fail-closed operator wiring");
