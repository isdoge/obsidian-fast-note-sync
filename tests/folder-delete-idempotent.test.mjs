import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const noop = () => {};
class TFolder { constructor(path) { this.path = path; this.children = []; } }
let onWait = noop;
const module = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('src/lib/sync/operator_folder.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
vm.runInNewContext(code, { module, exports: module.exports, console, Error,
  window: { setTimeout: fn => fn() },
  require: id => id === 'obsidian' ? { TFolder, normalizePath: p => p }
    : id.includes('helpers') ? new Proxy({ isFolderSyncPathExcluded: () => false,
        waitForFolderEmpty: async () => { onWait(); return true; } }, { get: (t, k) => t[k] ?? noop })
    : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => ({ addLog: noop }) } }
    : id.includes('remote_path_guard') ? { blockAliasedRemoteMutation: () => false } : {} });

for (const mode of ['gone-during-wait', 'stale-cache', 'still-exists', 'permission', 'normal', 'absent']) {
  const folder = new TFolder('old/child');
  let current = mode === 'absent' ? null : folder;
  let trashed = 0, snapshots = 0, completed = 0;
  onWait = () => { if (mode === 'gone-during-wait') current = null; };
  const plugin = {
    settings: { syncEnabled: true },
    lockManager: { withLock: async (_p, fn) => fn() }, addIgnoredFile: noop, removeIgnoredFile: noop,
    lastSyncPathDeleted: new Set(), folderSnapshotManager: { removeFolder: () => snapshots++ },
    localStorageManager: { getMetadata: () => 0, setMetadata: noop },
    folderSyncTasks: { failed: 0 }, recordSyncCompleted: () => completed++,
    app: { vault: { getAbstractFileByPath: () => current,
      adapter: { exists: async () => mode === 'still-exists' } },
      fileManager: { trashFile: async () => {
        trashed++;
        if (mode === 'normal') return;
        const e = new Error(mode === 'permission' ? 'EACCES' : 'ENOENT: lstat old/child');
        e.code = mode === 'permission' ? 'EACCES' : 'ENOENT';
        throw e;
      } } },
    lockManager: { withLock: async (_p, fn) => fn() },
    addIgnoredFile: noop, removeIgnoredFile: noop, lastSyncPathDeleted: new Set(),
    folderSnapshotManager: { removeFolder: () => snapshots++ },
    localStorageManager: { getMetadata: () => 0, setMetadata: noop },
    folderSyncTasks: { failed: 0 }, recordSyncCompleted: () => completed++,
  };
  await module.exports.receiveFolderSyncDelete({ path: folder.path, lastTime: 1, pageIndex: 2 }, plugin);
  assert.equal(plugin.folderSyncTasks.failed, ['still-exists', 'permission'].includes(mode) ? 1 : 0, mode);
  assert.equal(completed, 1, mode);
  if (mode === 'gone-during-wait') assert.equal(trashed, 0, 'do not trash a stale folder after parent cleanup');
  if (mode === 'stale-cache' || mode === 'normal') assert.equal(snapshots, 1, mode);
}
console.log('Folder deletion: parent cleanup races are idempotent; real failures remain errors');
