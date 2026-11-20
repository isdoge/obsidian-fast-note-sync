import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// P0-01: conflicts are delivered through the same paged flow as every other SyncEnd category.
// `needConflictCount` must therefore be part of the authoritative download total:
// - a conflict-only round must still send the initial PageAck(-1) and pull every conflict;
// - a mixed round (50 modifies + 5 conflicts) must not finish before the conflict page lands.
const root = path.resolve(import.meta.dirname, '..');

const noop = () => {};
class MockFile {}
class MockFolder {}
const helpers = {
  dump: noop, dumpError: noop, isPathExcluded: () => false, isFolderSyncPathExcluded: () => false,
  configIsPathExcluded: () => false, getConfigSyncCustomDirs: () => [],
  hashContent: x => `p:${x}`, hashContentAsync: async x => `h:${x}`,
  getPluginDir: () => '.plugin', showSyncNotice: noop, isLargeBinarySyncRisk: () => false,
  describeBinarySyncLimit: () => '', hashFileAsync: async () => 'f', formatFileSize: () => '',
  yieldToMain: async () => {}, checkAndNotifyCaseConflict: () => false, getSafeCtime: s => s?.ctime ?? 0,
  normalizeServerTimestamp: v => v,
};
const logs = { addLog: noop, addOrUpdateLog: noop, logReceivedMessage: noop };

function load(file, extra = {}, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Map, Set, Date, Promise,
    window: { setTimeout: () => 1, clearTimeout: noop, clearInterval: noop, setInterval: () => 1 },
    WebSocket: { OPEN: 1 },
    ...globals,
    require: id => extra[id] ?? (id === 'obsidian'
      ? { normalizePath: x => x, TFile: MockFile, TFolder: MockFolder, Platform: { isMobile: false } }
      : id.includes('helpers') ? helpers
      : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => logs } }
      : id.includes('i18n') ? { $: key => key }
      : id.includes('baseline_scope') ? {
        buildBaselineFields: () => ({}), buildDeleteBaselineFields: () => ({}),
        baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => 'scope',
        parseScopedState: () => ({ state: { scope: 'scope', revisions: {}, pendingDeletes: {} }, scopeChanged: false }),
        serializeScopedState: s => JSON.stringify(s),
      }
      : id.includes('conflict_store') ? {
        storeSyncConflict: async () => true, normalizeConflict: () => null,
        conflictKindToSyncType: () => 'note', conflictReasonLabel: () => '', conflictKindLabel: () => '',
      }
      : {}),
  });
  return module.exports;
}

const { SyncProgressTracker } = load('src/lib/sync/sync_progress_tracker.ts');
// WSAction 只需按名字返回动作字符串，Map 的键才有区分度
// WSAction only needs to echo the action name so the operator Map has distinct keys
const actions = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? key : undefined) });
const endStub = { receiveNoteSyncEnd: async () => {}, receiveFileSyncEnd: async () => {},
  receiveConfigSyncEnd: async () => {}, receiveFolderSyncEnd: async () => {} };
const op = load('src/lib/sync/operator.ts', {
  './websocket_action': actions,
  './operator_note': endStub,
  './operator_file': { ...endStub, sweepStalledDownloadSessions: async () => 0 },
  './operator_folder': endStub,
  './operator_config': endStub,
});
const endHandler = op.receiveOperators.get('NoteSyncEnd');
assert.ok(endHandler, 'NoteSyncEnd handler is registered');

/** 最小插件骨架：真实进度追踪器 + 可观测的 PageAck 发送 */
function makePlugin() {
  const acks = [];
  const tasks = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, needConflict: 0, completed: 0, failed: 0 });
  const tracker = new SyncProgressTracker();
  tracker.reset(['note']);
  tracker.onPageComplete = (type, pageIndex) => acks.push([type, pageIndex]);
  const plugin = {
    settings: { syncEnabled: true, configSyncEnabled: true, vault: 'v', isShowNotice: false },
    app: { vault: { getFileByPath: () => null, getAbstractFileByPath: () => null, adapter: { exists: async () => false } } },
    syncState: {
      activeSyncContext: 'ctx', syncDownChunkNum: 50, negotiated: true,
      pendingSyncEndTime: new Map(), syncTimeBaseline: new Map(),
      offlineGuardSkippedThisRound: false, newConflictedPathsThisRound: new Set(),
      pendingNotePushPageIndex: new Map(), pendingFilePushPageIndex: new Map(), pendingConfigPushPageIndex: new Map(),
      conflictedPaths: new Set(), conflictCountsThisRound: new Map(),
      pendingDeleteFilePaths: new Set(), pendingDeleteFolderPaths: new Set(), pendingDeleteConfigPaths: new Set(),
      pendingUploadHashes: new Map(), pendingConfigModifies: new Map(),
    },
    progressTracker: tracker,
    noteSyncTasks: tasks(), fileSyncTasks: tasks(), configSyncTasks: tasks(), folderSyncTasks: tasks(),
    pendingDeleteNotePaths: new Set(), pendingNoteModifies: new Map(),
    scannedNoteHashes: new Map(), scannedFileHashes: new Map(), scannedConfigHashes: new Map(),
    pendingUploadHashes: new Map(), pendingDeleteFilePaths: new Set(), pendingDeleteFolderPaths: new Set(),
    pendingDeleteConfigPaths: new Set(), pendingConfigModifies: new Map(),
    configHashManager: { isReady: () => true, removeFileHashes: noop, setFileHashes: async () => {}, bulkSetFromScanned: noop, flush: noop },
    folderSnapshotManager: { removeFolders: noop, flush: noop },
    fileHashManager: { removeFileHashes: noop, setFileHashes: noop, bulkSetFromScanned: noop, flush: noop },
    localStorageManager: { getMetadata: () => 0, setMetadata: noop, clearPending: noop, savePending: noop },
    syncPageStateMap: new Map(),
    sendSyncPageAck: (type, pageIndex) => acks.push([type, pageIndex]),
    recordSyncCompleted: (type, pageIndex) => tracker.recordCompleted(type, pageIndex),
    isSyncBaselineModeEnabled: () => true,
    noteSyncEnd: false,
  };
  return { plugin, tracker, acks };
}

const pageMsg = (plugin, pageIndex, totalCount, isLast) => {
  plugin.syncPageStateMap.set('note', { pageIndex, pageSize: 50, totalCount, isLast, completedCount: 0, context: 'ctx' });
  plugin.progressTracker.recordPageProgress('note', pageIndex, totalCount, isLast, true);
};

// 1. Conflict-only round: 3 conflicts, nothing else. The total must be 3 (not 0) so the initial
//    PageAck(-1) is sent and the conflict page is pulled instead of finishing on an empty round.
{
  const { plugin, tracker, acks } = makePlugin();
  await endHandler({ lastTime: 900, needUploadCount: 0, needModifyCount: 0, needSyncMtimeCount: 0, needDeleteCount: 0, needConflictCount: 3 }, plugin);
  assert.equal(tracker.getTypeTaskTotal('note'), 3, 'conflict-only round counts the conflicts in the download total');
  assert.equal(plugin.noteSyncTasks.needConflict, 3, 'needConflict is recorded on the task stats');
  assert.deepEqual(acks, [['note', -1]], 'a conflict-only round still sends the initial PageAck(-1)');
}

// 2. Mixed round: 50 modifies + 5 conflicts spans two pages. The type must not be "done" until the
//    conflict page's 5 items are processed, and the first page's ack must be sent on completion.
{
  const { plugin, tracker, acks } = makePlugin();
  await endHandler({ lastTime: 900, needUploadCount: 0, needModifyCount: 50, needSyncMtimeCount: 0, needDeleteCount: 0, needConflictCount: 5 }, plugin);
  assert.equal(tracker.getTypeTaskTotal('note'), 55, 'the download total is 55, not 50');
  assert.deepEqual(acks, [['note', -1]], 'initial ACK still sent');

  pageMsg(plugin, 0, 50, false);
  pageMsg(plugin, 1, 5, true);
  for (let i = 0; i < 50; i++) plugin.recordSyncCompleted('note', 0);
  assert.equal(tracker.isTypeFullyDone('note'), false, 'the round is not done before the conflict page is processed');
  assert.deepEqual(acks, [['note', -1], ['note', 0]], 'page 0 is acked once fully processed');

  for (let i = 0; i < 5; i++) plugin.recordSyncCompleted('note', 1);
  assert.equal(tracker.isTypeFullyDone('note'), true, 'the round completes only after all 55 items (incl. conflicts)');
}

// 3. Regression guard: without any conflict the total is unchanged.
{
  const { plugin, tracker, acks } = makePlugin();
  await endHandler({ lastTime: 900, needUploadCount: 0, needModifyCount: 4, needSyncMtimeCount: 0, needDeleteCount: 0 }, plugin);
  assert.equal(tracker.getTypeTaskTotal('note'), 4, 'a conflict-free round keeps its own total');
  assert.equal(plugin.noteSyncTasks.needConflict, 0, 'missing needConflictCount defaults to 0');
  assert.deepEqual(acks, [['note', -1]]);
}

console.log('PASS: needConflictCount is part of the download total (conflict-only and mixed paged rounds)');
