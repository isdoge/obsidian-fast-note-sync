import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// 活跃同步轮次中 context 不匹配的消息不再一律丢弃：
// - 本机已作废 context（上一轮迟到应答）→ 照旧丢弃；
// - 其它来源（无 context 广播 / 其它设备 context / 本机无 context 请求的应答）→ 延后到轮次结束回放。
// 回放走与实时分发完全相同的路径（vault 校验、pageIndex 转换、handler 查找）。
const root = '.';
const noop = () => {};
const helpers = { dump: (...a) => logs.push(['dump', ...a]), dumpError: noop,
  isPathExcluded: () => false, isLargeBinarySyncRisk: () => false, checkAndNotifyCaseConflict: () => false,
  hashContent: x => x, normalizeServerTimestamp: x => x,
  hashFileAsync: async () => 'hash', sleep: async () => {}, logMemorySnapshot: noop,
  addRandomParam: x => x, showSyncNotice: noop,
  safeStringify: v => JSON.stringify(v) ?? String(v), getPluginDir: () => '' };
const logs = [];
const logMgr = { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop, logReceivedMessage: noop, logSentMessage: noop }) };
function load(file, extra = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, Map, Set, JSON, TextEncoder, Uint8Array, ArrayBuffer, DataView,
    window: { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: noop },
    require: id => id === 'obsidian' ? { moment: Object.assign(() => ({ format: () => '' }), { locale: () => 'zh-cn' }), Platform: {}, normalizePath: x => x }
      : id.includes('helpers') ? helpers
      : id.includes('sync_log_manager') ? { SyncLogManager: logMgr }
      : extra[id] || {} });
  return module.exports;
}
const timers = [];
const received = [];
const receiveOperators = new Map([
  ['NoteSyncModify', x => received.push(['NoteSyncModify', x])],
  ['FolderSyncModify', x => received.push(['FolderSyncModify', x])],
]);
const { WebSocketManager } = load('src/lib/sync/websocket_manager.ts', {
  './websocket_action': new Proxy({}, { get: (_, k) => k }),
  './operator': { receiveOperators },
});
function makeManager(initialContext = null, retired = []) {
  const m = Object.create(WebSocketManager.prototype);
  m.client = { notifyActivity: noop };
  m.deferredMessages = [];
  m.deferredBytes = 0;
  m.replayScheduled = false;
  m.deferredOverflowed = false;
  m.receivedFileDetails = new Set();
  m.receivedFileContext = null;
  m.plugin = {
    settings: { vault: 'test' },
    syncState: {
      _active: initialContext,
      retiredSyncContexts: new Set(retired),
      onSyncContextRetired: undefined,
      hasSyncedThisConnection: true,
      get activeSyncContext() { return this._active; },
      set activeSyncContext(v) {
        const old = this._active; this._active = v;
        if (old !== null && old !== v) { this.retiredSyncContexts.add(old); this.onSyncContextRetired?.(); }
      },
    },
    pendingNoteModifies: new Map(),
  };
  // 与真实构造一致：setter 触发时调度回放
  m.plugin.syncState.onSyncContextRetired = () => m.scheduleDeferredReplay();
  return m;
}
const flushTimers = async () => { while (timers.length) { const t = timers.shift(); await t(); await new Promise(setImmediate); } };

const { ConcurrencyLimiter } = load('src/lib/sync/concurrency_limiter.ts');
const { advanceLiveSyncTime } = load('src/lib/sync/sync_state.ts');
const noteOps = load('src/lib/sync/operator_note.ts', { './sync_state': { advanceLiveSyncTime } });
const fileOps = load('src/lib/sync/operator_file.ts', { './sync_state': { advanceLiveSyncTime } });
const configOps = load('src/lib/sync/operator_config.ts', { './sync_state': { advanceLiveSyncTime } });
for (const [action, handler] of [['NoteModifyAck', noteOps.receiveNoteModifyAck], ['FileUploadAck', fileOps.receiveFileUploadAck], ['SettingModifyAck', configOps.receiveConfigModifyAck], ['NoteSyncMtime', noteOps.receiveNoteSyncMtime], ['FileSyncMtime', fileOps.receiveFileSyncMtime]]) {
  const m = makeManager(null);
  const p = m.plugin;
  p.settings = { syncEnabled: true, vault: 'test', concurrencyControlEnabled: true, maxConcurrentUploads: 5 };
  p.concurrencyLimiter = new ConcurrencyLimiter(p);
  p.app = { vault: { getFileByPath: () => ({ stat: { mtime: 123, size: 3 } }), adapter: { stat: async () => ({ mtime: 123, size: 3 }) } } };
  const baselines = [];
  p.fileHashManager = p.configHashManager = { isReady: () => true, setFileHash: (path, hash) => baselines.push([path, hash]) };
  p.localStorageManager = { syncPathPrefix: 'virtual:', getMetadata: () => 100, setMetadata: () => assert.fail('old ACK must not advance round time'), savePending: noop };
  p.app.vault.read = async () => 'content';
  p.app.vault.readBinary = async () => new ArrayBuffer(0);
  p.app.vault.modify = p.app.vault.modifyBinary = async () => {};
  p.lockManager = { withLock: async (_path, task) => { await task(); return true; } };
  p.addIgnoredFile = p.removeIgnoredFile = noop;
  p.lastSyncMtime = new Map();
  p.recordSyncCompleted = () => assert.fail('old ACK must not count toward this round');
  p.syncState.pendingNotePushPageIndex = new Map();
  p.syncState.pendingFilePushPageIndex = new Map();
  p.syncState.pendingConfigPushPageIndex = new Map();
  p.pendingUploadHashes = new Map(); p.pendingConfigModifies = new Map();
  receiveOperators.set(action, handler);
  for (let i = 0; i < 5; i++) {
    const path = `idle-${i}`;
    p.pendingNoteModifies.set(path, 'hash'); p.pendingUploadHashes.set(path, 'hash'); p.pendingConfigModifies.set(path, 'hash');
    await p.concurrencyLimiter.waitForSlot(path);
  }
  p.syncState.activeSyncContext = 'new-round'; p.isSyncing = true;
  let acquired = false;
  const waiting = p.concurrencyLimiter.waitForSlot('round-upload').then(ok => { acquired = ok; });
  for (let i = 0; i < 5; i++) await m.handleStructuredMessage(action, { code: 200, vault: 'test', data: { path: `idle-${i}`, lastTime: 900, mtime: 123, ctime: 100 } });
  await Promise.resolve();
  assert.equal(acquired, true, `${action}: idle ACKs free capacity immediately`);
  await waiting;
  assert.equal(baselines.length, action === 'FileUploadAck' ? 0 : 5, `${action}: old uploads commit their own baselines`);
  assert.equal(m.deferredMessages.length, 0);
  assert.equal(p.concurrencyLimiter.activeKeys.size, 1);
  // 已取消轮次的确认优先丢弃，不能因槽位匹配而绕过 context 过滤。
  p.syncState.retiredSyncContexts.add('cancelled');
  await p.concurrencyLimiter.waitForSlot('retired');
  await m.handleStructuredMessage(action, { code: 200, vault: 'test', context: 'cancelled', data: { path: 'retired' } });
  assert.equal(p.concurrencyLimiter.activeKeys.has('retired'), true);
  // 本轮发出的上传确认继续正常计入本轮。
  let completed = 0;
  p.recordSyncCompleted = () => { completed++; };
  await m.handleStructuredMessage(action, { code: 200, vault: 'test', context: 'new-round', data: { path: 'round-upload', mtime: 123, ctime: 100 } });
  assert.equal(completed, 1);
}
console.log('PASS: five idle upload ACKs unblock a new round without counting or advancing its cursor; retired ACKs stay discarded');

// 空闲 FileUploadCheck 的分片请求也不能延后，否则最终 Ack 永远不会产生。
{
  const m = makeManager(null), p = m.plugin;
  p.settings = { syncEnabled: true, vault: 'test', concurrencyControlEnabled: true, maxConcurrentUploads: 1 };
  p.concurrencyLimiter = new ConcurrencyLimiter(p);
  await p.concurrencyLimiter.waitForSlot('idle.bin');
  p.syncState.activeSyncContext = 'round'; p.isSyncing = true;
  p.syncState.pendingFilePushPageIndex = new Map();
  p.pendingUploadHashes = new Map();
  p.localStorageManager = { savePending: noop, getMetadata: () => 100, setMetadata: () => assert.fail('no cursor advance') };
  p.fileHashManager = { setFileHashes: noop, setFileHash: noop };
  const file = { path: 'idle.bin', stat: { size: 0, mtime: 123 } };
  p.app = { vault: { getFileByPath: () => file, getName: () => 'test', readBinary: async () => new ArrayBuffer(0) }, loadLocalStorage: noop, saveLocalStorage: noop };
  p.totalChunksToUpload = 7; p.uploadedChunksCount = 3;
  p.recordSyncCompleted = () => assert.fail('live upload is not a round task');
  let sent = 0;
  p.websocket = { SendBinary: async (_data, _prefix, _before, after) => { after(); sent++; return 'sent'; } };
  receiveOperators.set('FileUpload', fileOps.receiveFileUpload);
  receiveOperators.set('FileUploadAck', fileOps.receiveFileUploadAck);
  await m.handleStructuredMessage('FileUpload', { code: 200, vault: 'test', data: { path: 'idle.bin', sessionId: '00000000-0000-0000-0000-000000000000', chunkSize: 1024 } });
  await new Promise(setImmediate);
  assert.equal(sent, 1, 'idle upload continues sending without waiting for round end');
  assert.equal(p.totalChunksToUpload, 7); assert.equal(p.uploadedChunksCount, 3);
  await m.handleStructuredMessage('FileUploadAck', { code: 200, vault: 'test', data: { path: 'idle.bin' } });
  assert.equal(p.concurrencyLimiter.activeKeys.size, 0);
}
console.log('PASS: idle note/file mtime replies and attachment upload handshake retain round ownership');
// 重命名/删除也占用上行槽位，空闲请求的确认须同样放行（含无路径旧版改名确认）。
for (const [action, handler, pendingKey] of [
  ['NoteRenameAck', noteOps.receiveNoteRenameAck, 'pendingNoteRenames'],
  ['FileRenameAck', fileOps.receiveFileRenameAck, 'pendingFileRenames'],
  ['NoteDeleteAck', noteOps.receiveNoteDeleteAck, 'pendingNoteDeleteAcks'],
  ['FileDeleteAck', fileOps.receiveFileDeleteAck, 'pendingFileDeleteAcks'],
  ['SettingDeleteAck', configOps.receiveConfigDeleteAck, 'pendingConfigDeleteAcks'],
]) {
  const m = makeManager(null), p = m.plugin;
  p.settings = { vault: 'test', concurrencyControlEnabled: true, maxConcurrentUploads: 1 };
  p.concurrencyLimiter = new ConcurrencyLimiter(p);
  await p.concurrencyLimiter.waitForSlot('idle', true);
  p.retryQueue = { matchesAck: () => false, shouldIgnoreAck: () => false };
  const entry = { oldPath: 'old', newPath: 'idle', contentHash: 'hash' };
  p[pendingKey] = action === 'FileRenameAck' ? [entry] : action === 'NoteRenameAck' ? new Map([['idle', entry]]) : new Set(['idle']);
  const changed = [];
  p.fileHashManager = p.configHashManager = { isReady: () => true, setFileHash: path => changed.push(path), removeFileHash: path => changed.push(path) };
  p.app = { vault: { getFileByPath: () => ({ stat: {} }) } };
  p.localStorageManager = { setMetadata: () => assert.fail('no mid-round cursor advance') };
  p.syncState.activeSyncContext = 'round'; p.isSyncing = true;
  receiveOperators.set(action, handler);
  // 旧版改名没有 path，仍须按匹配项的槽位归属放行。
  await m.handleStructuredMessage(action, { code: 200, data: action.includes('Rename') ? {} : { path: 'idle' } });
  assert.equal(p.concurrencyLimiter.activeKeys.size, 0, `${action}: idle operation releases its own slot`);
  assert.ok(changed.includes('idle'), `${action}: baseline committed`);
}
console.log('PASS: idle rename/delete ACKs, including legacy pathless renames, release their own slots and commit baselines');
