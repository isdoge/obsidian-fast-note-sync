// F-1: SyncEnd arrives before the paged details. lastXxxSyncTime must only advance once the type
// finished with failed=0; otherwise it returns to the round's request baseline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const noop = () => {};
const load = (file, extra = {}) => {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, WebSocket: { OPEN: 1 },
    window: { setTimeout: () => 1, clearTimeout: noop, clearInterval: noop },
    require: id => id === 'obsidian' ? { normalizePath: x => x, TFile: class {}, TFolder: class {}, Platform: {} }
      : id.includes('helpers') ? { dump: noop, dumpError: noop, showSyncNotice: noop }
      : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: noop, addLog: noop }) } }
      : id.includes('i18n') ? { $: k => k }
      : id === './operator_file' ? { sweepStalledDownloadSessions: async () => 0 }
      : {}, ...extra });
  return module.exports;
};
const op = load('src/lib/sync/operator.ts');
const endHandlers = {
  lastNoteSyncTime: load('src/lib/sync/operator_note.ts').receiveNoteSyncEnd,
  lastFileSyncTime: load('src/lib/sync/operator_file.ts').receiveFileSyncEnd,
  lastFolderSyncTime: load('src/lib/sync/operator_folder.ts').receiveFolderSyncEnd,
  lastConfigSyncTime: load('src/lib/sync/operator_config.ts').receiveConfigSyncEnd,
};

const tasks = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 });
function mk(baseline = 100) {
  const meta = new Map([['lastNoteSyncTime', baseline], ['lastFileSyncTime', baseline], ['lastFolderSyncTime', baseline], ['lastConfigSyncTime', baseline]]);
  const done = { note: false, file: false, folder: false, setting: false };
  return {
    meta, done,
    settings: { syncEnabled: true, configSyncEnabled: true, isShowNotice: false },
    syncState: { pendingSyncEndTime: new Map(), syncTimeBaseline: new Map([...meta]), activeSyncContext: 'ctx', newConflictedPathsThisRound: new Set() },
    noteSyncTasks: tasks(), fileSyncTasks: tasks(), folderSyncTasks: tasks(), configSyncTasks: tasks(),
    fileDownloadSessions: new Map(),
    progressTracker: { isTypeFullyDone: t => done[t], getOverallPct: () => 50, getDetailText: () => '', forceComplete: noop },
    localStorageManager: { getMetadata: k => meta.get(k) ?? 0, setMetadata: (k, v) => meta.set(k, v) },
    syncTypeCompleteCount: 0,
  };
}

// End handlers stash lastTime instead of persisting it
{
  const p = mk();
  for (const [field, handler] of Object.entries(endHandlers)) {
    await handler({ lastTime: 900, needModifyCount: 1 }, p);
    assert.equal(p.meta.get(field), 100, `${field}: End must not persist before the details are applied`);
    assert.equal(p.syncState.pendingSyncEndTime.get(field), 900, `${field}: End time is stashed`);
  }
}

// Not done yet: nothing changes. Done with failed=0: End time is persisted.
{
  const p = mk();
  p.syncState.pendingSyncEndTime.set('lastNoteSyncTime', 900);
  op.settleSyncTimes(p);
  assert.equal(p.meta.get('lastNoteSyncTime'), 100);
  assert.equal(p.syncState.pendingSyncEndTime.has('lastNoteSyncTime'), true);
  p.done.note = true;
  op.settleSyncTimes(p);
  assert.equal(p.meta.get('lastNoteSyncTime'), 900, 'clean type commits the End time');
  assert.equal(p.syncState.pendingSyncEndTime.size, 0);
}

// Done with failures: End time discarded and per-item advances rolled back to the baseline
{
  const p = mk();
  p.syncState.pendingSyncEndTime.set('lastFileSyncTime', 900);
  p.meta.set('lastFileSyncTime', 500); // a later item succeeded after an earlier one failed
  p.fileSyncTasks.failed = 1;
  p.done.file = true;
  op.settleSyncTimes(p);
  assert.equal(p.meta.get('lastFileSyncTime'), 100, 'failed type returns to the request baseline');
  assert.equal(p.syncState.pendingSyncEndTime.size, 0);
}

// File type also waits for in-flight download sessions
{
  const p = mk();
  p.syncState.pendingSyncEndTime.set('lastFileSyncTime', 900);
  p.done.file = true;
  p.fileDownloadSessions.set('s', {});
  op.settleSyncTimes(p);
  assert.equal(p.meta.get('lastFileSyncTime'), 100);
  assert.equal(p.syncState.pendingSyncEndTime.has('lastFileSyncTime'), true, 'pending download keeps the time unsettled');
}

// Abort (stall restart / cancel / disconnect): every unsettled type returns to the baseline
{
  const p = mk();
  p.syncState.pendingSyncEndTime.set('lastNoteSyncTime', 900);
  p.syncState.pendingSyncEndTime.set('lastFolderSyncTime', 900);
  p.meta.set('lastNoteSyncTime', 400);
  p.done.folder = true;
  op.settleSyncTimes(p, true);
  assert.equal(p.meta.get('lastNoteSyncTime'), 100);
  assert.equal(p.meta.get('lastFolderSyncTime'), 100);
  assert.equal(p.syncState.pendingSyncEndTime.size, 0);
}

// Full completion path: a round that finished with a failed note keeps the old time
{
  const p = mk();
  Object.assign(p, {
    syncPageStateMap: new Map(), resetSyncTasks: noop, updateStatusBar: noop, isSyncRequesting: false, isSyncing: true,
    expectedSyncCount: 0, websocket: { ws: { readyState: 1, bufferedAmount: 0 }, isOpen: true },
    statusBarManager: { updateConflictBadge: noop }, concurrencyLimiter: { activeKeys: new Set(), queue: [] },
  });
  p.localStorageManager.getMetadata = k => k === 'isInitSync' ? true : (p.meta.get(k) ?? 0);
  Object.assign(p.done, { note: true, file: true, folder: true, setting: true });
  p.syncState.pendingSyncEndTime.set('lastNoteSyncTime', 900);
  p.syncState.pendingSyncEndTime.set('lastFileSyncTime', 900);
  p.noteSyncTasks.failed = 1;
  op.checkSyncCompletion(p, 1, 0, 'ctx');
  assert.equal(p.syncState.activeSyncContext, null, 'round completed');
  assert.equal(p.meta.get('lastNoteSyncTime'), 100, 'failed note type is re-pulled next round');
  assert.equal(p.meta.get('lastFileSyncTime'), 900, 'clean file type still advances');
}
console.log('sync time commit tests passed');
