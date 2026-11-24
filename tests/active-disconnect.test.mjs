import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const noop = () => {};
function load(file, extra = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText, { module, exports: module.exports, console,
    window: { setTimeout: () => 1, clearTimeout: noop, clearInterval: noop },
    require: id => extra[id] ?? (id.includes('helpers') ? { dump: noop }
      : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => ({ addLog: noop }) } } : {}) });
  return module.exports;
}
const { SyncState } = load('src/lib/sync/sync_state.ts');
const { settleSyncTimes } = load('src/lib/sync/operator.ts');
let options;
const cleanup = [];
const { WebSocketManager } = load('src/lib/sync/websocket_manager.ts', {
  './websocket_client': { WebSocketClient: class {
    constructor(_plugin, opts) { options = opts; }
    registerBinaryHandler() {}
    unRegister(flag) { cleanup.push(['unregister', flag]); }
    register() { return 'reconnected'; }
  } },
  './operator': { settleSyncTimes, settleAllBatchSendSessionsOnClose: () => cleanup.push('batch') },
  './operator_note': { clearEmptyNoteProbes: () => cleanup.push('probes'), releaseEmptyNoteProbe: () => undefined },
  './operator_file': { invalidateFileDownloads: p => { p.fileDownloadSessions.clear(); cleanup.push('downloads'); },
    clearUploadQueue: () => cleanup.push('uploads') },
});
function fixture() {
  const syncState = new SyncState();
  syncState.activeSyncContext = 'old-round';
  syncState.hasSyncedThisConnection = true;
  syncState.syncTimeBaseline.set('lastNoteSyncTime', 100);
  syncState.pendingSyncEndTime.set('lastNoteSyncTime', 900);
  const meta = new Map([['lastNoteSyncTime', 700]]);
  const p = { syncState, isSyncing: true, isSyncRequesting: true,
    fileDownloadSessions: new Map([['s', {}]]),
    pendingNoteModifies: new Map([['local.md', 'unsent-hash']]),
    progressTracker: { isTypeFullyDone: () => false },
    localStorageManager: { getMetadata: k => meta.get(k), setMetadata: (k,v) => meta.set(k,v) },
    concurrencyLimiter: { clear: () => cleanup.push('slots') },
    noteSyncTasks: {}, fileSyncTasks: {}, folderSyncTasks: {}, configSyncTasks: {},
  };
  const m = new WebSocketManager(p);
  m.deferredMessages.push({ action: 'x', data: {} });
  return { p, m, meta, close: options.onClose };
}
for (const mode of ['active', 'passive']) {
  cleanup.length = 0;
  const { p, m, meta, close } = fixture();
  if (mode === 'active') m.unRegister(true); else close(m.client, 1006, 'lost');
  assert.equal(p.isSyncing, false, `${mode}: round reset immediately`);
  assert.equal(p.isSyncRequesting, false);
  assert.equal(p.syncState.activeSyncContext, null);
  assert.ok(p.syncState.retiredSyncContexts.has('old-round'));
  assert.equal(meta.get('lastNoteSyncTime'), 100);
  assert.equal(p.fileDownloadSessions.size, 0);
  assert.equal(m.deferredMessages.length, 0);
  assert.equal(p.syncState.hasSyncedThisConnection, false);
  assert.equal(p.pendingNoteModifies.get('local.md'), 'unsent-hash', 'disconnect preserves local edits unlike cancel');
  for (const item of ['downloads','uploads','slots','batch','probes']) assert.ok(cleanup.includes(item));
  assert.equal(m.register(), 'reconnected');
}
console.log('PASS: active and passive disconnects share round retirement, cursor rollback and resource cleanup');
