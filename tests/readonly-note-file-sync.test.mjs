// Read-only mode must only receive remote updates: scan-inferred local deletes must never be
// reported (note/file/config), the metadata lists are still sent (the server diffs them), but
// they must never be recorded as a synced baseline. All read-only decisions in a round use the
// snapshot taken at handleSync entry, so flipping the toggle mid-round cannot split the round.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const noop = () => undefined;

function transpile(relPath) {
  const sourcePath = path.join(root, relPath);
  return {
    source: ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      fileName: sourcePath,
    }).outputText,
    sourcePath,
  };
}

const notices = [];
const logs = [];
const helpersStub = {
  dump: noop, dumpError: noop, isPathExcluded: () => false, isFolderSyncPathExcluded: () => false,
  configIsPathExcluded: () => false, getConfigSyncCustomDirs: () => [],
  hashContent: (x) => `p:${x}`, hashContentAsync: async (x) => `h:${x}`,
  hashFileAsync: async () => "f", getPluginDir: () => ".obsidian/plugins/fast-note-sync",
  showSyncNotice: (msg) => notices.push(msg), isLargeBinarySyncRisk: () => false,
  describeBinarySyncLimit: () => "100MB", formatFileSize: () => "10B", yieldToMain: async () => undefined,
  generateUUID: () => "ctx-ro", getSafeCtime: (s) => s?.ctime ?? 0,
  checkAndNotifyCaseConflict: () => false, normalizeServerTimestamp: (v) => v,
};
const logManager = {
  addOrUpdateLog: noop,
  addLog: (type, action, message, status) => logs.push({ type, action, message, status }),
};
class ScanTFile {
  constructor(p, extension = "png", mtime = 200, size = 3) {
    this.path = p; this.extension = extension;
    this.stat = { mtime, ctime: 150, size };
  }
}
class ScanTFolder { constructor(p) { this.path = p; } }

function loadModule(relPath, extra = {}) {
  const { source, sourcePath } = transpile(relPath);
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, console, Map, Set, WeakMap, WeakSet, Date, Promise,
    TextEncoder, TextDecoder, URLSearchParams, crypto: globalThis.crypto,
    window: { setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop },
    sleep: async () => undefined,
    WebSocket: { OPEN: 1 },
    require: (id) => {
      if (id === "obsidian") return { normalizePath: (x) => x, TFile: ScanTFile, TFolder: ScanTFolder, Platform: { isMobile: false } };
      if (id.includes("helpers")) return helpersStub;
      if (id.includes("sync_log_manager")) return { SyncLogManager: { getInstance: () => logManager } };
      if (id.includes("i18n")) return { $: (key, params) => `${key}:${JSON.stringify(params ?? {})}` };
      if (id.includes("baseline_scope")) return {
        buildBaselineFields: () => ({}), buildDeleteBaselineFields: () => ({}),
        baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope",
        parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }),
        serializeScopedState: (state) => JSON.stringify(state),
      };
      if (id.includes("conflict_store")) return {
        storeSyncConflict: async () => false, normalizeConflict: () => null,
        conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "",
      };
      if (id in extra) return extra[id];
      return {};
    },
  }, { filename: sourcePath });
  return module.exports;
}

const { SyncState } = loadModule("src/lib/sync/sync_state.ts");
// Real guard module so the read-only + mass-disappearance regression exercises the actual decision.
const { evaluateMassDeleteGuard } = loadModule("src/lib/sync/mass_delete_guard.ts");

const operator = loadModule("src/lib/sync/operator.ts", {
  "./mass_delete_guard": { evaluateMassDeleteGuard },
  "./sync_state": { advanceLiveSyncTime: noop },
  "./operator_folder": {},
  "./operator_config": { configAllPaths: async () => [] },
  "./operator_note": {
    receiveNoteSyncEnd: async () => undefined, receiveNoteUpload: async () => undefined,
    conflictBackupPaths: () => ({ baseBackupPath: "b", remoteBackupPath: "r", metaPath: "m", localBackupPath: "l" }),
  },
  "./operator_file": { sweepStalledDownloadSessions: async () => 0, invalidateFileDownloads: noop },
  "../storage/file_cloud_preview": { FileCloudPreview: { isRestrictedType: () => true } },
  "../../views/confirm-modal": { ConfirmModal: class ConfirmModal {} },
});

const tasks = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, needConflict: 0, completed: 0, failed: 0 });

function makePlugin({
  readonly = false,
  offlineDelete = true,
  configSyncEnabled = false,
  liveFiles = [],
  trackedNotePaths = [],
  trackedFilePaths = [],
  trackedConfigPaths = [],
  baselineConfirmed = () => true,
  onSend = undefined,
} = {}) {
  const sent = [];
  const meta = new Map([
    ["lastNoteSyncTime", 10], ["lastFileSyncTime", 10],
    ["lastConfigSyncTime", 10], ["lastFolderSyncTime", 10], ["isInitSync", true],
  ]);
  const syncState = new SyncState();
  syncState.syncUpChunkNum = 1000; // single batch -> legacy stop-and-wait fast path
  const livePaths = new Set(liveFiles.map((f) => f.path));
  const plugin = {
    syncState,
    settings: {
      syncEnabled: true, configSyncEnabled, readonlySyncEnabled: readonly,
      offlineDeleteSyncEnabled: offlineDelete, isShowNotice: false, manualSyncEnabled: false,
      hashSyncLimitEnabled: false, hashSyncLimit: 50000, noteSyncLimit: 20, attachmentSyncLimit: 50,
      vault: "v1", cloudPreviewEnabled: false, cloudPreviewTypeRestricted: true,
    },
    isSyncing: false, isSyncRequesting: false, currentSyncType: "incremental", syncTypeCompleteCount: 0,
    syncRoundReadonly: false,
    expectedSyncCount: 3, totalFilesToDownload: 0, downloadedFilesCount: 0, totalChunksToDownload: 0,
    downloadedChunksCount: 0, totalChunksToUpload: 0, uploadedChunksCount: 0,
    noteSyncTasks: tasks(), fileSyncTasks: tasks(), folderSyncTasks: tasks(), configSyncTasks: tasks(),
    resetSyncTasks: function () { this.syncState.resetSession(); },
    updateStatusBar: noop,
    pendingFileRenames: [], pendingNoteRenames: new Map(),
    pendingDeleteNotePaths: new Set(), pendingDeleteFilePaths: new Set(),
    pendingDeleteFolderPaths: new Set(), pendingDeleteConfigPaths: new Set(),
    pendingNoteDeleteAcks: new Set(), pendingFileDeleteAcks: new Set(), pendingConfigDeleteAcks: new Set(),
    pendingNoteModifies: new Map(), pendingUploadHashes: new Map(), pendingConfigModifies: new Map(),
    scannedNoteHashes: new Map(), scannedFileHashes: new Map(), scannedConfigHashes: new Map(),
    fileDownloadSessions: new Map(), syncPageStateMap: new Map(),
    menuManager: { ribbonIconStatus: true }, statusBarManager: { updateConflictBadge: noop },
    concurrencyLimiter: { activeKeys: new Set(), queue: [], getSlotContext: () => null },
    progressTracker: {
      reset: noop, recordHashProgress: noop, recordUploadComplete: noop,
      isTypeFullyDone: () => true, getOverallPct: () => 100, getDetailText: () => "", forceComplete: noop,
      getActiveTypes: () => [],
    },
    localStorageManager: {
      getMetadata: (k) => meta.get(k) ?? 0, setMetadata: (k, v) => meta.set(k, v),
      savePending: noop, clearPending: noop,
      getStorageConfigs: async () => [],
    },
    fileHashManager: {
      isReady: () => true,
      getAllPaths: () => [...trackedNotePaths, ...trackedFilePaths],
      getPathHash: (p) => (livePaths.has(p) || trackedNotePaths.includes(p) || trackedFilePaths.includes(p) ? `p:${p}` : null),
      getValidHash: () => null,
      getBaselineProvenance: (p) => (baselineConfirmed(p) ? "confirmed" : "none"),
      isBaselineConfirmed: (p) => baselineConfirmed(p),
      bulkSetFromScanned: noop, setFileHashes: noop, removeFileHashes: noop, flush: noop,
    },
    configHashManager: {
      isReady: () => true,
      getAllPaths: () => trackedConfigPaths,
      getPathHash: (p) => (trackedConfigPaths.includes(p) ? `p:${p}` : null),
      getValidHash: () => null,
      isBaselineConfirmed: () => true,
      bulkSetFromScanned: noop, setFileHashes: async () => undefined, removeFileHashes: noop, flush: noop,
    },
    folderSnapshotManager: {
      isReady: () => false, getMtime: () => undefined, getAllPaths: () => [],
      isBaselineConfirmed: () => false, setFolderMtimes: noop, removeFolders: noop, flush: noop,
    },
    retryQueue: { drainBeforeSync: async () => undefined, shouldSkipScanDelete: () => false, getRecoveryPaths: () => [], completeScan: noop },
    isSyncBaselineModeEnabled: () => false,
    websocket: {
      ws: { readyState: 1, bufferedAmount: 0 }, isOpen: true,
      on: noop, off: noop,
      SendMessage: async (action, payload, _x, cb) => {
        sent.push({ action, payload });
        onSend?.(action, payload, sent);
        cb?.();
      },
    },
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: { exists: async () => false },
        getAllLoadedFiles: () => liveFiles,
        read: async (f) => `content:${f.path}`,
      },
    },
  };
  return { plugin, sent };
}

const plain = (v) => JSON.parse(JSON.stringify(v));
const payloadFor = (sent, action) => sent.find((entry) => entry.action === action)?.payload;

// ── 1. Read-only + offline delete: scanned local deletes are never reported ────
{
  const { plugin, sent } = makePlugin({
    readonly: true,
    offlineDelete: true,
    trackedNotePaths: ["gone.md"],
    trackedFilePaths: ["gone.png"],
  });
  await operator.handleSync(plugin, true);
  const noteSync = payloadFor(sent, "NoteSync");
  const fileSync = payloadFor(sent, "FileSync");
  assert.ok(noteSync, "NoteSync is still sent so the server can push remote changes");
  assert.ok(fileSync, "FileSync is still sent");
  assert.equal("delNotes" in noteSync, false, "read-only NoteSync carries no delNotes field");
  assert.equal("delFiles" in fileSync, false, "read-only FileSync carries no delFiles field");
  assert.equal(plugin.pendingDeleteNotePaths.size, 0, "no pending note delete recorded");
  assert.equal(plugin.pendingDeleteFilePaths.size, 0, "no pending file delete recorded");
}

// ── 2. Read-only: local edits are still listed as metadata but never become a baseline ──
{
  const edited = new ScanTFile("edited.md", "md", 200, 10);
  const { plugin, sent } = makePlugin({
    readonly: true, offlineDelete: true, liveFiles: [edited], trackedNotePaths: ["edited.md"],
  });
  await operator.handleSync(plugin, true);
  const noteSync = payloadFor(sent, "NoteSync");
  assert.deepEqual(plain(noteSync.notes).map((n) => n.path), ["edited.md"], "locally edited note stays in the metadata list");
  assert.equal(plugin.pendingNoteModifies.size, 0, "read-only ack must not record never-uploaded content as a baseline");
  assert.equal(plugin.pendingConfigModifies.size, 0);
}

// ── 3. handleRequestSend backstop: non-empty delete lists are stripped in read-only ──
{
  const { plugin, sent } = makePlugin({ readonly: true, offlineDelete: true, configSyncEnabled: true });
  await operator.handleRequestSend(
    plugin, "auto",
    { lastTime: 10, notes: [], delNotes: [{ path: "a.md", pathHash: "p:a.md" }], missingNotes: [], context: "c" },
    { lastTime: 10, files: [], delFiles: [{ path: "a.png", pathHash: "p:a.png" }], missingFiles: [], context: "c" },
    { lastTime: 10, configs: [], delConfigs: [{ path: ".obsidian/app.json", pathHash: "p:c" }], missingConfigs: [], context: "c" },
    { lastTime: 10, folders: [], delFolders: [], missingFolders: [], context: "c" },
    { readonly: true },
  );
  const noteSync = payloadFor(sent, "NoteSync");
  const fileSync = payloadFor(sent, "FileSync");
  const settingSync = payloadFor(sent, "SettingSync");
  assert.ok(noteSync && fileSync && settingSync, "all three sync types are sent");
  assert.equal("delNotes" in noteSync, false, "note deletes stripped");
  assert.equal("delFiles" in fileSync, false, "file deletes stripped");
  assert.equal("delSettings" in settingSync, false, "config deletes stripped");
  assert.equal(plugin.pendingDeleteNotePaths.size, 0);
  assert.equal(plugin.pendingDeleteFilePaths.size, 0);
  assert.equal(plugin.pendingDeleteConfigPaths.size, 0);

  // 6-argument call (no opts) still falls back to the live setting (existing tests call this way)
  const { plugin: fallback, sent: fallbackSent } = makePlugin({ readonly: true, offlineDelete: true });
  await operator.handleRequestSend(
    fallback, "note",
    { lastTime: 10, notes: [], delNotes: [{ path: "b.md", pathHash: "p:b.md" }], missingNotes: [], context: "c" },
    { lastTime: 10, files: [], delFiles: [], missingFiles: [], context: "c" },
    { lastTime: 10, configs: [], delConfigs: [], missingConfigs: [], context: "c" },
    { lastTime: 10, folders: [], delFolders: [], missingFolders: [], context: "c" },
  );
  assert.equal("delNotes" in payloadFor(fallbackSent, "NoteSync"), false, "default opts falls back to settings.readonlySyncEnabled");
}

// ── 4. Non-read-only control: deletes are sent and pending baselines are recorded ──
{
  const edited = new ScanTFile("edited.md", "md", 200, 10);
  const { plugin, sent } = makePlugin({
    readonly: false, offlineDelete: true, liveFiles: [edited],
    trackedNotePaths: ["gone.md", "edited.md"], trackedFilePaths: ["gone.png"],
  });
  await operator.handleSync(plugin, true);
  const noteSync = payloadFor(sent, "NoteSync");
  const fileSync = payloadFor(sent, "FileSync");
  assert.deepEqual(plain(noteSync.delNotes).map((n) => n.path), ["gone.md"]);
  assert.deepEqual(plain(fileSync.delFiles).map((n) => n.path), ["gone.png"]);
  assert.equal(plugin.pendingDeleteNotePaths.has("gone.md"), true, "normal mode records the pending note delete");
  assert.equal(plugin.pendingDeleteFilePaths.has("gone.png"), true, "normal mode records the pending file delete");
  assert.equal(plugin.pendingNoteModifies.get("edited.md"), "h:content:edited.md", "normal mode records the uploaded-hash baseline");
}

// ── 5. Round snapshot: flipping read-only mid-send does not split the round ─────
{
  // Round starts writable; the first send flips the toggle to read-only. The scan already queued
  // the local deletes, and the send phase must keep using the entry value (writable) throughout.
  const { plugin, sent } = makePlugin({
    readonly: false, offlineDelete: true,
    trackedNotePaths: ["gone.md"], trackedFilePaths: ["gone.png"],
    onSend: (action) => {
      if (action === "FolderSync") plugin.settings.readonlySyncEnabled = true;
    },
  });
  await operator.handleSync(plugin, true);
  const noteSync = payloadFor(sent, "NoteSync");
  const fileSync = payloadFor(sent, "FileSync");
  assert.deepEqual(plain(noteSync.delNotes).map((n) => n.path), ["gone.md"], "later NoteSync still uses the entry snapshot");
  assert.deepEqual(plain(fileSync.delFiles).map((n) => n.path), ["gone.png"], "later FileSync still uses the entry snapshot");
  assert.equal(plugin.pendingDeleteNotePaths.has("gone.md"), true, "pending set follows the snapshot, not the flipped setting");
  assert.equal(plugin.settings.readonlySyncEnabled, true, "the toggle really was flipped mid-round");
}

// ── 6. Read-only + mass-disappearance guard both take effect ───────────────────
{
  const tracked = Array.from({ length: 200 }, (_, i) => `notes/n${i}.md`);
  const live = [new ScanTFile(tracked[0], "md", 200, 10)];
  const { plugin, sent } = makePlugin({
    readonly: true, offlineDelete: true, liveFiles: live, trackedNotePaths: tracked,
  });
  notices.length = 0;
  logs.length = 0;
  await operator.handleSync(plugin, true);
  const noteSync = payloadFor(sent, "NoteSync");
  assert.equal("delNotes" in noteSync, false, "read-only never reports the mass disappearance as deletes");
  const guardLogs = logs.filter((entry) => entry.action === "MassDeleteGuard");
  assert.equal(guardLogs.length, 1, "the guard still evaluates and logs in read-only mode");
  assert.equal(guardLogs[0].status, "error");
  assert.equal(notices.filter((n) => n.includes("ui.notice.mass_delete_guard")).length, 1, "the user is still warned");
  assert.equal(plugin.syncState.truncatedSyncFields.has("lastNoteSyncTime"), true, "note cursor is held");
  assert.equal(plugin.syncState.truncatedSyncFields.has("lastFileSyncTime"), true, "file cursor is held");
}

// ── 7. Round snapshot lifecycle: published at entry, cleared when the round ends ──
{
  let pluginRef;
  const observed = [];
  const made = makePlugin({
    readonly: true, offlineDelete: true,
    onSend: () => observed.push(pluginRef.syncRoundReadonly),
  });
  pluginRef = made.plugin;
  await operator.handleSync(made.plugin, true);
  assert.ok(observed.length > 0, "at least one sync type was sent");
  assert.ok(observed.every((v) => v === true), "the send phase sees the entry read-only snapshot");
  assert.equal(made.plugin.syncRoundReadonly, true, "snapshot stays published while the round is active");
  operator.checkSyncCompletion(made.plugin);
  assert.equal(made.plugin.syncRoundReadonly, false, "round completion clears the snapshot");
}

console.log("read-only note/file/config sync tests passed");
