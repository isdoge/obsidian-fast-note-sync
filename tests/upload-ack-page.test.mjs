import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const noop = () => {};
const tick = () => new Promise(setImmediate);
const session = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// 每个用例独立加载真实处理器与限流器；仅替换 Obsidian、存储和网络边界。
// Load real handlers and limiter per case; stub only Obsidian, storage and network boundaries.
function fixture() {
  let now = 1_000_000;
  class ClockDate extends Date { static now() { return now; } }
  const errors = [], cursorCalls = [], sent = [], reads = [], completed = [], timers = new Map();
  let timerId = 0;
  const helpers = new Proxy({
    isPathExcluded: () => false, isLargeBinarySyncRisk: () => false,
    hashFileAsync: async () => 'same-hash', hashContent: x => x,
    sleep: async () => {}, generateUUID: () => 'next-round', getPluginDir: () => '',
    dump: (...args) => { if (args[0] === 'Sync handler failed') errors.push(args); },
  }, { get: (t, k) => t[k] ?? noop });
  function load(file, extra = {}) {
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, {
      module, exports: module.exports, console, Map, Set, TextEncoder, Uint8Array, ArrayBuffer, DataView,
      Date: ClockDate, WebSocket: { OPEN: 1 },
      window: {
        setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
        clearTimeout: id => timers.delete(id), clearInterval: noop,
      },
      require: id => extra[id] ?? (id === 'obsidian'
        ? { normalizePath: x => x, Platform: {}, TFile: class {}, TFolder: class {} }
        : id.includes('helpers') ? helpers
        : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop, logReceivedMessage: noop }) } }
        : id.includes('i18n') ? { $: key => key } : {}),
    });
    return module.exports;
  }
  const { SyncState } = load('src/lib/sync/sync_state.ts');
  const { ConcurrencyLimiter } = load('src/lib/sync/concurrency_limiter.ts');
  const ops = load('src/lib/sync/operator_file.ts', {
    './sync_state': { advanceLiveSyncTime: (...args) => cursorCalls.push(args) },
  });
  const actions = new Proxy({}, { get: (_, k) => k });
  const { WebSocketManager } = load('src/lib/sync/websocket_manager.ts', {
    './websocket_action': actions,
    './operator': { receiveOperators: new Map([
      ['FileUpload', ops.receiveFileUpload], ['FileUploadAck', ops.receiveFileUploadAck],
      ['NoteSyncModify', () => assert.fail('foreign note must be deferred')],
    ]) },
  });
  const boundaries = load('src/lib/sync/operator.ts', {
    './operator_file': ops, './websocket_action': actions,
  });
  const file = { path: 'a.bin', stat: { size: 4, mtime: 123 } };
  const p = {
    syncState: new SyncState(),
    settings: { syncEnabled: true, vault: 'v', concurrencyControlEnabled: true, maxConcurrentUploads: 2 },
    app: {
      vault: { getFileByPath: () => file, getName: () => 'v',
        readBinary: async f => { reads.push(f.path); return new ArrayBuffer(4); },
        adapter: { exists: async () => false } },
      loadLocalStorage: noop, saveLocalStorage: noop,
    },
    pendingUploadHashes: new Map(), pendingNoteModifies: new Map(), pendingConfigModifies: new Map(),
    pendingFileRenames: [], pendingNoteRenames: new Map(),
    pendingDeleteNotePaths: new Set(), pendingDeleteFilePaths: new Set(),
    pendingDeleteFolderPaths: new Set(), pendingDeleteConfigPaths: new Set(),
    pendingNoteDeleteAcks: new Set(), pendingFileDeleteAcks: new Set(), pendingConfigDeleteAcks: new Set(),
    fileDownloadSessions: new Map(), syncPageStateMap: new Map(),
    fileHashManager: { getPathHash: () => 'same-hash', setFileHash: noop, setFileHashes: noop },
    localStorageManager: { savePending: noop, clearPending: noop, getMetadata: () => 0, setMetadata: noop },
    websocket: {
      isOpen: true, ws: { readyState: 1, bufferedAmount: 0 },
      SendBinary: async (frame, _prefix, before, after) => {
        if (before()) return 'cancelled';
        sent.push(frame); after(); return 'sent';
      },
    },
    recordSyncCompleted: (type, page) => completed.push([type, page]),
    totalChunksToUpload: 7, uploadedChunksCount: 3, downloadedChunksCount: 0,
    noteSyncTasks: { completed: 0, failed: 0 }, fileSyncTasks: { completed: 0, failed: 0 },
    folderSyncTasks: { completed: 0, failed: 0 }, configSyncTasks: { completed: 0, failed: 0 },
    menuManager: { ribbonIconStatus: true },
    progressTracker: { reset: noop, forceComplete: noop, isTypeFullyDone: () => false,
      getOverallPct: () => 10, getDetailText: () => '' },
    resetSyncTasks: noop, updateStatusBar: noop,
    isSyncing: false, isSyncRequesting: false,
  };
  p.concurrencyLimiter = new ConcurrencyLimiter(p);
  const m = Object.create(WebSocketManager.prototype);
  Object.assign(m, { plugin: p, client: { notifyActivity: noop }, deferredMessages: [],
    deferredBytes: 0, replayScheduled: false, deferredOverflowed: false });
  const message = (action, data, context, pageIndex) => m.handleStructuredMessage(action, {
    code: 200, vault: 'v', ...(context ? { context } : {}), pageIndex, data,
  });
  const upload = (id, pageIndex) => ops.receiveFileUpload({
    path: file.path, sessionId: id, pathHash: 'path-hash', chunkSize: 4, pageIndex,
  }, p, pageIndex === undefined);
  const ack = () => ops.receiveFileUploadAck({ path: file.path }, p, true);
  return { p, m, ops, boundaries, file, reads, sent, completed, errors, cursorCalls, timers,
    message, upload, ack, advance: ms => { now += ms; } };
}

const cases = [];
function test(name, run) { cases.push([name, run]); }
test('duplicate session while queued and awaiting ACK starts one upload', async () => {
  const f = fixture(); f.p.settings.maxConcurrentUploads = 1;
  await f.p.concurrencyLimiter.waitForSlot('busy');
  f.upload(session(99)); f.upload(session(99)); await tick();
  assert.equal(f.p.concurrencyLimiter.queue.length, 1, 'same session queues once');
  f.p.concurrencyLimiter.releaseSlot('busy'); await tick(); await tick();
  assert.equal(f.reads.length, 1);
  f.upload(session(99)); await tick(); await tick();
  assert.equal(f.reads.length, 1, 'sent session remains registered until ACK');
  f.ack();
});
test('cancelled queued session can be requested again', async () => {
  const f = fixture(); f.p.settings.maxConcurrentUploads = 1;
  await f.p.concurrencyLimiter.waitForSlot('busy');
  f.upload(session(98)); await tick();
  f.p.concurrencyLimiter.clear(); await tick();
  f.upload(session(98)); await tick(); await tick();
  assert.equal(f.reads.length, 1, 'cancel removes session ownership before a new request');
  f.ack();
});
test('failed send ends session deduplication', async () => {
  const f = fixture(); f.p.websocket.SendBinary = async () => 'closed';
  f.upload(session(97)); await tick(); await tick();
  f.upload(session(97)); await tick(); await tick();
  assert.equal(f.reads.length, 2, 'failed session can be retried');
});
for (const [name, idle, pending, context, expected, deferred] of [
  ['a: idle slot, pending page, contextless ACK', true, true, undefined, [['file', 0]], 0],
  ['b: round slot, pending page, contextless ACK', false, true, undefined, [['file', 0]], 0],
  ['c: unchanged: idle slot, no pending page', true, false, undefined, [], 0],
  ['d: unchanged: round slot, no pending page', false, false, undefined, [], 1],
  ['e: unchanged: current context ACK', false, true, 'round', [['file', 0]], 0],
]) {
  test(name, async () => {
    const f = fixture(), { p, m } = f;
    if (!idle) p.syncState.activeSyncContext = 'round';
    await p.concurrencyLimiter.waitForSlot('a.bin');
    p.syncState.activeSyncContext = 'round'; p.isSyncing = true;
    if (pending) p.syncState.pendingFilePushPageIndex.set('a.bin', 0);
    p.pendingUploadHashes.set('a.bin', 'same-hash');
    await f.message('FileUploadAck', { path: 'a.bin', lastTime: 900 }, context);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.completed, expected);
    assert.equal(m.deferredMessages.length, deferred);
    assert.equal(p.syncState.pendingFilePushPageIndex.has('a.bin'), pending && !!deferred);
    assert.equal(p.concurrencyLimiter.activeKeys.has('a.bin'), !!deferred);
    assert.equal(p.pendingUploadHashes.has('a.bin'), true, 'unsent synthetic pending hash stays unconfirmed');
    assert.equal(f.cursorCalls.length, !deferred && !idle ? 1 : 0,
      'outsideRound still controls cursor advancement');
  });
}
test('f: ACK before paged request for same completed session', async () => {
  const f = fixture();
  await f.upload(session(1)); await tick(); f.ack();
  f.reads.length = 0; f.sent.length = 0; f.completed.length = 0;
  f.p.syncState.activeSyncContext = 'round'; f.p.isSyncing = true;
  let slots = 0;
  const wait = f.p.concurrencyLimiter.waitForSlot.bind(f.p.concurrencyLimiter);
  f.p.concurrencyLimiter.waitForSlot = (...args) => { slots++; return wait(...args); };
  await f.message('FileUpload', { path: 'a.bin', sessionId: session(1), chunkSize: 4 }, 'round', 2);
  await tick();
  assert.deepEqual(f.errors, []);
  assert.equal(f.reads.length, 0); assert.equal(f.sent.length, 0); assert.equal(slots, 0);
  assert.equal(f.p.totalChunksToUpload, 7);
  // 服务端页号从 1 开始，消息入口转成本地从 0 开始的页号。
  // Wire page indices are one-based; the message entry converts them to zero-based indices.
  assert.deepEqual(f.completed, [['file', 1]]);
  assert.equal(f.p.syncState.pendingFilePushPageIndex.size, 0);
});
test('g: unchanged: new session uploads even when baseline matches', async () => {
  const f = fixture();
  await f.upload(session(1)); await tick(); f.ack();
  f.reads.length = 0; f.sent.length = 0;
  f.p.syncState.activeSyncContext = 'round';
  await f.upload(session(2), 2); await tick();
  assert.equal(f.reads.length, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.p.totalChunksToUpload, 8);
  assert.equal(f.p.concurrencyLimiter.activeKeys.has('a.bin'), true);
  f.ops.receiveFileUploadAck({ path: 'a.bin' }, f.p);
  assert.deepEqual(f.completed, [['file', 2]]);
});
for (const boundary of ['cancel', 'start', 'stall']) {
  test(`h: ${boundary} boundary forgets completed sessions`, async () => {
    const f = fixture(), { p } = f;
    await f.upload(session(1)); await tick(); f.ack();
    assert.equal(p.syncState.completedFileUploadSessions?.has(session(1)), true);
    if (boundary === 'cancel') f.boundaries.cancelSync(p);
    if (boundary === 'start') {
      p.settings.syncEnabled = false;
      await f.boundaries.handleSync(p);
      p.settings.syncEnabled = true;
    }
    if (boundary === 'stall') {
      p.syncState.activeSyncContext = 'round'; p.isSyncing = true;
      f.boundaries.checkSyncCompletion(p, 1, 0, 'round');
      f.advance(f.boundaries.SYNC_STALL_RESTART_MS + 1);
      f.boundaries.checkSyncCompletion(p, 1, 0, 'round');
      assert.equal(p.syncState.activeSyncContext, null);
    }
    assert.equal(p.syncState.completedFileUploadSessions.size, 0);
    f.reads.length = 0; f.sent.length = 0; f.completed.length = 0;
    p.syncState.activeSyncContext = 'new-round';
    await f.upload(session(1), 3); await tick();
    assert.equal(f.reads.length, 1); assert.equal(f.sent.length, 1);
    f.ops.receiveFileUploadAck({ path: 'a.bin' }, p);
    assert.deepEqual(f.completed, [['file', 3]]);
  });
}
test('i: duplicate active session waits for one upload and one ACK', async () => {
  const f = fixture();
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const read = f.p.app.vault.readBinary;
  f.p.app.vault.readBinary = async file => { await gate; return read(file); };
  await f.upload(session(1)); await tick();
  f.p.syncState.activeSyncContext = 'round'; f.p.isSyncing = true;
  await f.upload(session(1), 4);
  resume(); await tick();
  assert.equal(f.reads.length, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.p.totalChunksToUpload, 7);
  assert.deepEqual(f.completed, []);
  await f.message('FileUploadAck', { path: 'a.bin' });
  assert.deepEqual(f.completed, [['file', 4]]);
  assert.equal(f.p.syncState.pendingFilePushPageIndex.size, 0);
});
test('unchanged: foreign/retired contexts and other actions retain filtering', async () => {
  const f = fixture(), { p, m } = f;
  p.syncState.activeSyncContext = 'round';
  p.syncState.pendingFilePushPageIndex.set('a.bin', 0);
  await p.concurrencyLimiter.waitForSlot('a.bin');
  p.syncState.retiredSyncContexts.add('retired');
  await f.message('FileUploadAck', { path: 'a.bin' }, 'retired');
  assert.equal(m.deferredMessages.length, 0);
  await f.message('FileUploadAck', { path: 'a.bin' }, 'other-device');
  await f.message('NoteSyncModify', { path: 'a.bin' });
  assert.equal(m.deferredMessages.length, 2);
  assert.deepEqual(f.completed, []);
  assert.equal(p.syncState.pendingFilePushPageIndex.get('a.bin'), 0);
  assert.equal(p.concurrencyLimiter.activeKeys.has('a.bin'), true);
});
test('completed session history is bounded and evicts oldest first', async () => {
  const f = fixture();
  await f.upload(session(1)); await tick(); f.ack();
  const history = f.p.syncState.completedFileUploadSessions;
  assert.ok(history instanceof Set, 'ACK remembers its session');
  for (let i = 2; i <= 5000; i++) history.add(session(i));
  await f.upload(session(5001)); await tick(); f.ack();
  assert.equal(history.size, 5000);
  assert.equal(history.has(session(1)), false);
  assert.equal(history.has(session(2)), true);
  assert.equal(history.has(session(5001)), true);
});

let failed = 0;
for (const [name, run] of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(`${cases.length - failed}/${cases.length} upload ACK page tests passed`);
if (failed) process.exitCode = 1;
