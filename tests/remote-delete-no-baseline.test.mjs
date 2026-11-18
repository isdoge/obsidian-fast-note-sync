import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// haierkeys/fast-note-sync-service#514 #391: a local file without a sync baseline has never been
// confirmed by the server (created offline, written by an external tool). The server sends a
// delete for every tombstone newer than the sync cursor, whether or not the client reported a file
// on that path, and SyncEnd (which clears the pending-upload maps) arrives before the paged
// details. The delete must not trash such a file: it is kept and uploaded again, once per
// connection, so the exchange with the server always terminates.
const root = path.resolve(import.meta.dirname, "..");
class TFile { constructor(p, stat) { this.path = p; this.stat = stat; } }
const logs = [];
const noop = () => undefined;
const helpers = new Proxy({
  isPathExcluded: () => false,
  isLargeBinarySyncRisk: () => false,
  checkAndNotifyCaseConflict: () => false,
  hashContent: s => `p${s.length}`,
  hashContentAsync: async s => `h:${s}`,
  hashFileAsync: async () => "h:binary",
  getSafeCtime: stat => stat.ctime,
}, { get: (target, name) => target[name] ?? noop });
function load(name, modules = {}) {
  const source = fs.readFileSync(path.join(root, `src/lib/sync/${name}.ts`), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Map, Set, WeakMap, WebSocket: { OPEN: 1 },
    window: { setTimeout: () => 1, clearTimeout: noop, clearInterval: noop },
    require(id) {
      if (id in modules) return modules[id];
      if (id === "obsidian") return { TFile, TFolder: class {}, normalizePath: p => p, Platform: { isMobile: false } };
      if (id === "../utils/helpers") return helpers;
      if (id === "./remote_path_guard") return { blockAliasedRemoteMutation: () => false };
      if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: (...a) => logs.push(a), addOrUpdateLog: noop }) } };
      if (id === "../../i18n/lang") return { $: key => key };
      return {};
    },
  });
  return module.exports;
}
const guard = { "./remote_delete_guard": load("remote_delete_guard") };
const note = load("operator_note", guard);
const file = load("operator_file", guard);
// The real SyncEnd wrapper, to reproduce "pending is cleared before the delete detail arrives"
const { receiveOperators } = load("operator", {
  "./operator_note": note, "./operator_file": file,
  "./websocket_action": new Proxy({}, { get: (_, key) => key }),
});

// Mirrors FileHashManager: setFileHash writes cache + baseline, setFileHashes only the cache
function hashManager() {
  const cache = new Map(), base = new Map();
  return {
    base,
    getPathHash: p => base.get(p) ?? null,
    getValidHash: (p, mtime, size) => { const c = cache.get(p); return c && c.mtime === mtime && c.size === size ? c.hash : null; },
    setFileHash(p, hash, mtime = 0, size = 0) { cache.set(p, { hash, mtime, size }); base.set(p, hash); },
    setFileHashes(entries, getStat) { for (const [p, hash] of entries) cache.set(p, { hash, mtime: getStat?.(p)?.mtime ?? 0, size: getStat?.(p)?.size ?? 0 }); },
    removeFileHash(p) { cache.delete(p); base.delete(p); },
    removeFileHashes(paths) { for (const p of paths) this.removeFileHash(p); },
    bulkSetFromScanned: noop, flush: noop,
  };
}

const kinds = {
  note: { path: "未命名.md", upload: "NoteModify", pending: "pendingNoteModifies", tasks: "noteSyncTasks",
    end: "NoteSyncEnd", del: note.receiveNoteSyncDelete, ack: note.receiveNoteModifyAck, conflict: "NoteDeleteConflict" },
  file: { path: "Pasted image.png", upload: "FileUploadCheck", pending: "pendingUploadHashes", tasks: "fileSyncTasks",
    end: "FileSyncEnd", del: file.receiveFileSyncDelete, ack: file.receiveFileUploadAck, conflict: "FileDeleteConflict" },
};

function fixture(kind, { content = "written offline", readonly = false } = {}) {
  const k = kinds[kind];
  const local = new TFile(k.path, { size: content.length, mtime: 1700000000000, ctime: 1700000000000 });
  const trashed = [], sent = [], completed = [];
  const tasks = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 });
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: readonly, vault: "v" },
    app: {
      vault: { getFileByPath: q => (q === k.path && !trashed.includes(q) ? local : null), read: async () => content, getName: () => "v" },
      fileManager: { trashFile: async f => trashed.push(f.path) },
      saveLocalStorage: noop,
    },
    lockManager: { withLock: async (_, fn) => fn() },
    websocket: { ws: {}, SendMessage: async action => sent.push(action) },
    fileHashManager: hashManager(),
    pendingNoteModifies: new Map(), pendingUploadHashes: new Map(),
    pendingDeleteNotePaths: new Set(), pendingDeleteFilePaths: new Set(),
    pendingNoteDeleteAcks: new Set(), pendingFileDeleteAcks: new Set(),
    scannedNoteHashes: new Map(), scannedFileHashes: new Map(),
    lastSyncPathDeleted: new Set(), lastSyncMtime: new Map(),
    localStorageManager: { getMetadata: () => 0, setMetadata: noop, savePending: noop, clearPending: noop },
    concurrencyLimiter: { waitForSlot: async () => true, releaseSlot: noop },
    syncState: { activeSyncContext: "ctx", conflictedPaths: new Set(), pendingSyncEndTime: new Map(), syncDownChunkNum: 0,
      pendingNotePushPageIndex: new Map(), pendingFilePushPageIndex: new Map() },
    progressTracker: { setDownloadTotal: noop, recordUploadComplete: noop, getTypeTaskTotal: () => 0, isInitialAckSent: () => true },
    isIgnoredFile: () => false, addIgnoredFile: noop, removeIgnoredFile: noop,
    noteSyncTasks: tasks(), fileSyncTasks: tasks(), syncTypeCompleteCount: 0,
    recordSyncCompleted: (...a) => completed.push(a),
  };
  const settle = () => new Promise(r => setImmediate(r));
  return {
    k, plugin, trashed, sent, completed, local,
    // One sync round as the plugin sees it: the scan reported the file (handleRequestSend records
    // scanned notes as pending), SyncEnd arrives first, then the delete detail for the tombstone
    async tombstoneRound() {
      plugin[k.pending].set(k.path, "scanned-hash");
      await receiveOperators.get(k.end)({ lastTime: 900, needDeleteCount: 1, context: "ctx" }, plugin);
      assert.equal(plugin[k.pending].size, 0, `${kind}: SyncEnd cleared the pending uploads before the details`);
      await this.remoteDelete();
    },
    async remoteDelete() { await k.del({ path: k.path, pageIndex: 0 }, plugin); await settle(); },
    async ack() { k.ack({ path: k.path }, plugin); await settle(); },
  };
}

for (const kind of ["note", "file"]) {
  // 1. Created offline on a path the server holds a tombstone for: kept and uploaded again
  const f = fixture(kind);
  await f.tombstoneRound();
  assert.deepEqual(f.trashed, [], `${kind}: a file without a sync baseline is not trashed by a remote delete`);
  assert.deepEqual(f.sent, [f.k.upload], `${kind}: the kept file is uploaded again`);
  assert.equal(f.plugin[f.k.tasks].failed, 0, `${kind}: keeping is not a failure`);
  assert.deepEqual(f.completed.at(-1), [kind, 0], `${kind}: the delete detail still counts as processed`);
  assert(logs.some(l => l[1] === f.k.conflict), `${kind}: the kept copy is logged`);

  // 2. The server refuses the upload (same content as the tombstone): it acks, then deletes again.
  // The ack recorded the baseline, so the second delete is carried out and nothing is uploaded
  await f.ack();
  assert.notEqual(f.plugin.fileHashManager.getPathHash(f.k.path), null, `${kind}: the ack records the baseline`);
  await f.remoteDelete();
  assert.deepEqual(f.trashed, [f.k.path], `${kind}: the delete after the server saw the upload is carried out`);
  assert.deepEqual(f.sent, [f.k.upload], `${kind}: no second upload`);

  // 3. A second delete on the same connection without an ack in between (pending cleared by a
  // later SyncEnd): no upload loop, and still no deletion of content the server never confirmed
  const g = fixture(kind);
  await g.tombstoneRound();
  g.plugin[g.k.pending].clear();
  await g.remoteDelete();
  assert.deepEqual(g.trashed, [], `${kind}: an unconfirmed copy is never trashed`);
  assert.deepEqual(g.sent, [g.k.upload], `${kind}: one upload per connection`);
  // A new connection starts over
  g.plugin.websocket.ws = {};
  await g.remoteDelete();
  assert.deepEqual(g.trashed, [], `${kind}: kept after reconnect`);
  assert.deepEqual(g.sent, [g.k.upload, g.k.upload], `${kind}: a new connection uploads once more`);

  // 4. A read-only device mirrors the server and still deletes
  const r = fixture(kind, { readonly: true });
  await r.tombstoneRound();
  assert.deepEqual(r.trashed, [r.k.path], `${kind}: read-only device deletes`);
  assert.deepEqual(r.sent, [], `${kind}: read-only device never uploads`);
}

// 5. #205: an empty note without a baseline is still probed first; the probe verdict ("server does
// not have it") arrives as a delete on the same connection and must upload, not be held back
{
  const e = fixture("note", { content: "" });
  await e.tombstoneRound();
  assert.deepEqual(e.sent, ["NoteRePush"], "empty note: kept and probed instead of uploaded");
  await e.remoteDelete();
  assert.deepEqual(e.trashed, [], "empty note: the probe verdict keeps the file");
  assert.deepEqual(e.sent, ["NoteRePush", "NoteModify"], "empty note: uploaded once the server confirmed it has none");
}
console.log("PASS: remote delete keeps files without a sync baseline, uploads once per connection and terminates");
