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
  isPathExcluded: () => false, checkAndNotifyCaseConflict: () => false,
  hashContent: x => x, addRandomParam: x => x, showSyncNotice: noop,
  safeStringify: v => JSON.stringify(v) ?? String(v), getPluginDir: () => '' };
const logs = [];
const logMgr = { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop, logReceivedMessage: noop, logSentMessage: noop }) };
function load(file, extra = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, Map, Set, JSON,
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

// 手动闸门保证能观察到异步修改尚未完成时，改名及新广播都不能超前。
const m = makeManager('round');
const events = [];
let finishModify;
const handler = async data => {
  events.push(`start:${data.step}`);
  if (data.step === 'modify') await new Promise(resolve => { finishModify = resolve; });
  events.push(`end:${data.step}`);
};
receiveOperators.set('NoteSyncModify', handler);
receiveOperators.set('NoteSyncRename', handler);
for (const step of ['modify', 'rename']) {
  m.handleStructuredMessage(step === 'modify' ? 'NoteSyncModify' : 'NoteSyncRename',
    { code: 200, vault: 'test', data: { path: 'same.md', oldPath: 'same.md', step } });
}
m.plugin.syncState.activeSyncContext = null;
// timer 尚未开始时到达的新消息也应排到旧队列后。
m.handleStructuredMessage('NoteSyncModify', { code: 200, vault: 'test', data: { path: 'same.md', step: 'before-drain' } });
assert.deepEqual(events, [], 'live message cannot overtake a scheduled backlog');
const draining = timers.shift()();
await Promise.resolve();
assert.deepEqual(events, ['start:modify'], 'rename waits for async modify');
m.handleStructuredMessage('NoteSyncModify', { code: 200, vault: 'test', data: { path: 'same.md', step: 'during-drain' } });
assert.deepEqual(events, ['start:modify'], 'new live message waits behind old messages');
finishModify();
await draining;
await new Promise(setImmediate);
await flushTimers();
assert.deepEqual(events, ['start:modify', 'end:modify', 'start:rename', 'end:rename',
  'start:before-drain', 'end:before-drain', 'start:during-drain', 'end:during-drain']);
assert.equal(m.deferredMessages.length, 0);
console.log('PASS: async deferred handlers and new live messages execute serially in arrival order');

// 新一轮在 await 期间开始：旧回放在当前处理完成后暂停，结束后继续。
{
  const m = makeManager('first');
  const order = [];
  let release;
  receiveOperators.set('NoteSyncModify', async data => {
    order.push(data.path);
    if (data.path === 'first') await new Promise(resolve => { release = resolve; });
  });
  for (const path of ['first', 'second']) m.handleStructuredMessage('NoteSyncModify', { code: 200, data: { path } });
  m.plugin.syncState.activeSyncContext = null;
  timers.shift()();
  await Promise.resolve();
  m.plugin.syncState.activeSyncContext = 'next';
  release();
  await new Promise(setImmediate);
  assert.deepEqual(order, ['first']);
  m.plugin.syncState.activeSyncContext = null;
  await flushTimers();
  assert.deepEqual(order, ['first', 'second']);
}
// 断线使旧 timer / drain 作废，不能与新连接的 drain 同时消费新队列。
{
  const m = makeManager('first');
  const order = [];
  let release;
  receiveOperators.set('NoteSyncModify', async data => {
    order.push(data.path);
    if (data.path === 'old-running') await new Promise(resolve => { release = resolve; });
  });
  for (const path of ['old-running', 'old-queued']) m.handleStructuredMessage('NoteSyncModify', { code: 200, data: { path } });
  m.plugin.syncState.activeSyncContext = null;
  timers.shift()();
  await Promise.resolve();
  m.clearDeferredMessages();
  m.plugin.syncState.activeSyncContext = 'reconnected';
  m.handleStructuredMessage('NoteSyncModify', { code: 200, data: { path: 'new' } });
  m.plugin.syncState.activeSyncContext = null;
  release();
  await new Promise(setImmediate);
  assert.deepEqual(order, ['old-running']);
  await flushTimers();
  assert.deepEqual(order, ['old-running', 'new']);
}
console.log('PASS: deferred replay pauses for a new round and invalidates old drains on disconnect');
