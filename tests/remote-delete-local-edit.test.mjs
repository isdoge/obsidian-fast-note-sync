import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// #277: a remote delete must not discard unsynced local edits. The note/file is kept and uploaded
// again; a clean copy or a read-only device still deletes. A copy without a baseline was never
// confirmed by the server and is kept too (haierkeys/fast-note-sync-service#514 #391, see
// remote-delete-no-baseline.test.mjs).
const root = path.resolve(import.meta.dirname, "..");
class TFile { constructor(p) { this.path = p; this.stat = { size: 1, mtime: 9, ctime: 1 }; } }
const logs = [];
const helpers = new Proxy({
  isPathExcluded: () => false,
  isLargeBinarySyncRisk: () => false,
  checkAndNotifyCaseConflict: () => false,
  hashContent: s => `p${s.length}`,
  hashContentAsync: async s => s,
  hashFileAsync: async () => "edited",
}, { get: (target, name) => target[name] ?? (() => undefined) });
function load(name) {
  const source = fs.readFileSync(path.join(root, `src/lib/sync/${name}.ts`), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Map, Set,
    window: { setTimeout: () => 1, clearTimeout() {} },
    require(id) {
      if (id === "obsidian") return { TFile, normalizePath: p => p, Platform: { isMobile: false } };
      if (id === "../utils/helpers") return helpers;
      if (id === "./remote_path_guard") return { blockAliasedRemoteMutation: () => false };
      if (id === "./remote_delete_guard") return { firstKeepWithoutBaseline: () => true };
      if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: (...a) => logs.push(a) }) } };
      if (id === "./sync_state") return { advanceLiveSyncTime: (plugin, field, lastTime) => { if (lastTime && lastTime > Number(plugin.localStorageManager.getMetadata(field))) plugin.localStorageManager.setMetadata(field, lastTime); } };
      return {};
    },
  });
  return module.exports;
}
const ops = { note: load("operator_note"), file: load("operator_file") };

async function run(kind, { pending = false, content = "synced", base = "synced", readonly = false }) {
  const p = kind === "note" ? "a.md" : "a.png";
  const file = new TFile(p), trashed = [], sent = [];
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: readonly, vault: "v" },
    app: { vault: { getFileByPath: q => (q === p ? file : null), read: async () => content }, fileManager: { trashFile: async f => trashed.push(f.path) } },
    lockManager: { withLock: async (_, fn) => fn() },
    websocket: { SendMessage: async action => sent.push(action) },
    fileHashManager: { getPathHash: () => base, getValidHash: () => null, removeFileHash() {} },
    pendingNoteModifies: new Map(pending && kind === "note" ? [[p, "x"]] : []),
    pendingUploadHashes: new Map(pending && kind === "file" ? [[p, "x"]] : []),
    pendingNoteDeleteAcks: new Set(), pendingFileDeleteAcks: new Set(),
    lastSyncPathDeleted: new Set(), lastSyncMtime: new Map(),
    localStorageManager: { getMetadata: () => 0, setMetadata() {}, savePending() {} },
    concurrencyLimiter: { waitForSlot: async () => true },
    syncState: { activeSyncContext: null, conflictedPaths: new Set() },
    isIgnoredFile: () => false, addIgnoredFile() {}, removeIgnoredFile() {},
    noteSyncTasks: { failed: 0 }, fileSyncTasks: { failed: 0 }, recordSyncCompleted() {},
  };
  const handler = kind === "note" ? ops.note.receiveNoteSyncDelete : ops.file.receiveFileSyncDelete;
  await handler({ path: p, pageIndex: 1 }, plugin);
  await new Promise(r => setImmediate(r));
  return { trashed, sent, failed: plugin[`${kind}SyncTasks`].failed };
}

let cases = 0;
for (const kind of ["note", "file"]) {
  const upload = kind === "note" ? "NoteModify" : "FileUploadCheck";
  const edited = kind === "note" ? { content: "edited" } : { base: "synced" }; // file hash stub returns "edited"
  const check = async (label, opts, keep) => {
    const r = await run(kind, opts);
    assert.deepEqual(r.trashed, keep ? [] : [kind === "note" ? "a.md" : "a.png"], `${kind} ${label}: trash`);
    assert.deepEqual(r.sent, keep ? [upload] : [], `${kind} ${label}: re-upload`);
    assert.equal(r.failed, 0, `${kind} ${label}: not a failure`);
    cases++;
  };
  if (kind === "note") await check("clean copy deletes", {}, false);
  else await check("clean copy deletes", { base: "edited" }, false);
  await check("pending upload keeps local", { pending: true, base: kind === "note" ? "synced" : "edited" }, true);
  await check("content diverged keeps local", edited, true);
  await check("unknown baseline keeps local", { content: "edited", base: null }, true);
  await check("read-only device deletes", { ...edited, pending: true, readonly: true }, false);
}
assert(logs.some(l => l[1] === "NoteDeleteConflict") && logs.some(l => l[1] === "FileDeleteConflict"), "kept copies are logged");
console.log(`remote delete keeps unsynced local edits: ${cases} cases passed`);
