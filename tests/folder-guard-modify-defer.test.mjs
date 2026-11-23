import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// 已有目录收到服务端确认后不再屏蔽目录（避免连带丢弃目录下的本地改动）；
// 祖先目录屏蔽命中时，修改入口改为屏蔽解除后补一次，连续 5 次未解除才放弃并记录。
// An acknowledged existing folder must not be guarded (that silently dropped local edits under
// it); when an ancestor folder guard blocks a modify, the entry defers a replay after the guard
// clears and gives up (with a SyncLog entry) only after 5 consecutive reschedules.
const noop = () => {};
class TFile { constructor(p) { this.path = p; this.extension = p.split('.').pop(); this.stat = { size: 5, mtime: 10, ctime: 10 }; } }
class TFolder { constructor(p) { this.path = p; this.children = []; } }
class TAbstractFile { constructor(p) { this.path = p; } }

// 手动推进的定时器 / manually advanced timers
let now = 0, nextTimerId = 0;
const timers = new Map();
const window = {
  setTimeout(fn, ms) { const id = ++nextTimerId; timers.set(id, { fn, at: now + ms }); return id; },
  clearTimeout(id) { timers.delete(id); },
};
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function advance(ms) {
  now += ms;
  for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
  await settle();
}

const syncLogs = [];
const logManager = { getInstance: () => ({
  addLog: (type, action, message, status, path) => syncLogs.push({ type, action, message, status, path }),
  addOrUpdateLog: noop, logReceivedMessage: noop, logSentMessage: noop,
}) };
const i18n = { $: k => k };

function makeRequire(moduleFile, extra) {
  return id => {
    if (id === 'obsidian') return {
      TFile, TFolder, TAbstractFile, Menu: class {}, MenuItem: class {},
      Platform: {}, normalizePath: p => p,
    };
    if (id.includes('helpers_obsidian_bypass')) return { dump: noop, dumpError: noop, nativeFetch: noop, vaultDelete: async () => {}, setLogEnabled: noop, logLevel: {} };
    if (id.includes('sync_log_manager')) return { SyncLogManager: logManager };
    if (id.includes('i18n')) return i18n;
    if (id === '../../main') return {};
    if (id.includes('remote_path_guard')) return { blockAliasedRemoteMutation: () => false };
    if (id.includes('remote_delete_guard')) return { firstKeepWithoutBaseline: () => false };
    if (id.includes('baseline_scope')) return {
      buildBaselineFields: () => ({}), buildDeleteBaselineFields: () => ({}),
      baselineFieldsFromDeleteRecord: () => ({}),
    };
    if (id.includes('config_codec')) return {};
    const hit = extra && extra[id];
    if (hit !== undefined) return hit;
    return {};
  };
}

function load(file, extra = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Map, Set, JSON, Date, Promise,
    window, WebSocket: { OPEN: 1 }, URLSearchParams, TextEncoder, ArrayBuffer, Uint8Array,
    crypto: globalThis.crypto, activeDocument: undefined,
    require: makeRequire(file, extra),
  });
  return module.exports;
}

const helpers = load('src/lib/utils/helpers.ts');
const syncState = load('src/lib/sync/sync_state.ts');
const folderOps = load('src/lib/sync/operator_folder.ts', { './sync_state': syncState, './helpers': helpers, '../utils/helpers': helpers });
const noteOps = load('src/lib/sync/operator_note.ts', { './sync_state': syncState, './helpers': helpers, '../utils/helpers': helpers });
const { EventManager } = load('src/lib/utils/events_manager.ts', {
  '../sync/operator_note': noteOps,
  '../sync/operator_file': {},
  '../sync/operator_folder': folderOps,
  './helpers': helpers,
  '../utils/helpers': helpers,
});

function makePlugin({ existing = [], previousSync = true } = {}) {
  const local = new Map(existing.map(p => [p, p.endsWith('.md') ? new TFile(p) : new TFolder(p)]));
  const ignored = new Set();
  const meta = new Map([['lastFolderSyncTime', 100], ['lastNoteSyncTime', 100]]);
  const sent = [];
  const createCalls = [];
  const plugin = {
    settings: {
      syncEnabled: true, readonlySyncEnabled: false, vault: 'v',
      syncExcludeFolders: '', syncExcludeExtensions: '', syncExcludeWhitelist: '',
    },
    isSyncing: false,
    app: {
      vault: {
        configDir: '.obsidian',
        getAbstractFileByPath: p => local.get(p) ?? null,
        read: async () => 'hello',
        createFolder: async p => { createCalls.push(p); local.set(p, new TFolder(p)); },
      },
    },
    // 与 main.ts 的 isIgnoredFile / isIgnoredByAncestor 一致（前缀匹配走真实 isPathMatch）
    // Mirrors main.ts isIgnoredFile / isIgnoredByAncestor (prefix match via real isPathMatch)
    addIgnoredFile: p => ignored.add(p),
    removeIgnoredFile: p => ignored.delete(p),
    isIgnoredFile(p) { return ignored.has(p) || [...ignored].some(x => helpers.isPathMatch(p, x)); },
    isIgnoredByAncestor(p) { return !ignored.has(p) && this.isIgnoredFile(p); },
    lockManager: { withLock: async (_k, fn) => fn() },
    folderSnapshotManager: { setFolderMtime: noop, setConfirmedRevision: noop },
    recordSyncCompleted: noop,
    folderSyncTasks: { failed: 0 },
    noteSyncTasks: { failed: 0 },
    fileSyncTasks: { failed: 0 },
    localStorageManager: {
      getMetadata: k => meta.get(k) ?? 0,
      setMetadata: (k, v) => meta.set(k, v),
      savePending: noop,
    },
    syncState: { activeSyncContext: null, hasSyncedThisConnection: previousSync, conflictedPaths: new Set() },
    fileHashManager: { getPathHash: () => null, getValidHash: () => null, setFileHash: noop },
    lastSyncMtime: new Map(),
    pendingNoteDeleteAcks: new Set(),
    pendingNoteModifies: new Map(),
    concurrencyLimiter: { waitForSlot: async () => true },
    websocket: { isAuth: true, SendMessage: async (action, data) => sent.push({ action, ...data }) },
    retryQueue: undefined,
  };
  const em = new EventManager(plugin);
  plugin.eventManager = em;
  return { plugin, ignored, local, sent, createCalls, em, meta };
}

function assertCount(ignored, path, expected, label) {
  const actual = [...ignored].some(x => helpers.isPathMatch(path, x));
  assert.equal(actual, expected, label);
}

// 1. 目录已存在：收到确认后不再屏蔽目录及其下的新文件
// Existing folder: no guard, so a new file under it is not masked
{
  const { plugin, ignored } = makePlugin({ existing: ['dir'] });
  await folderOps.receiveFolderSyncModify({ path: 'dir', mtime: 2000, lastTime: 500 }, plugin);
  assert.equal(ignored.size, 0, 'existing folder: no ignored entry is added');
  assertCount(ignored, 'dir/new.md', false, 'existing folder: a new note under it is not ignored');
  assert.equal(plugin.app.vault.getAbstractFileByPath('dir') instanceof TFolder, true, 'folder still present');
  console.log('PASS: acknowledged existing folder does not guard its children');
}

// 2. 目录不存在：创建并只屏蔽 500ms，之后解除
// Missing folder: created and guarded for 500ms only
{
  const { plugin, ignored, createCalls } = makePlugin();
  await folderOps.receiveFolderSyncModify({ path: 'newdir', mtime: 2000, lastTime: 600 }, plugin);
  assert.deepEqual(createCalls, ['newdir'], 'missing folder is created');
  assertCount(ignored, 'newdir', true, 'created folder itself is guarded');
  assertCount(ignored, 'newdir/new.md', true, 'children are guarded during the window');
  await advance(499);
  assertCount(ignored, 'newdir', true, 'still guarded just before 500ms');
  await advance(1);
  assertCount(ignored, 'newdir', false, 'guard released after 500ms');
  console.log('PASS: created folder is guarded for exactly 500ms');
}

// 3a. 祖先命中后屏蔽解除：补传确实再次走到发送
// Ancestor hit, guard released: the deferred replay reaches the send path
{
  const { plugin, ignored, sent, em } = makePlugin({ existing: ['dir/new.md'] });
  const file = plugin.app.vault.getAbstractFileByPath('dir/new.md');
  ignored.add('dir');
  em.watchModify(file);
  await settle();
  assert.equal(sent.length, 0, 'guarded modify sends nothing yet');
  ignored.delete('dir');
  await advance(600);
  assert.equal(sent.filter(m => m.action === 'NoteModify').length, 1, 'replay after guard release sends NoteModify once');
  console.log('PASS: deferred modify replays and sends after the ancestor guard clears');
}

// 3b. 连续被屏蔽超过 5 次：放弃并留下 SyncLog error
// Still guarded after 5 reschedules: give up and leave a SyncLog error
{
  syncLogs.length = 0;
  const { plugin, ignored, sent, em } = makePlugin({ existing: ['dir/new.md'] });
  const file = plugin.app.vault.getAbstractFileByPath('dir/new.md');
  ignored.add('dir');
  em.watchModify(file);
  await settle();
  for (let i = 0; i < 5; i++) await advance(600);
  assert.equal(sent.length, 0, 'no send while the guard persists');
  const dropped = syncLogs.find(l => l.action === 'ModifyGuardDropped');
  assert.ok(dropped, 'a ModifyGuardDropped SyncLog entry is written');
  assert.equal(dropped.status, 'error', 'drop is logged as an error');
  assert.equal(dropped.path, 'dir/new.md', 'drop log carries the path');
  // 放弃后不再有定时器 / no timer left after giving up
  assert.equal([...timers.values()].filter(t => t.at > now).length, 0, 'no pending replay timer after giving up');
  await advance(600);
  assert.equal(sent.length, 0, 'no further replay after giving up');
  console.log('PASS: deferred modify gives up after 5 retries and logs an error');
}

// 4. 命中路径自身（远端落盘保护）：不排补传
// A hit on the path itself (remote write self-protection) is not deferred
{
  syncLogs.length = 0;
  const { plugin, ignored, em } = makePlugin({ existing: ['dir/new.md'] });
  const file = plugin.app.vault.getAbstractFileByPath('dir/new.md');
  ignored.add('dir/new.md');
  em.watchModify(file);
  await settle();
  assert.equal([...timers.values()].filter(t => t.at > now).length, 0, 'self-path hit schedules no replay');
  assert.equal(syncLogs.length, 0, 'self-path hit logs nothing');
  console.log('PASS: a hit on the path itself is still dropped without deferral');
}

console.log('folder guard / deferred modify tests passed');
