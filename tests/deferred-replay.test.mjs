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
const flushTimers = async () => { while (timers.length) { const t = timers.shift(); t(); await Promise.resolve(); } };

// 1+2. 活跃轮中收到无 context 的 NoteSyncModify / 其它设备 context 的 FolderSyncModify：不立即处理、不丢；轮结束后处理一次
{
  const m = makeManager('round-1');
  m.handleStructuredMessage('NoteSyncModify', { code: 200, vault: 'test', data: { path: 'a.md', content: 'x' } });
  m.handleStructuredMessage('FolderSyncModify', { code: 200, vault: 'test', context: 'device-B-round', data: { path: 'dir' } });
  assert.equal(received.length, 0, 'during active round: deferred messages are not processed immediately');
  m.plugin.syncState.activeSyncContext = null;   // 轮次结束
  await flushTimers();
  assert.equal(received.length, 2, 'after round ends: both deferred messages are replayed once');
  assert.equal(received[0][0], 'NoteSyncModify', 'replay preserves arrival order (1)');
  assert.equal(received[1][0], 'FolderSyncModify', 'replay preserves arrival order (2)');
  assert.equal(received[1][1].context, 'device-B-round', 'context from wire is merged into payload (same as live path)');
}

// 3. 本机已作废 context：丢弃，轮结束后也不处理
{
  received.length = 0; logs.length = 0;
  const m = makeManager('round-2', ['round-1']);
  m.handleStructuredMessage('NoteSyncModify', { code: 200, vault: 'test', context: 'round-1', data: { path: 'a.md' } });
  m.plugin.syncState.activeSyncContext = null;
  await flushTimers();
  assert.equal(received.length, 0, 'retired context of this client is discarded, never replayed');
  assert.ok(logs.some(l => l[1] && String(l[1]).includes('Discard message NoteSyncModify')), 'discard still logged as before');
}

// 4. 带本轮 context 的消息：立即处理（原行为）
{
  received.length = 0;
  const m = makeManager('round-3');
  m.handleStructuredMessage('NoteSyncModify', { code: 200, vault: 'test', context: 'round-3', data: { path: 'b.md' } });
  assert.equal(received.length, 1, 'matching context is processed immediately');
}

// 3b. 没有活跃轮次时（取消同步、停滞重启之后），本机已作废 context 的迟到消息同样丢弃
{
  received.length = 0; logs.length = 0;
  const m = makeManager('round-1');
  m.plugin.syncState.activeSyncContext = null;   // 取消同步：round-1 作废
  await flushTimers();
  m.handleStructuredMessage('NoteSyncModify', { code: 200, vault: 'test', context: 'round-1', data: { path: 'late.md' } });
  assert.equal(received.length, 0, 'idle: late message of a retired round is discarded');
  assert.ok(logs.some(l => l[1] && String(l[1]).includes('Discard message NoteSyncModify')), 'idle discard is logged');
}

// 5. 无活跃轮次：立即处理（原行为）
{
  received.length = 0;
  const m = makeManager(null);
  m.handleStructuredMessage('NoteSyncModify', { code: 200, vault: 'test', data: { path: 'c.md' } });
  m.handleStructuredMessage('FolderSyncModify', { code: 200, vault: 'test', context: 'other', data: { path: 'd' } });
  assert.equal(received.length, 2, 'no active round: any context processed immediately');
}

// 6. 回放顺序保持；回放期间新一轮开始则剩余消息继续等待
{
  received.length = 0;
  const m = makeManager('round-4');
  for (const p of ['1.md', '2.md', '3.md']) {
    m.handleStructuredMessage('NoteSyncModify', { code: 200, vault: 'test', data: { path: p } });
  }
  m.plugin.syncState.activeSyncContext = null;
  // 手动驱动第一个 timer 前先制造"新一轮已开始"：回放应停在队列前
  m.plugin.syncState.activeSyncContext = 'round-5';
  await flushTimers();
  assert.equal(received.length, 0, 'new round during replay window: rest stays queued');
  m.plugin.syncState.activeSyncContext = null;
  await flushTimers();
  assert.deepEqual(received.map(r => r[1].path), ['1.md', '2.md', '3.md'], 'queued messages replay in arrival order after the next drain');
  assert.equal(m.deferredMessages.length, 0, 'queue fully drained');
}

// 7a. 超限丢弃并有日志（条数上限用桩内绕过：直接把 bytes 顶满）
{
  received.length = 0; logs.length = 0;
  const m = makeManager('round-6');
  m.deferredBytes = 8 * 1024 * 1024; // 顶满字节预算
  m.handleStructuredMessage('NoteSyncModify', { code: 200, vault: 'test', data: { path: 'x.md' } });
  assert.equal(m.deferredMessages.length, 0, 'overflow drops the incoming message');
  assert.ok(logs.some(l => l[1] && String(l[1]).includes('Deferred queue overflow')), 'overflow logs a dump line');
  m.plugin.syncState.activeSyncContext = null;
  await flushTimers();
  assert.equal(received.length, 0, 'overflowed message is never replayed');
  assert.equal(m.plugin.syncState.hasSyncedThisConnection, false,
    'after an overflow drop the live cursor is frozen until the next clean round');
}

// 7a-2. 没有溢出的轮次结束后不动 hasSyncedThisConnection
{
  received.length = 0;
  const m = makeManager('round-6b');
  m.handleStructuredMessage('NoteSyncModify', { code: 200, vault: 'test', data: { path: 'y.md' } });
  m.plugin.syncState.activeSyncContext = null;
  await flushTimers();
  assert.equal(received.length, 1);
  assert.equal(m.plugin.syncState.hasSyncedThisConnection, true, 'no overflow: flag untouched');
}

// 7b. 断线清空队列：私有方法通过原型调用（onClose 桩过重，直接驱动同一方法）
{
  received.length = 0;
  const m = makeManager('round-7');
  m.handleStructuredMessage('NoteSyncModify', { code: 200, vault: 'test', data: { path: 'y.md' } });
  assert.equal(m.deferredMessages.length, 1);
  WebSocketManager.prototype.clearDeferredMessages.call(m);
  m.plugin.syncState.activeSyncContext = null;
  await flushTimers();
  assert.equal(received.length, 0, 'cleared queue replays nothing after the round ends');
}

// 8. 空白笔记探测场景：轮次中 NoteRePush 的应答 NoteSyncModify 不带 context → 延后 → 轮结束后 handler 被调用
{
  received.length = 0;
  const m = makeManager('round-8');
  m.handleStructuredMessage('NoteSyncModify', { code: 200, vault: 'test', data: { path: 'Daily/2026-11-18.md', content: 'server content', contentHash: 'h' } });
  assert.equal(received.length, 0, 'probe reply is deferred, not dropped (this is the #205 on-device failure)');
  m.plugin.syncState.activeSyncContext = null;
  await flushTimers();
  assert.equal(received.length, 1, 'probe reply reaches the NoteSyncModify handler after the round');
  assert.equal(received[0][1].content, 'server content', 'server content overwrites the local empty note via the normal handler');
}

console.log('PASS: context mismatch defers instead of dropping; retired contexts still discarded; replay order, overflow, disconnect-clear and empty-note probe covered');
