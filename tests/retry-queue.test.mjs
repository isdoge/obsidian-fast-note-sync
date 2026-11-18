import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

let now = 1000000, nextId = 0;
const timers = new Map(), disk = new Map(), logs = [];
const window = {
  setTimeout(fn, ms) { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id; },
  clearTimeout(id) { timers.delete(id); },
};
async function settle() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
async function advance(ms) {
  now += ms;
  for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
  await settle();
}
let uid = 0;
class Mirror {
  constructor(p, name) { this.name = name; }
  async read() { return disk.get(this.name) ?? null; }
  scheduleWrite(data) { this.data = data; }
  flush() { disk.set(this.name, this.data); }
}
const helpers = {
  LocalStateFileMirror: Mirror, computeMirrorDigest: s => `digest:${s}`, generateUUID: () => `id-${++uid}`,
  dump: (...args) => logs.push(args), isPathExcluded: () => false, isFolderSyncPathExcluded: () => false,
  hashContentAsync: async s => s, hashFileAsync: async (app, path) => app.vault.getAbstractFileByPath(path)?.hash,
};
const sends = [];
const ops = {};
for (const kind of ['Note', 'File', 'Folder']) {
  ops[`${kind.toLowerCase()}DeleteByPath`] = async (path, p) => {
    await p.lockManager.withLock(path, async () => {
      await p.concurrencyLimiter.waitForSlot(path);
      await p.websocket.SendMessage(`${kind}Delete`, { path });
    });
  };
  ops[`${kind.toLowerCase()}Rename`] = async (f, oldPath, p) => {
    await p.lockManager.withLock(f.path, async () => {
      await p.concurrencyLimiter.waitForSlot(f.path);
      await p.websocket.SendMessage(`${kind}Rename`, { path: f.path, oldPath });
    });
  };
}
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/sync/retry_queue.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module, exports: module.exports, window, console, Date: class extends Date { static now() { return now; } },
  require: id => id.includes('helpers') ? helpers : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => ({ addLog: (...args) => logs.push(args) }) } } : id.includes('http_api_service') ? { HttpApiService: class {
    constructor(p) { this.p = p; }
    async getRetryQueueState(kind, path) { if (this.p.queryError) throw Error('offline'); return this.p.remote.get(path) ?? null; }
  } } : id.includes('operator_') ? ops : id === 'obsidian' ? { TFolder: class {} } : {},
});
const { RetryQueue, RETRY_QUEUE_MAX_ENTRIES, RETRY_QUEUE_MAX_AGE_MS } = module.exports;
function make({ reset = true } = {}) {
  if (reset) { disk.clear(); timers.clear(); sends.length = 0; }
  const local = new Map(), remote = new Map(), baseline = new Map();
  const p = {
    settings: { api: 'https://s', vault: 'v', apiToken: 't', syncEnabled: true },
    isIgnoredFile: () => false, lastSyncPathDeleted: new Set(), lastSyncPathRenamed: new Set(),
    fileHashManager: { getPathHash: path => baseline.get(path) ?? null },
    app: { vault: { getAbstractFileByPath: path => local.get(path) ?? null, read: async f => f.hash } },
    remote, local, baseline,
    lockManager: { async withLock(path, fn) { if (p.lockBusy) return null; return fn(); } },
    concurrencyLimiter: { async waitForSlot() { return true; }, releaseSlot() {} },
    pendingNoteRenames: new Map(), pendingFileRenames: [], pendingNoteDeleteAcks: new Set(), pendingFileDeleteAcks: new Set(),
    websocket: { isAuth: false, isOpen: false, async SendMessage(action, data) {
      if (!p.retryQueue.canSend(action, data)) return;
      if (!this.isOpen) return;
      sends.push({ action, ...data, time: now }); p.retryQueue.onSent(action, data);
    } },
  };
  p.retryQueue = new RetryQueue(p);
  return p;
}
async function init(p) { await p.retryQueue.initialize(); }
function seed(p, path = 'a.md') { p.baseline.set(path, 'h'); p.remote.set(path, { path, contentHash: 'h' }); }
async function auth(p) { p.websocket.isAuth = p.websocket.isOpen = true; void p.retryQueue.onAuthenticated(); await settle(); }
function ack(p, action, path) { assert.equal(p.retryQueue.acknowledge(action, path), true); }

// 入队在认证/OPEN/抢锁之前，认证后串行发送，精确 ACK 出队。
{
  const p = make(); await init(p); seed(p);
  p.retryQueue.observe('note', 'delete', 'a.md'); await settle();
  assert.equal(sends.length, 0); assert.equal(p.retryQueue.entries.length, 1);
  assert.equal(JSON.parse(disk.get('retryQueue.json')).entries[0].baselineHash, 'h');
  p.lockBusy = true; await auth(p); assert.equal(sends.length, 0);
  await advance(60000); assert.equal(p.retryQueue.entries.length, 1);
  p.lockBusy = false; await advance(60000); assert.equal(sends.length, 1);
  assert.equal(p.retryQueue.acknowledge('NoteRenameAck', 'a.md'), false);
  assert.equal(p.retryQueue.acknowledge('NoteDeleteAck', 'other.md'), false);
  ack(p, 'NoteDeleteAck', 'a.md'); await settle(); assert.equal(p.retryQueue.entries.length, 0);
}
// 非 OPEN 不丢；磁盘恢复后核对服务端基线再回放。
{
  const p = make(); await init(p); seed(p); p.websocket.isAuth = true;
  p.retryQueue.observe('note', 'delete', 'a.md'); await settle(); assert.equal(sends.length, 0);
  p.retryQueue.stop();
  const q = make({ reset: false }); seed(q); await init(q); await auth(q);
  assert.equal(sends.length, 1); ack(q, 'NoteDeleteAck', 'a.md'); q.retryQueue.stop();
}
// 确认丢失退避，每次重试都核对远端；连接断开停止计时。
{
  const p = make(); await init(p); seed(p); await auth(p);
  p.retryQueue.observe('note', 'delete', 'a.md'); await settle(); assert.equal(sends.length, 1);
  for (const delay of [2000, 5000, 15000, 60000, 60000]) {
    const count = sends.length; await advance(delay - 1); assert.equal(sends.length, count);
    await advance(1); assert.equal(sends.length, count + 1);
  }
  p.websocket.isAuth = p.websocket.isOpen = false; p.retryQueue.onDisconnected();
  assert.equal(p.retryQueue.canSend('NoteDelete', { path: 'a.md' }), false);
  await advance(60000); assert.equal(sends.length, 6);
  await auth(p); assert.equal(sends.length, 7); ack(p, 'NoteDeleteAck', 'a.md'); p.retryQueue.stop();
}
// 四种离线合并规则。
for (const scenario of ['recreate', 'chain', 'delete-new', 'roundtrip']) {
  const p = make(); await init(p); seed(p);
  if (scenario === 'recreate') {
    p.retryQueue.observe('note', 'delete', 'a.md'); p.retryQueue.onLocalCreate('a.md');
    assert.equal(p.retryQueue.entries.length, 0);
  } else {
    p.retryQueue.observe('note', 'rename', 'b.md', 'a.md');
    if (scenario === 'chain') { p.retryQueue.observe('note', 'rename', 'c.md', 'b.md');
      assert.equal(p.retryQueue.entries[0].oldPath, 'a.md'); assert.equal(p.retryQueue.entries[0].path, 'c.md');
    } else if (scenario === 'delete-new') { p.retryQueue.observe('note', 'delete', 'b.md');
      assert.equal(p.retryQueue.entries[0].operation, 'delete'); assert.equal(p.retryQueue.entries[0].path, 'a.md');
    } else { p.retryQueue.observe('note', 'rename', 'a.md', 'b.md'); assert.equal(p.retryQueue.entries.length, 0); }
  }
  p.retryQueue.stop();
}
// 本地删除恢复、新路径丢失、旧路径已重建且内容不同，都不得发送。
for (const scenario of ['delete-exists', 'rename-missing', 'old-changed', 'remote-changed', 'no-baseline', 'query-failed', 'target-exists']) {
  const p = make(); await init(p); seed(p);
  if (scenario === 'delete-exists') p.local.set('a.md', { path: 'a.md', hash: 'h' });
  if (scenario === 'remote-changed') p.remote.set('a.md', { path: 'a.md', contentHash: 'other' });
  if (scenario === 'no-baseline') p.baseline.clear();
  if (scenario === 'query-failed') p.queryError = true;
  const rename = ['rename-missing', 'old-changed', 'target-exists'].includes(scenario);
  if (rename && scenario !== 'rename-missing') p.local.set('b.md', { path: 'b.md', hash: 'h' });
  if (scenario === 'old-changed') p.local.set('a.md', { path: 'a.md', hash: 'other' });
  if (scenario === 'target-exists') p.remote.set('b.md', { path: 'b.md', contentHash: 'other' });
  p.retryQueue.observe('note', rename ? 'rename' : 'delete', rename ? 'b.md' : 'a.md', rename ? 'a.md' : undefined);
  await auth(p); assert.equal(sends.length, 0, scenario); assert.equal(p.retryQueue.entries.length, 0, scenario); p.retryQueue.stop();
}
// 有效改名；串行到确认才发送下一条，已回放路径供扫描去重。
{
  const p = make(); await init(p); seed(p); seed(p, 'x.png'); p.local.set('b.md', { path: 'b.md', hash: 'h' });
  p.retryQueue.observe('note', 'rename', 'b.md', 'a.md'); p.retryQueue.observe('file', 'delete', 'x.png');
  await auth(p); assert.equal(sends.length, 1); assert.equal(sends[0].action, 'NoteRename');
  assert.equal(p.retryQueue.shouldSkipScanDelete('a.md'), true);
  ack(p, 'NoteRenameAck', 'b.md'); await settle(); assert.equal(sends.length, 2);
  ack(p, 'FileDeleteAck', 'x.png'); p.retryQueue.stop();
}
// 作用域变化、损坏、过期、条目上限。
{
  const p = make(); await init(p); seed(p); p.retryQueue.observe('note', 'delete', 'a.md'); p.retryQueue.stop();
  const q = make({ reset: false }); q.settings.apiToken = 'changed'; await init(q); assert.equal(q.retryQueue.entries.length, 0);
  disk.set('retryQueue.json', '{bad'); const r = make({ reset: false }); await init(r); assert.equal(r.retryQueue.entries.length, 0);
  r.retryQueue.observe('note', 'delete', 'expired.md'); await advance(RETRY_QUEUE_MAX_AGE_MS + 1);
  r.retryQueue.observe('note', 'delete', 'fresh.md'); assert.equal(r.retryQueue.entries.length, 1);
  for (let i = 0; i < RETRY_QUEUE_MAX_ENTRIES + 1; i++) r.retryQueue.observe('note', 'delete', `n${i}.md`);
  assert.equal(r.retryQueue.entries.length, RETRY_QUEUE_MAX_ENTRIES); assert.equal(r.retryQueue.entries[0].path, 'n1.md'); r.retryQueue.stop();
}

// Failed verification must also protect the subsequent offline-delete scan and request a pull.
{
  const p = make(); await init(p); seed(p); p.remote.set('a.md', { path: 'a.md', contentHash: 'new-content' });
  p.retryQueue.observe('note', 'delete', 'a.md'); await auth(p);
  assert.equal(p.retryQueue.shouldSkipScanDelete('a.md'), true);
  assert.deepEqual([...p.retryQueue.getRecoveryPaths('note')], ['a.md']);
  p.retryQueue.completeScan(['setting']); assert.equal(p.retryQueue.shouldSkipScanDelete('a.md'), true);
  p.retryQueue.onDisconnected(); assert.deepEqual([...p.retryQueue.getRecoveryPaths('note')], ['a.md']);
  p.retryQueue.completeScan(['note']); assert.equal(p.retryQueue.shouldSkipScanDelete('a.md'), false); p.retryQueue.stop();
}
// Directory fallback never replays an offline/restored entry without a remote content version.
{
  const p = make(); await init(p); p.retryQueue.observe('folder', 'delete', 'dir'); await auth(p);
  assert.equal(sends.length, 0); assert.equal(p.retryQueue.entries.length, 0); p.retryQueue.stop();
}
// A sent rename and its successor remain ordered rather than rewriting an in-flight request.
{
  const p = make(); await init(p); seed(p); p.local.set('b.md', { path: 'b.md', hash: 'h' }); await auth(p);
  p.retryQueue.observe('note', 'rename', 'b.md', 'a.md'); await settle(); assert.equal(sends.length, 1);
  p.local.delete('b.md'); p.local.set('c.md', { path: 'c.md', hash: 'h' });
  p.retryQueue.observe('note', 'rename', 'c.md', 'b.md');
  assert.equal(p.retryQueue.entries.length, 2);
  p.remote.delete('a.md'); p.remote.set('b.md', { path: 'b.md', contentHash: 'h' });
  ack(p, 'NoteRenameAck', 'b.md'); await settle(); assert.equal(sends.length, 2);
  assert.equal(sends[1].oldPath, 'b.md'); assert.equal(sends[1].path, 'c.md');
  ack(p, 'NoteRenameAck', 'c.md'); p.retryQueue.stop();
}

// Corrupt JSON is discarded without throwing or retaining any destructive entry.
{
  const p = make(); disk.set('retryQueue.json', '{bad'); await init(p);
  assert.equal(p.retryQueue.entries.length, 0);
  assert.ok(logs.some(parts => String(parts[0]).includes('Corrupt file'))); p.retryQueue.stop();
}
// Every fingerprint component invalidates disk state, and malformed entry shapes are ignored.
for (const field of ['api', 'vault', 'apiToken']) {
  const p = make(); await init(p); seed(p); p.retryQueue.observe('note', 'delete', 'a.md'); p.retryQueue.stop();
  const q = make({ reset: false }); q.settings[field] = 'different'; await init(q);
  assert.equal(q.retryQueue.entries.length, 0, field); q.retryQueue.stop();
}
for (const raw of ['[]', 'null', '{}', '{"version":99}', '{"version":1,"scope":"wrong","entries":[]}']) {
  const p = make(); disk.set('retryQueue.json', raw); await init(p); assert.equal(p.retryQueue.entries.length, 0); p.retryQueue.stop();
}
assert.ok(logs.some(parts => String(parts[0]).includes('expired')));
assert.ok(logs.some(parts => String(parts[0]).includes('Limit exceeded')));
// An old local path with the same content is allowed; changed content was rejected above.
{
  const p = make(); await init(p); seed(p);
  p.local.set('a.md', { path: 'a.md', hash: 'h' }); p.local.set('b.md', { path: 'b.md', hash: 'h' });
  p.retryQueue.observe('note', 'rename', 'b.md', 'a.md'); await auth(p);
  assert.equal(sends.length, 1); ack(p, 'NoteRenameAck', 'b.md'); p.retryQueue.stop();
}
// A folder observed while connected cannot inherit that permission across reconstruction.
{
  const p = make(); await init(p); await auth(p); p.lockBusy = true;
  p.retryQueue.observe('folder', 'delete', 'dir'); await settle(); p.retryQueue.stop();
  const q = make({ reset: false }); await init(q); await auth(q);
  assert.equal(sends.length, 0); assert.equal(q.retryQueue.entries.length, 0); q.retryQueue.stop();
}
// A missing source path aborts deletion; a missing rename target must not become a new source delete.
for (const operation of ['delete', 'rename']) {
  const p = make(); await init(p); seed(p);
  if (operation === 'rename') p.local.set('b.md', { path: 'b.md', hash: 'h' });
  p.retryQueue.observe('note', operation, operation === 'rename' ? 'b.md' : 'a.md', operation === 'rename' ? 'a.md' : undefined);
  p.remote.delete('a.md'); await auth(p);
  assert.equal(sends.length, 0); assert.equal(p.retryQueue.entries.length, 0); p.retryQueue.stop();
}
// Both rename paths and a recreated source can be echoes of a remote landing, never fresh local events.
{
  const p = make(); await init(p); p.lastSyncPathRenamed.add('b.md');
  p.retryQueue.observe('note', 'delete', 'b.md');
  assert.equal(p.retryQueue.entries.length, 0);
  p.lastSyncPathRenamed.clear(); p.isIgnoredFile = path => path === 'b.md';
  p.retryQueue.observe('note', 'rename', 'b.md', 'a.md');
  assert.equal(p.retryQueue.entries.length, 0); p.retryQueue.stop();
}
// Read-only, manual, and disabled modes neither accept nor replay destructive operations.
for (const field of ['readonlySyncEnabled', 'manualSyncEnabled', 'syncEnabled']) {
  const p = make(); await init(p); seed(p);
  p.settings[field] = field === 'syncEnabled' ? false : true;
  p.retryQueue.observe('note', 'delete', 'a.md'); await auth(p);
  assert.equal(sends.length, 0, field); assert.equal(p.retryQueue.entries.length, 0, field); p.retryQueue.stop();
}
// Every retry revalidates the target: an edit while awaiting ACK invalidates the rename before retransmission.
{
  const p = make(); await init(p); seed(p); const file = { path: 'b.md', hash: 'h', stat: { mtime: 1 } };
  p.local.set(file.path, file); await auth(p);
  p.retryQueue.observe('note', 'rename', 'b.md', 'a.md'); await settle();
  assert.equal(sends.length, 1); file.stat.mtime = 2;
  await advance(2000); assert.equal(sends.length, 1); assert.equal(p.retryQueue.entries.length, 0);
  assert.deepEqual([...p.retryQueue.getRecoveryPaths('note')], ['a.md']); p.retryQueue.stop();
}
// While the first rename is in flight, later content edits follow the normal modify path.
{
  const p = make(); await init(p); seed(p); p.local.set('b.md', { path: 'b.md', hash: 'h' }); await auth(p);
  p.retryQueue.observe('note', 'rename', 'b.md', 'a.md'); await settle();
  p.eventManager = { resumeQueuedRename: () => { throw new Error('in-flight rename edit must not be deferred'); } };
  p.retryQueue.observe('note', 'rename', 'c.md', 'b.md');
  assert.equal(p.retryQueue.entries.length, 2); p.retryQueue.stop();
}
console.log('retry-queue.test.mjs: all scenarios passed');
