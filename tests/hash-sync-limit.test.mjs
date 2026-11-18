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
    window: { setTimeout: () => 1, clearTimeout: noop, clearInterval: noop },
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
          hashFileAsync: async (_app, p) => `fh_${p}`,
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

// 1. 超过 hashSyncLimit 时：必须提示 Notice + 记录日志，且受影响类型的游标不得推进
{
  notices.length = 0;
  logs.length = 0;
  const files = [
    new TFile('a.md', 'md'),
    new TFile('b.md', 'md'),
    new TFile('c.md', 'md'),
  ];
  const p = mkPlugin(files, 2);
  await op.handleSync(p, true);

  const limitNotices = notices.filter(m => m.includes('ui.notice.hash_limit_exceeded'));
  assert.equal(limitNotices.length, 1, 'truncated scan must show one hash-limit notice');
  assert.ok(limitNotices[0].includes('"skipped":"1"') && limitNotices[0].includes('"limit":"2"'), 'notice includes skipped and limit');
  assert.ok(logs.some(l => l.action === 'HashLimitExceeded' && l.status === 'error'), 'truncated scan adds HashLimitExceeded log');

  // 模拟服务端下发 End(lastTime=900) 并完成所有已发任务
  p.syncState.pendingSyncEndTime.set('lastNoteSyncTime', 900);
  p.syncState.pendingSyncEndTime.set('lastFileSyncTime', 900);
  p.done.note = true;
  p.done.file = true;
  op.settleSyncTimes(p);

  assert.equal(p.meta.get('lastNoteSyncTime'), 100, 'truncated note type must NOT advance lastNoteSyncTime');
  assert.equal(p.meta.get('lastFileSyncTime'), 900, 'non-truncated file type still advances normally');

  // 下一轮：前 2 篇已有缓存不再消耗预算，第 3 篇顺利计算且无截断 -> 游标正常推进
  notices.length = 0;
  logs.length = 0;
  p.done.note = false;
  p.isSyncing = false;
  await op.handleSync(p, true);
  assert.equal(notices.filter(m => m.includes('ui.notice.hash_limit_exceeded')).length, 0, 'no truncation on second round');
  p.syncState.pendingSyncEndTime.set('lastNoteSyncTime', 1200);
  p.done.note = true;
  op.settleSyncTimes(p);
  assert.equal(p.meta.get('lastNoteSyncTime'), 1200, 'clean second round advances lastNoteSyncTime');
}

// 1b. 附件超过 hashSyncLimit 时同样提示且阻止 lastFileSyncTime 推进
{
  notices.length = 0;
  logs.length = 0;
  const files = [
    new TFile('img1.png', 'png'),
    new TFile('img2.png', 'png'),
  ];
  const p = mkPlugin(files, 1);
  await op.handleSync(p, true);
  const limitNotices = notices.filter(m => m.includes('ui.notice.hash_limit_exceeded'));
  assert.equal(limitNotices.length, 1, 'truncated attachment scan must show notice');
  p.syncState.pendingSyncEndTime.set('lastNoteSyncTime', 950);
  p.syncState.pendingSyncEndTime.set('lastFileSyncTime', 950);
  p.done.note = true;
  p.done.file = true;
  op.settleSyncTimes(p);
  assert.equal(p.meta.get('lastFileSyncTime'), 100, 'truncated file type must NOT advance lastFileSyncTime');
  assert.equal(p.meta.get('lastNoteSyncTime'), 950, 'non-truncated note type still advances normally');
}

// 1c. 上限填 0 视为不限制：不截断、不提示，游标正常推进
{
  notices.length = 0;
  logs.length = 0;
  const files = [new TFile('x.md', 'md'), new TFile('y.md', 'md'), new TFile('z.md', 'md')];
  const p = mkPlugin(files, 0);
  await op.handleSync(p, true);
  assert.equal(notices.filter(m => m.includes('ui.notice.hash_limit_exceeded')).length, 0, 'limit 0 means unlimited: no notice');
  p.syncState.pendingSyncEndTime.set('lastNoteSyncTime', 800);
  p.done.note = true;
  op.settleSyncTimes(p);
  assert.equal(p.meta.get('lastNoteSyncTime'), 800, 'limit 0 does not block lastNoteSyncTime');
}

// 2. 设置页与所有语言文案中的默认值必须与 DEFAULT_SETTINGS.hashSyncLimit (50000) 一致
{
  const settingSrc = fs.readFileSync('src/setting.tsx', 'utf8');
  assert.ok(!settingSrc.includes('.setPlaceholder("20000")'), 'setting placeholder must not be 20000');
  assert.ok(!settingSrc.includes('hashSyncLimit ?? 20000'), 'setting fallback must not be 20000');
  const operatorSrc = fs.readFileSync('src/lib/sync/operator.ts', 'utf8');
  assert.ok(!operatorSrc.includes('hashSyncLimit ?? 20000'), 'operator fallback must not be 20000');

  for (const file of ['en.ts', 'zh-CN.ts', 'zh-TW.ts', 'ja.ts', 'ko.ts']) {
    const content = fs.readFileSync(`src/i18n/locales/${file}`, 'utf8');
    assert.ok(content.includes('50000'), `${file}: hash_limit_desc must state 50000`);
    assert.ok(!content.includes('20000'), `${file}: stale 20000 default must be removed`);
    assert.ok(content.includes('"ui.notice.hash_limit_exceeded"'), `${file}: missing ui.notice.hash_limit_exceeded`);
    assert.ok(content.includes('"ui.log.action.HashLimitExceeded"'), `${file}: missing ui.log.action.HashLimitExceeded`);
  }
}

console.log('hash sync limit tests passed');
