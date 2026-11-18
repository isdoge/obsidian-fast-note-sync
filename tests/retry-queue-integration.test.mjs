import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

let now = 1000000, timerId = 0;
const timers = new Map();
const window = { setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
  clearTimeout: id => timers.delete(id) };
const noop = () => {};
class TFile { constructor(path, content = 'same') { this.path = path; this.content = content; this.stat = { size: 4, mtime: 10 }; this.extension = path.split('.').pop(); } }
class TFolder { constructor(path) { this.path = path; this.children = []; } }
const obsidian = { TFile, TFolder, normalizePath: p => p, Platform: {}, Notice: class {}, moment: () => ({ format: () => '' }) };
const logManager = { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop, logSentMessage: noop, logReceivedMessage: noop }) };
const cache = new Map();
const modificationCalls = [];
let helpers;
const startupSyncCalls = [];
const startupSync = async p => startupSyncCalls.push(p);
const startupFullSync = async p => startupSyncCalls.push(p);
const receiveOperators = new Map();
function load(rel) {
  const file = path.resolve(rel);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const require = id => {
    if (id === 'obsidian') return obsidian;
    if ((id.includes('utils/helpers') || id === './helpers') && helpers) return helpers;
    if (id.includes('helpers_obsidian_bypass')) return { dump: noop, dumpError: noop };
    if (id.includes('i18n/lang')) return { $: k => k };
    if (id.includes('sync_log_manager')) return { SyncLogManager: logManager };
    if (id.endsWith('/helpers_obsidian_bypass') || id === '../helpers_obsidian_bypass') return { dump: noop, dumpError: noop };
    if (id.startsWith('../sync/operator_')) return { noteModify: f => modificationCalls.push(f.path), fileModify: f => modificationCalls.push(f.path), folderModify: noop };
    if (id === './operator') return { receiveOperators, startupSync, startupFullSync, handleSync: startupSync, cancelSync: noop, checkSyncCompletion: noop };
    if (id === '../utils/types') return { CLIENT_TYPE: 'test' };
    if (id.includes('http_api_service')) return { HttpApiService: class {
      constructor(p) { this.p = p; }
      async getRetryQueueState(kind, p) { return this.p.remote.get(p) ?? null; }
    } };
    if (id.includes('websocket_action')) return new Proxy({}, { get: (_, k) => k });
    if (['./sync_state', './concurrency_limiter', './operator_note', './operator_file', './operator_folder'].includes(id)) return load(path.resolve(path.dirname(file), id + '.ts'));
    return {};
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText, { module, exports: module.exports, require, window, console, URLSearchParams, TextEncoder,
    ArrayBuffer, Uint8Array, crypto: globalThis.crypto, activeDocument: undefined,
    Date: class extends Date { static now() { return now; } } });
  return module.exports;
}
helpers = { ...load('src/lib/utils/helpers.ts'), isPathExcluded: () => false, isFolderSyncPathExcluded: () => false };
const { RetryQueue } = load('src/lib/sync/retry_queue.ts');
const { EventManager } = load('src/lib/utils/events_manager.ts');
const { ConcurrencyLimiter } = load('src/lib/sync/concurrency_limiter.ts');
const { WebSocketManager } = load('src/lib/sync/websocket_manager.ts');
const noteOps = load('src/lib/sync/operator_note.ts'), fileOps = load('src/lib/sync/operator_file.ts'), folderOps = load('src/lib/sync/operator_folder.ts');
for (const [action, handler] of [ ['NoteDeleteAck', noteOps.receiveNoteDeleteAck], ['NoteRenameAck', noteOps.receiveNoteRenameAck],
  ['FileDeleteAck', fileOps.receiveFileDeleteAck], ['FileRenameAck', fileOps.receiveFileRenameAck],
  ['FolderDeleteAck', (d, p) => folderOps.receiveFolderRetryAck('FolderDeleteAck', d, p)],
  ['FolderRenameAck', (d, p) => folderOps.receiveFolderRetryAck('FolderRenameAck', d, p)] ]) receiveOperators.set(action, handler);
async function settle() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
async function advance(ms) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } await settle(); }
function fixture(disk = new Map()) {
  const local = new Map(), baseline = new Map(), remote = new Map(), sent = [], snapshots = new Map();
  const plugin = {
    settings: { syncEnabled: true, vault: 'v', api: 'https://s', apiToken: 't', concurrencyControlEnabled: true, maxConcurrentUploads: 2 },
    manifest: { id: 'fast-note-sync', dir: '.obsidian/plugins/fast-note-sync' },
    local, baseline, remote, sent,
    isSyncing: false, syncState: { activeSyncContext: null, retiredSyncContexts: new Set(), hasSyncedThisConnection: true },
    pendingNoteModifies: new Map(), pendingUploadHashes: new Map(), pendingNoteDeleteAcks: new Set(), pendingFileDeleteAcks: new Set(),
    pendingNoteRenames: new Map(), pendingFileRenames: [], lastSyncPathDeleted: new Set(), lastSyncPathRenamed: new Set(),
    app: { vault: { configDir: '.obsidian', getAbstractFileByPath: p => local.get(p) ?? null,
      getFileByPath: p => local.get(p) ?? null, read: async f => f.content,
      adapter: { exists: async p => disk.has(p), read: async p => disk.get(p), write: async (p, text) => { disk.set(p, text); } } } },
    localStorageManager: { savePending: noop, getInternalExcludes: () => [], setInternalExcludes: noop,
      getMetadata: () => 5, setMetadata: () => assert.fail('queue ACK must not advance time') },
    isIgnoredFile: () => false, addIgnoredFile: noop, removeIgnoredFile: noop,
    fileHashManager: { getPathHash: p => baseline.get(p) ?? null, removeFileHash: p => baseline.delete(p), setFileHash: (p, h) => baseline.set(p, h) },
    folderSnapshotManager: { removeFolder: p => snapshots.delete(p), setFolderMtime: (p, t) => snapshots.set(p, t) },
    recordSyncCompleted: () => assert.fail('queue ACK must not count toward a scan'),
    lockManager: { async withLock(p, fn) { if (plugin.lockBusy) return null; return fn(); } },
  };
  plugin.concurrencyLimiter = new ConcurrencyLimiter(plugin);
  const manager = Object.create(WebSocketManager.prototype);
  Object.assign(manager, { plugin, deferredMessages: [], deferredBytes: 0, replayScheduled: false, receivedFileDetails: new Set(),
    client: { isAuth: false, isOpen: false, notifyActivity: noop,
      async SendMessage(action, data, before, after) {
        if (before?.()) return true;
        if (plugin.drain) await plugin.drain;
        if (before?.()) return true;
        if (!this.isOpen) return;
        sent.push({ action, ...data }); after?.();
      } },
  });
  plugin.websocket = manager;
  plugin.retryQueue = new RetryQueue(plugin);
  plugin.events = plugin.eventManager = new EventManager(plugin);
  return plugin;
}
async function auth(p) { p.websocket.client.isAuth = p.websocket.client.isOpen = true; void p.retryQueue.onAuthenticated(); await settle(); }
function ack(p, action, path, context) {
  p.websocket.handleStructuredMessage(action, { code: 200, vault: 'v', context, data: { path, lastTime: 9999 } });
}
const diskPath = '.obsidian/plugins/fast-note-sync/retryQueue.json';
// Real events -> real operators -> manager -> ACK dispatch; all three object types.
for (const kind of ['note', 'file', 'folder']) for (const operation of ['delete', 'rename']) {
  const disk = new Map(), p = fixture(disk); await p.retryQueue.initialize();
  const ext = kind === 'note' ? '.md' : kind === 'file' ? '.png' : '';
  const old = `a${ext}`, target = `b${ext}`;
  const item = kind === 'folder' ? new TFolder(operation === 'delete' ? old : target) : new TFile(operation === 'delete' ? old : target);
  p.baseline.set(old, helpers.hashContent('same')); p.remote.set(old, { path: old, contentHash: helpers.hashContent('same') });
  if (operation === 'rename') p.local.set(target, item);
  if (kind === 'folder') await auth(p); // Directory fallback is continuous-connection only.
  p.lockBusy = true;
  if (operation === 'delete') p.events.watchDelete(item); else p.events.watchRename(item, old);
  await settle(); assert.equal(p.retryQueue.entries.length, 1, `${kind} ${operation}: durable before lock/auth`);
  assert.equal(JSON.parse(disk.get(diskPath)).entries.length, 1);
  if (kind !== 'folder') await auth(p);
  assert.equal(p.sent.length, 0);
  await advance(120000); assert.equal(p.retryQueue.entries.length, 1, 'lock retries have no 60-attempt cutoff');
  p.lockBusy = false; await advance(2000); assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0].context, '', 'retry request must carry no round context');
  assert.equal(p.concurrencyLimiter.getSlotContext(item.path), null);
  await advance(2000); assert.equal(p.sent.length, 2, 'real operator retries missing ACK');
  if (kind === 'file' && operation === 'rename') assert.equal(p.pendingFileRenames.length, 1, 'retry does not duplicate pending rename');
  p.syncState.activeSyncContext = 'new-round'; p.isSyncing = true;
  p.fileSyncTasks = { completed: 0 };
  p.websocket.handleStructuredMessage('Error', { code: 500, vault: 'v', data: { path: item.path } });
  assert.equal(p.fileSyncTasks.completed, 0, 'retry errors cannot increment a scan counter');
  const action = `${kind[0].toUpperCase() + kind.slice(1)}${operation === 'delete' ? 'Delete' : 'Rename'}Ack`;
  ack(p, action, item.path, 'retired'); // A retired round is rejected before queue matching.
  // Explicitly retire the context and retry; neither consumes the contextless queue operation.
  p.syncState.retiredSyncContexts.add('retired'); ack(p, action, item.path, 'retired');
  assert.equal(p.retryQueue.entries.length, 1);
  ack(p, action, 'unrelated'); assert.equal(p.retryQueue.entries.length, 1);
  ack(p, action, item.path); await settle(); assert.equal(p.retryQueue.entries.length, 0);
  assert.equal(p.concurrencyLimiter.getSlotContext(item.path), undefined);
  p.retryQueue.stop(); timers.clear();
}
// StartHandle waits for the queue after authentication; a stuck lock cannot start a competing scan.
{
  const p = fixture(); await p.retryQueue.initialize(); p.lockBusy = true;
  p.baseline.set('a.md', 'h'); p.remote.set('a.md', { path: 'a.md', contentHash: 'h' });
  p.events.watchDelete(new TFile('a.md'));
  startupSyncCalls.length = 0; p.fileHashManager.isReady = () => true;
  p.syncState.negotiated = true; p.websocket.currentStartHandleId = 0;
  p.websocket.client.isAuth = p.websocket.client.isOpen = true;
  const started = p.websocket.StartHandle(); await settle();
  assert.equal(startupSyncCalls.length, 0); assert.equal(p.retryQueue.entries.length, 1);
  p.lockBusy = false; await advance(2000); await settle();
  assert.equal(p.sent.length, 1); assert.equal(startupSyncCalls.length, 0);
  ack(p, 'NoteDeleteAck', 'a.md'); await started;
  assert.equal(startupSyncCalls.length, 1); p.retryQueue.stop(); timers.clear();
}
// A replay failure or disconnect releases startup instead of deadlocking regular sync.
for (const mode of ['failure', 'disconnect']) {
  const p = fixture(); await p.retryQueue.initialize(); startupSyncCalls.length = 0;
  p.fileHashManager.isReady = () => true; p.syncState.negotiated = true; p.websocket.currentStartHandleId = 0;
  p.websocket.client.isAuth = p.websocket.client.isOpen = true;
  p.retryQueue.onAuthenticated = async () => {
    if (mode === 'failure') throw new Error('simulated replay failure');
    p.websocket.client.isAuth = p.websocket.client.isOpen = false;
  };
  await p.websocket.StartHandle();
  assert.equal(startupSyncCalls.length, mode === 'failure' ? 1 : 0, mode);
  p.retryQueue.stop(); timers.clear();
}
// Actual LocalStateFileMirror survives reconstruction and never stores text or the token.
{
  const disk = new Map(), p = fixture(disk); await p.retryQueue.initialize();
  p.baseline.set('a.md', 'h'); p.events.watchDelete(new TFile('a.md')); await settle(); p.retryQueue.stop();
  assert.equal(disk.get(diskPath).includes('apiToken'), false);
  const q = fixture(disk); q.remote.set('a.md', { path: 'a.md', contentHash: 'h' }); await q.retryQueue.initialize(); await auth(q);
  assert.equal(q.sent.length, 1, 'disk restore uses recorded baseline, not rebuilt hash map');
  ack(q, 'NoteDeleteAck', 'a.md'); q.retryQueue.stop(); timers.clear();
}
// A coalesced operation waiting on buffer drain must not leak to the socket.
{
  const p = fixture(); await p.retryQueue.initialize(); await auth(p);
  p.baseline.set('a.md', 'h'); p.remote.set('a.md', { path: 'a.md', contentHash: 'h' });
  let release; p.drain = new Promise(r => { release = r; });
  p.events.watchDelete(new TFile('a.md')); await settle();
  p.local.set('a.md', new TFile('a.md')); p.events.watchCreate(p.local.get('a.md'));
  release(); await settle(); assert.equal(p.sent.filter(s => s.action === 'NoteDelete').length, 0);
  p.retryQueue.stop(); timers.clear();
}
// Scan send uses read-only missing paths for rejected operations, even with offline delete on.
{
  const p = fixture(); await p.retryQueue.initialize();
  p.baseline.set('a.md', 'old'); p.remote.set('a.md', { path: 'a.md', contentHash: 'new' });
  p.events.watchDelete(new TFile('a.md')); await auth(p);
  p.settings.offlineDeleteSyncEnabled = true;
  p.syncState.syncUpChunkNum = 100; p.syncState.pipelineWindowUp = 0;
  p.pendingDeleteNotePaths = new Set(); p.pendingDeleteFilePaths = new Set(); p.pendingDeleteFolderPaths = new Set();
  p.websocket.SendMessage = async (action, data, before, after) => { p.sent.push({ action, ...data }); after?.(); };
  const operatorFile = path.resolve('src/lib/sync/operator.ts');
  const { handleRequestSend } = load(operatorFile);
  await handleRequestSend(p, 'note', { notes: [], delNotes: [{ path: 'a.md', pathHash: 'h' }], missingNotes: [], lastTime: 5 },
    { files: [], delFiles: [], missingFiles: [], lastTime: 5 }, { configs: [], delConfigs: [], missingConfigs: [], lastTime: 5 },
    { folders: [], delFolders: [], missingFolders: [], lastTime: 5 });
  const request = p.sent.find(s => s.action === 'NoteSync');
  assert.equal(request.delNotes.length, 0);
  assert.deepEqual([...request.missingNotes].map(i => i.path), ['a.md']);
  assert.equal(p.pendingDeleteNotePaths.size, 0);
  p.retryQueue.stop(); timers.clear();
}
// Restored rename uses the queued server baseline even when local contents changed since rename.
{
  const disk = new Map(), p = fixture(disk); await p.retryQueue.initialize();
  p.baseline.set('a.md', 'original'); p.events.watchRename(new TFile('b.md'), 'a.md'); await settle(); p.retryQueue.stop();
  const q = fixture(disk); q.local.set('b.md', new TFile('b.md', 'edited after rename'));
  q.remote.set('a.md', { path: 'a.md', contentHash: 'original' }); await q.retryQueue.initialize(); await auth(q);
  assert.equal(q.pendingNoteRenames.get('b.md').contentHash, 'original');
  ack(q, 'NoteRenameAck', 'b.md'); assert.equal(q.baseline.get('b.md'), 'original');
  q.retryQueue.stop(); timers.clear();
}
// Cancellation while waiting for a real concurrency slot settles the stale waiter safely.
{
  const p = fixture(); await p.retryQueue.initialize(); await auth(p);
  p.settings.maxConcurrentUploads = 1;
  await p.concurrencyLimiter.waitForSlot('occupied');
  p.baseline.set('a.md', 'h'); p.remote.set('a.md', { path: 'a.md', contentHash: 'h' });
  p.events.watchDelete(new TFile('a.md')); await settle();
  p.local.set('a.md', new TFile('a.md')); p.events.watchCreate(p.local.get('a.md'));
  p.concurrencyLimiter.releaseSlot('occupied'); await settle();
  assert.equal(p.sent.length, 0); assert.equal(p.concurrencyLimiter.getSlotContext('a.md'), undefined);
  p.retryQueue.stop(); timers.clear();
}
// Cancellation while the path lock waits must not enter the send path with a fresh identity.
{
  const p = fixture(); await p.retryQueue.initialize(); await auth(p);
  p.baseline.set('a.md', 'h'); p.remote.set('a.md', { path: 'a.md', contentHash: 'h' });
  let release; p.lockManager.withLock = async (path, fn) => { await new Promise(r => { release = r; }); return fn(); };
  p.events.watchDelete(new TFile('a.md')); await settle();
  p.local.set('a.md', new TFile('a.md')); p.settings.manualSyncEnabled = true; p.events.watchCreate(p.local.get('a.md'));
  release(); await settle(); assert.equal(p.sent.length, 0);
  p.retryQueue.stop(); timers.clear();
}
// Modify events held behind an unsent rename are resumed after its terminal ACK.
{
  const p = fixture(); await p.retryQueue.initialize(); modificationCalls.length = 0;
  const file = new TFile('b.md'); p.local.set(file.path, file);
  p.baseline.set('a.md', 'h'); p.remote.set('a.md', { path: 'a.md', contentHash: 'h' });
  p.events.watchRename(file, 'a.md'); p.events.watchModify(file); await settle();
  assert.equal(modificationCalls.length, 0);
  await auth(p); await settle(); assert.equal(p.sent.length, 1);
  p.pendingNoteRenames.set('b.md', { oldPath: 'a.md', newPath: 'b.md', contentHash: 'h' });
  p.events.watchModify(file);
  ack(p, 'NoteRenameAck', 'b.md'); await advance(0);
  assert.deepEqual(modificationCalls, ['b.md']);
  p.retryQueue.stop(); p.events.stop(); timers.clear();
}
// Once sent, an edit follows the normal modify path and blocks the stale rename retransmission.
{
  const p = fixture(); await p.retryQueue.initialize(); await auth(p); modificationCalls.length = 0;
  const file = new TFile('b.md'); p.local.set(file.path, file);
  p.baseline.set('a.md', 'h'); p.remote.set('a.md', { path: 'a.md', contentHash: 'h' });
  p.events.watchRename(file, 'a.md'); await settle();
  p.events.watchModify(file); await settle(); assert.deepEqual(modificationCalls, ['b.md']);
  file.stat.mtime++; await advance(2000);
  assert.equal(p.sent.filter(s => s.action === 'NoteRename').length, 1);
  assert.equal(p.retryQueue.entries.length, 0); p.retryQueue.stop(); p.events.stop(); timers.clear();
}
// A remote create echo must not cancel a pending local tombstone; a real local create still does.
{
  const p = fixture(); await p.retryQueue.initialize();
  p.baseline.set('a.md', 'h'); p.events.watchDelete(new TFile('a.md'));
  p.isIgnoredFile = path => path === 'a.md'; p.events.watchCreate(new TFile('a.md'));
  assert.equal(p.retryQueue.entries.length, 1, 'remote create echo cannot cancel local delete');
  p.isIgnoredFile = () => false; p.events.watchCreate(new TFile('a.md'));
  assert.equal(p.retryQueue.entries.length, 0, 'local recreate cancels local delete');
  p.retryQueue.stop(); timers.clear();
}
// The actual EventManager -> queue boundary rejects both-path remote rename echoes.
for (const operation of ['delete', 'rename']) {
  const p = fixture(); await p.retryQueue.initialize(); const item = new TFile('b.md');
  p.lastSyncPathRenamed.add('b.md'); p.isIgnoredFile = path => path === 'b.md' || path === 'a.md';
  if (operation === 'delete') p.events.watchDelete(new TFile('a.md'));
  else p.events.watchRename(item, 'a.md');
  assert.equal(p.retryQueue.entries.length, 0, `remote ${operation} echo must not be queued`);
  p.retryQueue.stop(); timers.clear();
}
// Duplicate action/path identities require a fresh socket; old ACKs cannot confirm a new event.
{
  const p = fixture(); await p.retryQueue.initialize(); await auth(p);
  p.baseline.set('a.md', 'h'); p.remote.set('a.md', { path: 'a.md', contentHash: 'h' });
  p.events.watchDelete(new TFile('a.md')); await settle(); ack(p, 'NoteDeleteAck', 'a.md');
  ack(p, 'NoteDeleteAck', 'a.md'); // duplicate must not advance the cursor
  let reconnects = 0;
  p.websocket.unRegister = () => { p.websocket.client.isAuth = p.websocket.client.isOpen = false; p.retryQueue.onDisconnected(); p.concurrencyLimiter.clear(); };
  p.websocket.triggerReconnect = () => { reconnects++; void auth(p); };
  p.baseline.set('a.md', 'new'); p.remote.set('a.md', { path: 'a.md', contentHash: 'new' });
  p.events.watchDelete(new TFile('a.md')); await settle();
  assert.equal(reconnects, 1); assert.equal(p.sent.length, 2);
  ack(p, 'NoteDeleteAck', 'a.md'); assert.equal(p.retryQueue.entries.length, 0);
  p.retryQueue.stop(); timers.clear();
}
console.log('retry-queue-integration.test.mjs: real event/send/ACK/mirror/scan scenarios passed');
