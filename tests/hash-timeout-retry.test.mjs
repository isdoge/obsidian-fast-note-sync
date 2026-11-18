import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const noop = () => {};
class TFile {
  constructor(path, ext, mtime = 200, size = 10) {
    this.path = path;
    this.extension = ext;
    this.stat = { mtime, ctime: mtime, size };
  }
}
class TFolder {}

const timers = [];
let blocked = true;
const notices = [];
const logs = [];

const load = (file, extra = {}) => {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    console,
    WebSocket: { OPEN: 1 },
    sleep: async () => {},
    window: { setTimeout: (fn, ms) => { if (ms === 15000) timers.push(fn); return 1; }, clearTimeout: noop, clearInterval: noop },
    require: (id) => {
      if (id === 'obsidian') {
        return { normalizePath: x => x, TFile, TFolder, Platform: {} };
      }
      if (id.includes('helpers')) {
        return {
          dump: noop,
          dumpError: noop,
          isPathExcluded: () => false,
          isFolderSyncPathExcluded: () => false,
          configIsPathExcluded: () => false,
          getConfigSyncCustomDirs: () => [],
          generateUUID: () => 'ctx-1',
          showSyncNotice: (msg) => notices.push(msg),
          isLargeBinarySyncRisk: () => false,
          describeBinarySyncLimit: () => '100MB',
          hashContent: x => `ph_${x}`,
          hashContentAsync: async x => `ch_${x}`,
          hashFileAsync: async (_app, p) => blocked && p.startsWith("slow") ? new Promise(() => {}) : `fh_${p}`,
          formatFileSize: n => `${n}B`,
          yieldToMain: async () => {},
          getPluginDir: () => '.obsidian/plugins/fast-note-sync',
        };
      }
      if (id.includes('sync_log_manager')) {
        return {
          SyncLogManager: {
            getInstance: () => ({
              addOrUpdateLog: noop,
              addLog: (type, action, message, status) => logs.push({ type, action, message, status }),
            }),
          },
        };
      }
      if (id.includes('i18n')) {
        return { $: (k, params) => `${k}:${JSON.stringify(params ?? {})}` };
      }
      if (id === './operator_file') {
        return { sweepStalledDownloadSessions: async () => 0, invalidateFileDownloads: noop };
      }
      if (id === './operator_config') {
        return { configAllPaths: async () => [] };
      }
      if (id === './operator_note' || id === './operator_folder' || id === '../storage/file_cloud_preview' || id.includes('websocket_action') || id.includes('confirm-modal') || id.includes('sync_progress_tracker')) {
        return {};
      }
      return extra[id] || {};
    },
  });
  return module.exports;
};

const { SyncState } = load('src/lib/sync/sync_state.ts');
const op = load('src/lib/sync/operator.ts');

const tasks = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 });
function mkPlugin(fileList, hashSyncLimit = 2) {
  const meta = new Map([
    ['lastNoteSyncTime', 100],
    ['lastFileSyncTime', 100],
    ['lastFolderSyncTime', 100],
    ['lastConfigSyncTime', 100],
    ['isInitSync', true],
  ]);
  const done = { note: false, file: false, folder: false, setting: false };
  const syncState = new SyncState();
  const cachedNotes = new Map();
  const sentActions = [];
  const plugin = {
    meta,
    done,
    sentActions,
    syncState,
    settings: {
      syncEnabled: true,
      configSyncEnabled: false,
      isShowNotice: true,
      hashSyncLimitEnabled: true,
      hashSyncLimit,
      noteSyncLimit: 20,
      attachmentSyncLimit: 50,
      vault: 'v1',
      offlineDeleteSyncEnabled: false,
      readonlySyncEnabled: false,
      cloudPreviewEnabled: false,
    },
    isSyncing: false,
    isSyncRequesting: false,
    currentSyncType: 'incremental',
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
      isTypeFullyDone: t => done[t],
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
      getValidHash: (p) => cachedNotes.get(p) ?? null,
      bulkSetFromScanned: (m) => {
        for (const [k, v] of m.entries()) cachedNotes.set(k, v.hash);
      },
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

for (const extensions of [['md'], ['png'], ['md', 'png']]) {
  notices.length = 0; timers.length = 0; blocked = true;
  const files = extensions.map(ext => new TFile(`slow.${ext}`, ext));
  const p = mkPlugin(files, 0);
  p.app.vault.read = async f => blocked && f.path.startsWith('slow') ? new Promise(() => {}) : 'ok';
  p.resetSyncTasks = () => p.syncState.resetSession();
  const running = op.handleSync(p, true);
  await new Promise(setImmediate);
  assert.equal(timers.length, files.length, 'one timeout starts per uncached file');
  for (const fn of timers.splice(0)) fn();
  await running;
  for (const field of ['lastNoteSyncTime', 'lastFileSyncTime']) p.syncState.pendingSyncEndTime.set(field, 900);
  p.done.note = p.done.file = true;
  op.settleSyncTimes(p);
  assert.equal(p.meta.get('lastNoteSyncTime'), extensions.includes('md') ? 100 : 900, 'note cursor holds only for note timeout');
  assert.equal(p.meta.get('lastFileSyncTime'), extensions.includes('png') ? 100 : 900, 'file cursor holds only for attachment timeout');
  assert.equal(notices.filter(n => n.includes('hash_timeout')).length, 0, 'notice waits until round completion');
  p.done.folder = true;
  p.isSyncRequesting = false;
  op.checkSyncCompletion(p);
  const timeoutNotices = notices.filter(n => n.includes('ui.notice.hash_timeout'));
  assert.equal(timeoutNotices.length, 1, 'one timeout notice at round end');
  assert.ok(timeoutNotices[0].includes(`"count":"${files.length}"`), 'notice gives total timeout count');
  assert.equal(notices.filter(n => n.includes('hash_limit_exceeded')).length, 0, 'timeout is not a hash-limit warning');
  assert.equal(p.syncState.hasSyncedThisConnection, false, 'live cursor stays frozen until clean retry');
  // 下一轮重试之前未缓存的超时文件，成功后该类型游标可以正常推进。
  blocked = false;
  for (const type of ['note','file','folder']) p.done[type] = false;
  await op.handleSync(p, true);
  for (const field of ['lastNoteSyncTime', 'lastFileSyncTime']) p.syncState.pendingSyncEndTime.set(field, 1200);
  p.done.note = p.done.file = true;
  op.settleSyncTimes(p);
  assert.equal(p.meta.get('lastNoteSyncTime'), 1200);
  assert.equal(p.meta.get('lastFileSyncTime'), 1200);
}
for (const lang of ['en','zh-CN','zh-TW','ja','ko']) {
  const source = fs.readFileSync(`src/i18n/locales/${lang}.ts`, 'utf8');
  assert.match(source, /"ui.notice.hash_timeout".*\$\{count\}/, `${lang}: translated notice includes count`);
}
console.log('PASS: note/file hash timeouts hold affected cursors, notify once at round end, and retry next round');
