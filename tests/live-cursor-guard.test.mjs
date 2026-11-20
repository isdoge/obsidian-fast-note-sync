import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// service#101：单条消息/单条 Ack 不再直接推进同步游标。
// 统一入口 advanceLiveSyncTime（真实加载 sync_state.ts）：轮次进行中不落盘；本连接未完成
// 过一轮正常同步（含手动同步模式）不落盘；空闲在线且处理成功才单调推进。
// receiveConfigSyncEnd 改为无条件暂存（纯上行一轮后游标仍前进，不再卡 0 触发 isCover）。
// checkSyncCompletion 正常完成一轮置 hasSyncedThisConnection=true。
const noop = () => {};
class MockFile { constructor(p) { this.path = p; this.stat = { size: 1, mtime: 1, ctime: 1 }; } }
const helpers = { dump: noop, dumpError: noop, isPathExcluded: () => false,
  isFolderSyncPathExcluded: () => false, configIsPathExcluded: () => false,
  isPathInConfigSyncDirs: () => true, waitForFolderEmpty: async () => true,
  checkAndNotifyCaseConflict: () => false, isLargeBinarySyncRisk: () => false,
  hashContent: x => x, hashContentAsync: async x => x, hashFileAsync: async () => 'h',
  hashArrayBuffer: async () => 'h', normalizeServerTimestamp: t => t,
  getPluginDir: () => '.plugin', showSyncNotice: noop, sleep: async () => {},
  getSafeCtime: () => 1, isInWhitelist: () => false, logMemorySnapshot: noop,
  formatFileSize: () => '', yieldToMain: async () => {} };
const logs = { addLog: noop, addOrUpdateLog: noop, logReceivedMessage: noop, logSentMessage: noop };
function load(file, extra = {}, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, Map, Set, JSON,
    window: { setTimeout: fn => { fn(); return 1; }, clearTimeout: noop },
    ...globals,
    require: id => id === 'obsidian' ? { TFile: MockFile, TFolder: class { constructor(p) { this.path = p; this.children = []; } }, normalizePath: x => x, Platform: { isMobile: false } }
      : id.includes('helpers_obsidian_bypass') ? { ...helpers, vaultDelete: async () => {} }
      : id.includes('helpers') ? { ...helpers, vaultDelete: async () => {} }
      : id.includes('config_codec') ? {
          encodeConfigContent: () => '',
          decodeConfigContent: s => ({ kind: 'text', text: s }),
        }
      : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => logs } }
      : id.includes('remote_path_guard') ? { blockAliasedRemoteMutation: () => false }
      : id.includes('remote_delete_guard') ? { firstKeepWithoutBaseline: () => false }
      : id.includes('i18n') ? { $: k => k }
      : extra[id] || {} });
  return module.exports;
}
const syncState = load('src/lib/sync/sync_state.ts');
const noteOps = load('src/lib/sync/operator_note.ts', { './sync_state': syncState });
const folderOps = load('src/lib/sync/operator_folder.ts', { './sync_state': syncState });
const configOps = load('src/lib/sync/operator_config.ts', { './sync_state': syncState });
const { settleSyncTimes } = load('src/lib/sync/operator.ts', {
  './operator_note': noteOps, './operator_folder': folderOps, './operator_config': configOps,
  './operator_file': { sweepStalledDownloadSessions: async () => 0 },
  '../../i18n/lang': { $: k => k },
}, { WebSocket: { OPEN: 1 } });

function makePlugin({ isSyncing = false, activeContext = null, hasSynced = false, cursor = {} } = {}) {
  const store = new Map(Object.entries(cursor));
  const p = {
    settings: { syncEnabled: true, configSyncEnabled: true, readonlySyncEnabled: false, vault: 'v' },
    isSyncing,
    app: { vault: {
      getFileByPath: () => null, getAbstractFileByPath: () => null, getFolderByPath: () => ({}),
      createFolder: async () => {}, rename: async () => {}, read: async () => '', readBinary: async () => new ArrayBuffer(0),
      create: async () => {}, modify: async () => {}, modifyBinary: async () => {},
      adapter: { exists: async () => false, mkdir: async () => {}, stat: async () => null,
        write: async () => {}, writeBinary: async () => {}, trashLocal: async () => {} },
    }, fileManager: { trashFile: async () => {} } },
    lockManager: { withLock: async (_, fn) => fn() },
    addIgnoredFile: noop, removeIgnoredFile: noop, addIgnoredConfigFile: noop, removeIgnoredConfigFile: noop,
    ignoredConfigFiles: new Set(), manifest: { version: '1.0.0' },
    isIgnoredFile: () => false,
    lastSyncPathRenamed: new Set(), lastSyncPathDeleted: new Set(), lastSyncMtime: new Map(),
    fileDownloadSessions: new Map(), pendingNoteModifies: new Map(), pendingNoteRenames: new Map(),
    pendingFileRenames: [], pendingConfigModifies: new Map(), pendingConfigDeleteAcks: new Set(),
    fileHashManager: { getPathHash: () => null, getValidHash: () => null, setFileHash: noop, removeFileHash: noop, setFileHashes: noop },
    configHashManager: { isReady: () => true, setFileHash: noop, removeFileHash: noop },
    folderSnapshotManager: { removeFolder: noop, setFolderMtime: noop },
    configManager: { updateFileState: noop, removeFileState: noop },
    localStorageManager: { syncPathPrefix: 'fns-localstorage:',
      getMetadata: k => store.get(k) ?? 0, setMetadata: (k, v) => store.set(k, v),
      savePending: noop, getItemValue: () => null, pathToKey: () => null,
      handleReceivedUpdate: async () => false },
    concurrencyLimiter: { releaseSlot: noop, releaseFifoSlot: noop },
    noteSyncTasks: { failed: 0 }, fileSyncTasks: { failed: 0 },
    folderSyncTasks: { failed: 0 }, configSyncTasks: { failed: 0 },
    recordSyncCompleted: noop,
    websocket: { SendMessage: async () => {}, isOpen: true },
    syncState: { activeSyncContext: activeContext, hasSyncedThisConnection: hasSynced,
      pendingSyncEndTime: new Map(), syncTimeBaseline: new Map(), pendingNotePushPageIndex: new Map(),
      pendingFilePushPageIndex: new Map(), pendingConfigPushPageIndex: new Map(),
      conflictedPaths: new Set(), newConflictedPathsThisRound: new Set() },
  };
  return { p, store };
}

// 1. 轮次进行中：单条消息/Ack 不落盘游标（覆盖 note modify、note ack、folder modify、config ack）
{
  for (const active of [true, false]) { // isSyncing=true 或 activeSyncContext 非空
    const { p, store } = makePlugin({ isSyncing: active, activeContext: active ? null : 'ctx', cursor: { lastNoteSyncTime: 100, lastFolderSyncTime: 100, lastConfigSyncTime: 100 } });
    await noteOps.receiveNoteSyncModify({ path: 'a.md', content: 'x', contentHash: 'h', mtime: 1, ctime: 1, lastTime: 500 }, p);
    noteOps.receiveNoteModifyAck({ lastTime: 900, path: 'a.md' }, p);
    await folderOps.receiveFolderSyncModify({ path: 'd', lastTime: 500 }, p);
    configOps.receiveConfigModifyAck({ lastTime: 900, path: 'cfg.json' }, p);
    assert.equal(store.get('lastNoteSyncTime'), 100, `mid-round (isSyncing=${active}): note modify/ack must not advance`);
    assert.equal(store.get('lastFolderSyncTime'), 100, `mid-round (isSyncing=${active}): folder modify must not advance`);
    assert.equal(store.get('lastConfigSyncTime'), 100, `mid-round (isSyncing=${active}): config ack must not advance`);
  }
  console.log('PASS: mid-round per-item messages never advance the cursor (both activeSyncContext and isSyncing gates)');
}

// 2. 连接建立后首轮同步完成前（含手动同步模式）：实时推送不推进，离线变更不被掩盖
{
  const { p, store } = makePlugin({ cursor: { lastNoteSyncTime: 100 } });
  // hasSyncedThisConnection=false：手动同步模式/启动延迟期同态
  await noteOps.receiveNoteSyncModify({ path: 'a.md', content: 'x', contentHash: 'h', mtime: 1, ctime: 1, lastTime: 900 }, p);
  assert.equal(store.get('lastNoteSyncTime'), 100, 'before the first clean round of this connection, live pushes must not advance (service#101: the offline window would be hidden)');
  console.log('PASS: pre-first-round live pushes do not advance the cursor (manual-sync mode included)');
}

// 3. 空闲在线（已完成首轮、不在轮次中）：实时推送照常推进，避免重启后重复拉取
{
  const { p, store } = makePlugin({ hasSynced: true, cursor: { lastNoteSyncTime: 100 } });
  await noteOps.receiveNoteSyncModify({ path: 'a.md', content: 'x', contentHash: 'h', mtime: 1, ctime: 1, lastTime: 900 }, p);
  assert.equal(store.get('lastNoteSyncTime'), 900, 'idle online: live pushes must still advance');
  // 单调递增：旧值不回退
  await noteOps.receiveNoteSyncModify({ path: 'b.md', content: 'y', contentHash: 'h', mtime: 1, ctime: 1, lastTime: 300 }, p);
  assert.equal(store.get('lastNoteSyncTime'), 900, 'idle online: cursor is monotonic');
  console.log('PASS: idle-online live pushes still advance the cursor monotonically');
}

// 4. 纯上行配置同步一轮（各计数为 0）：End 无条件暂存，settleSyncTimes 正常路径推进游标
{
  const { p, store } = makePlugin({ cursor: { lastConfigSyncTime: 0 } });
  p.syncState.syncTimeBaseline.set('lastConfigSyncTime', 0);
  await configOps.receiveConfigSyncEnd({ lastTime: 800, needUploadCount: 0, needModifyCount: 0, needSyncMtimeCount: 0, needDeleteCount: 0 }, p);
  assert.equal(p.syncState.pendingSyncEndTime.get('lastConfigSyncTime'), 800, 'pure-uplink config round: End time must be stashed unconditionally');
  // 完成且无失败：正常路径落盘（progressTracker 桩：isTypeFullyDone 由 p 自备）
  p.progressTracker = { isTypeFullyDone: () => true };
  p.fileDownloadSessions = new Map();
  settleSyncTimes(p);
  assert.equal(store.get('lastConfigSyncTime'), 800, 'pure-uplink config round: cursor advances past 0, no more isCover full comparison every round');
  console.log('PASS: pure-uplink config rounds advance lastConfigSyncTime');
}

// 5. 处理失败不推进（config modify 写盘失败）：游标留在原值（service#101：写失败走 catch 不越过）
{
  const { p, store } = makePlugin({ hasSynced: true, cursor: { lastConfigSyncTime: 100 } });
  p.app.vault.adapter.write = async () => { throw new Error('disk full'); };
  await configOps.receiveConfigSyncModify({ path: '.obsidian/app.json', content: '{}', contentHash: 'h', mtime: 5, ctime: 5, lastTime: 500 }, p);
  assert.equal(store.get('lastConfigSyncTime'), 100, 'a failed write must not advance the cursor');
  assert.equal(p.configSyncTasks.failed, 1, 'the failure is still accounted');
  console.log('PASS: failed handlers keep the cursor in place');
}

// 6. checkSyncCompletion 正常完成一轮置 hasSyncedThisConnection=true（手动同步同一入口）
{
  const { checkSyncCompletion } = load('src/lib/sync/operator.ts', {
    './operator_note': noteOps, './operator_folder': folderOps, './operator_config': configOps,
    './operator_file': { sweepStalledDownloadSessions: async () => 0 },
    '../../i18n/lang': { $: k => k },
  }, { WebSocket: { OPEN: 1 } });
  const statuses = [];
  const store = new Map();
  const p = {
    syncState: { activeSyncContext: 'round', hasSyncedThisConnection: false, pendingSyncEndTime: new Map(),
      syncTimeBaseline: new Map(), offlineGuardSkippedThisRound: false,
      newConflictedPathsThisRound: new Set(), truncatedSyncFields: new Set(),
      progressCheckIntervalId: null,
      pendingNotePushPageIndex: new Map(), pendingFilePushPageIndex: new Map(), pendingConfigPushPageIndex: new Map() },
    isSyncing: true, isSyncRequesting: false,
    settings: { syncEnabled: true, configSyncEnabled: true },
    websocket: { ws: { readyState: 1, bufferedAmount: 0 } },
    fileDownloadSessions: new Map(),
    progressTracker: { isTypeFullyDone: () => true, getOverallPct: () => 100, forceComplete: noop },
    noteSyncTasks: { needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 1, failed: 0 },
    fileSyncTasks: { needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 1, failed: 0 },
    folderSyncTasks: { needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 1, failed: 0 },
    configSyncTasks: { needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 1, failed: 0 },
    uploadedChunksCount: 0, downloadedChunksCount: 0,
    concurrencyLimiter: { activeKeys: new Set(), queue: [] },
    resetSyncTasks: noop, updateStatusBar: (...a) => statuses.push(a),
    localStorageManager: { getMetadata: () => 0, setMetadata: (k, v) => { if (k === 'hasSynced') throw new Error('wrong key'); store.set(k, v); } },
    syncPageStateMap: new Map(), shareIndicatorManager: undefined,
    statusBarManager: { updateConflictBadge: noop }, progressTracker: { isTypeFullyDone: () => true, getOverallPct: () => 100, forceComplete: noop },
  };
  checkSyncCompletion(p);
  assert.equal(p.syncState.activeSyncContext, null, 'round completes');
  assert.equal(p.syncState.hasSyncedThisConnection, true, 'a cleanly completed round (manual or auto) sets the connection flag');
  // 有失败的轮次不置 true
  const p2 = { ...p, isSyncing: true,
    syncState: { ...p.syncState, activeSyncContext: 'round2', hasSyncedThisConnection: false },
    noteSyncTasks: { ...p.noteSyncTasks, failed: 2 } };
  checkSyncCompletion(p2);
  assert.equal(p2.syncState.hasSyncedThisConnection, false, 'a round with failures never sets the flag');
  console.log('PASS: checkSyncCompletion sets the connection flag on clean rounds only');
}

console.log('PASS: service#101 live cursor guard (mid-round/pre-first-round/idle/failed/pure-uplink/manual)');
