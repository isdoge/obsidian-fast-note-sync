import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// A receive handler whose path lock is never acquired did nothing; it must count as a failure
// (so the round's sync time falls back to its baseline) and still complete its page exactly once.
const root = path.resolve(import.meta.dirname, "..");
class TFile { constructor(path) { this.path = path; this.stat = { size: 1, mtime: 1 }; } }
class TFolder { constructor(path) { this.path = path; this.children = []; } }
const logs = [];
const helpers = new Proxy({
  isPathExcluded: () => false,
  isFolderSyncPathExcluded: () => false,
  checkAndNotifyCaseConflict: () => false,
  hashContentAsync: async () => "h",
}, { get: (target, name) => target[name] ?? (() => undefined) });
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const source = fs.readFileSync(path.join(root, `src/lib/sync/${name}.ts`), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console,
    window: { setTimeout: callback => callback() },
    require(id) {
      if (id === "obsidian") return { TFile, TFolder, normalizePath: p => p, Platform: { isMobile: false } };
      if (id === "./remote_path_guard") return { blockAliasedRemoteMutation: () => false };
      if (id === "./remote_delete_guard") return { firstKeepWithoutBaseline: () => true };
      if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: (...a) => logs.push(a) }) } };
      if (id === "../utils/helpers") return helpers;
      if (id === "../storage/file_cloud_preview") return { FileCloudPreview: { isRestrictedType: () => false } };
      if (id === "../api/http_api_service") return { HttpApiService: {} };
      if (id === "../../i18n/lang") return { $: key => key };
      throw new Error(`Unexpected import: ${id}`);
    },
  }, { filename: name });
  cache.set(name, module.exports);
  return module.exports;
}

function fixture(lockBusy) {
  const completed = [];
  const plugin = {
    settings: { syncEnabled: true, cloudPreviewEnabled: false },
    app: { vault: {
      getFileByPath: () => null, getAbstractFileByPath: () => null, getFolderByPath: () => ({}),
      create: async () => {}, createFolder: async () => {},
    }, fileManager: { trashFile: async () => {} } },
    lockManager: { withLock: async (_, fn) => (lockBusy ? null : fn()) },
    websocket: { SendMessage: async () => {} },
    addIgnoredFile() {}, removeIgnoredFile() {},
    lastSyncPathDeleted: new Set(), lastSyncPathRenamed: new Set(), lastSyncMtime: new Map(),
    pendingNoteModifies: new Map(), pendingNoteDeleteAcks: new Set(), fileDownloadSessions: new Map(),
    fileHashManager: { removeFileHash() {}, setFileHash() {}, getPathHash: () => null },
    folderSnapshotManager: { removeFolder() {}, setFolderMtime() {} },
    localStorageManager: { getMetadata: () => 0, setMetadata() {}, savePending() {} },
    concurrencyLimiter: { releaseSlot() {} },
    syncState: { pendingNotePushPageIndex: new Map(), pendingFilePushPageIndex: new Map(), conflictedPaths: new Set() },
    noteSyncTasks: { failed: 0 }, fileSyncTasks: { failed: 0 }, folderSyncTasks: { failed: 0 },
    recordSyncCompleted: (...args) => completed.push(args),
  };
  return { plugin, completed };
}

let cases = 0;
for (const [kind, ops] of [["note", ["Modify", "Mtime", "Delete", "Rename"]], ["folder", ["Modify", "Delete", "Rename"]], ["file", ["Delete", "Mtime", "Rename"]]]) {
  for (const op of ops) {
    for (const lockBusy of [false, true]) {
      const { plugin, completed } = fixture(lockBusy);
      const handler = load(`operator_${kind}`)[`receive${kind[0].toUpperCase() + kind.slice(1)}Sync${op}`];
      const ext = kind === "note" ? ".md" : kind === "file" ? ".png" : "";
      await handler({ path: `a/x${ext}`, oldPath: `a/y${ext}`, content: "c", contentHash: "h", mtime: 5, ctime: 1, pageIndex: 3 }, plugin);
      const label = JSON.stringify({ kind, op, lockBusy });
      assert.equal(plugin[`${kind}SyncTasks`].failed, lockBusy ? 1 : 0, label + " failure accounting");
      assert.equal(completed.length, 1, label + " page completed once");
      cases++;
    }
  }
}
console.log(`lock busy failure accounting: ${cases} cases passed`);
