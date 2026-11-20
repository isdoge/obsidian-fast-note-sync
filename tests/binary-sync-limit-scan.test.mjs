import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const noop = () => {};
class TFile {
  constructor(filePath, ext, size, mtime = 200) {
    this.path = filePath;
    this.extension = ext;
    this.stat = { mtime, ctime: mtime, size };
  }
}
class TFolder {}

const dumps = [];

const transpileAndRun = (relPath, customRequire) => {
  const absPath = path.join(repoRoot, relPath);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(absPath, 'utf8'), {
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

const realHelpers = transpileAndRun('src/lib/utils/helpers.ts', (id) => {
  if (id.includes("baseline_scope")) return { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) };
  if (id.includes("conflict_store")) return { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" };
  if (id === 'obsidian') {
    return { Notice: class {}, normalizePath: x => x, TFolder, Platform: { isMobile: false } };
  }
  if (id.includes('i18n')) {
    return { $: k => k };
  }
  if (id.includes('sync_log_manager')) {
    return { SyncLogManager: { getInstance: () => ({ addLog: noop }) } };
  }
  if (id.includes('helpers_obsidian_bypass')) {
    return {
      nativeFetch: noop,
      vaultDelete: noop,
      dump: (...args) => dumps.push(args),
      dumpError: noop,
      setLogEnabled: noop,
      logLevel: 'off',
    };
  }
  return {};
});

const { SyncState } = transpileAndRun('src/lib/sync/sync_state.ts', () => ({}));
const op = transpileAndRun('src/lib/sync/operator.ts', (id) => {
  if (id.includes("baseline_scope")) return { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) };
  if (id.includes("conflict_store")) return { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" };
  if (id === 'obsidian') {
    return { normalizePath: x => x, TFile, TFolder, Platform: {} };
  }
  if (id.includes('helpers')) {
    return {
      ...realHelpers,
      dump: (...args) => dumps.push(args),
      dumpError: noop,
      isPathExcluded: () => false,
      isFolderSyncPathExcluded: () => false,
      configIsPathExcluded: () => false,
      getConfigSyncCustomDirs: () => [],
      generateUUID: () => 'ctx-1',
      showSyncNotice: noop,
      hashContent: x => `ph_${x}`,
      hashContentAsync: async x => `ch_${x}`,
      hashFileAsync: async (_app, p) => `fh_${p}`,
      yieldToMain: async () => {},
      getPluginDir: () => '.obsidian/plugins/fast-note-sync',
    };
  }
  if (id.includes('sync_log_manager')) {
    return {
      SyncLogManager: {
        getInstance: () => ({ addOrUpdateLog: noop, addLog: noop }),
      },
    };
  }
  if (id.includes('i18n')) {
    return { $: k => k };
  }
  if (id === './operator_file') {
    return { sweepStalledDownloadSessions: async () => 0, invalidateFileDownloads: noop };
  }
  if (id === './operator_config') {
    return { configAllPaths: async () => [] };
  }
  if (
    id === './operator_note' ||
    id === './operator_folder' ||
    id === '../storage/file_cloud_preview' ||
    id.includes('websocket_action') ||
    id.includes('confirm-modal') ||
    id.includes('sync_progress_tracker')
  ) {
    return {};
  }
  return {};
});

const tasks = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 });

function mkPlugin(fileList, settingsOverride = {}) {
  const meta = new Map([
    ['lastNoteSyncTime', 0],
    ['lastFileSyncTime', 0],
    ['lastFolderSyncTime', 0],
    ['lastConfigSyncTime', 0],
    ['isInitSync', true],
  ]);
  const sentActions = [];
  const syncState = new SyncState();
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
      vault: 'v1',
      offlineDeleteSyncEnabled: false,
      readonlySyncEnabled: false,
      cloudPreviewEnabled: false,
      ...settingsOverride,
    },
    isSyncing: false,
    isSyncRequesting: false,
    currentSyncType: 'full',
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
      getDetailText: () => '',
      forceComplete: noop,
    },
    localStorageManager: {
      getMetadata: k => meta.get(k) ?? 0,
      setMetadata: (k, v) => meta.set(k, v),
      savePending: noop,
    },
    fileHashManager: {
      getPathHash: () => null,
      getValidHash: () => null,
      bulkSetFromScanned: noop,
    },
    folderSnapshotManager: {
      getMtime: () => undefined,
      isReady: () => false,
    },
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
        configDir: '.obsidian',
        adapter: { exists: async () => false },
        getAllLoadedFiles: () => fileList,
        read: async (f) => `content:${f.path}`,
      },
    },
  };
  return plugin;
}

const getReportedFilePaths = (plugin) =>
  plugin.sentActions
    .filter(a => a.action === 'FileSync')
    .flatMap(a => (a.payload.files || []).map(f => f.path));

const MB = 1024 * 1024;

// 1. 开关关闭 + 附件超过上限 -> 扫描会上报这个附件
{
  dumps.length = 0;
  const p = mkPlugin([new TFile('large-disabled.bin', 'bin', 15 * MB)], {
    binarySyncLimitEnabled: false,
    attachmentSyncLimit: 10,
  });
  await op.handleSync(p, false);
  const reported = getReportedFilePaths(p);
  assert.deepEqual(reported, ['large-disabled.bin'], 'limit disabled: oversized attachment must be reported');
}

// 2. 开关开启 + 附件超过上限 -> 跳过，且有调试日志（含路径与大小）
{
  dumps.length = 0;
  const p = mkPlugin([new TFile('large-enabled.bin', 'bin', 15 * MB)], {
    binarySyncLimitEnabled: true,
    attachmentSyncLimit: 10,
  });
  await op.handleSync(p, false);
  const reported = getReportedFilePaths(p);
  assert.deepEqual(reported, [], 'limit enabled: oversized attachment must be skipped');
  assert.ok(
    dumps.some(args => String(args[0]).includes('large-enabled.bin') && args[1] === 15 * MB),
    'limit enabled: skipping attachment must emit debug log with path and size',
  );
}

// 3. 开关开启 + 附件未超上限（含恰好等于上限）-> 上报
{
  dumps.length = 0;
  const p = mkPlugin(
    [
      new TFile('under-limit.bin', 'bin', 5 * MB),
      new TFile('exact-limit.bin', 'bin', 10 * MB),
    ],
    {
      binarySyncLimitEnabled: true,
      attachmentSyncLimit: 10,
    },
  );
  await op.handleSync(p, false);
  const reported = getReportedFilePaths(p);
  assert.deepEqual(reported, ['under-limit.bin', 'exact-limit.bin'], 'limit enabled: attachments <= limit must be reported');
}

// 4. 开关关闭 + 未设置 attachmentSyncLimit（走默认值 50MB）+ 附件超过 50MB -> 上报
{
  dumps.length = 0;
  const p = mkPlugin([new TFile('over-default-50m.bin', 'bin', 64 * MB)], {
    binarySyncLimitEnabled: false,
    attachmentSyncLimit: undefined,
  });
  await op.handleSync(p, false);
  const reported = getReportedFilePaths(p);
  assert.deepEqual(reported, ['over-default-50m.bin'], 'limit disabled + undefined attachmentSyncLimit: >50MB attachment must be reported');
}

console.log('binary sync limit scan tests passed');
