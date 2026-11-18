import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const notices = [], logs = [];
const noop = () => {};
const module = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('src/lib/sync/operator_note.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
vm.runInNewContext(code, { module, exports: module.exports, console, Error,
  window: { setTimeout: fn => fn() },
  require: id => id === 'obsidian' ? { normalizePath: p => p }
    : id.includes('helpers') ? new Proxy({ isPathExcluded: () => false,
        showSyncNotice: (...args) => notices.push(args), checkAndNotifyCaseConflict: () => false }, { get: (t, k) => t[k] ?? noop })
    : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => ({ addLog: (...args) => logs.push(args) }) } }
    : id.includes('sync_state') ? { advanceLiveSyncTime: (plugin, field, lastTime) => { if (lastTime && lastTime > Number(plugin.localStorageManager.getMetadata(field))) plugin.localStorageManager.setMetadata(field, lastTime); } }
    : id.includes('i18n') ? { $: k => k } : {} });

for (const path of ['test:colon/note.md', 'notes/test:colon.md', 'notes/valid.md']) {
  notices.length = 0; logs.length = 0;
  let completed = 0, hashes = 0, removed = 0, creates = 0;
  const plugin = {
    settings: { syncEnabled: true },
    app: { vault: { getFileByPath: () => null, getFolderByPath: () => null,
      createFolder: async p => { if (p.includes(':')) throw new Error('File name cannot contain colon'); },
      create: async p => { creates++; if (p.includes(':')) throw new Error('File name cannot contain colon'); } } },
    lockManager: { withLock: async (_p, fn) => fn() }, addIgnoredFile: noop, removeIgnoredFile: () => removed++,
    fileHashManager: { setFileHash: () => hashes++ }, lastSyncMtime: new Map(),
    pendingNoteModifies: new Map(), pendingNoteDeleteAcks: new Map(), localStorageManager: { savePending: noop },
    noteSyncTasks: { failed: 0 }, recordSyncCompleted: () => completed++,
  };
  await module.exports.receiveNoteSyncModify({ path, content: 'remote', mtime: 1, pageIndex: 2 }, plugin);
  const failed = path.includes(':');
  assert.equal(plugin.noteSyncTasks.failed, Number(failed));
  assert.equal(completed, 1);
  assert.equal(removed, 1);
  assert.equal(hashes, failed ? 0 : 1, 'failed creates must not establish a successful baseline');
  assert.equal(notices.length, failed ? 1 : 0, 'unsupported names must produce a visible failure notice');
  if (failed) {
    assert(notices[0][0].includes(path), 'notice identifies the original remote path');
    assert(notices[0][0].includes('colon'), 'notice includes the actual creation error');
    assert.equal(logs.length, 1);
  }
  assert.equal(creates, path.startsWith('test:') ? 0 : 1, 'paths are never silently rewritten');
  if (failed) {
    await module.exports.receiveNoteSyncModify({ path, content: 'remote', mtime: 1, pageIndex: 3 }, plugin);
    assert.equal(notices.length, 1, 'retries only notify once per path in this plugin session');
    assert.equal(logs.length, 2, 'every failed retry remains visible in the sync log');
    assert.equal(plugin.noteSyncTasks.failed, 2);
    assert.equal(completed, 2);
  }
}
console.log('Note creation failures: visible error and unchanged remote path passed');
