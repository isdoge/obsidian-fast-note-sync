import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Stage E §2.5 / §5.4: a delete must carry the pre-delete baseline {baseHash, baseRevision}; a
// baseline-mode rename becomes "upload/create the target first, then conditionally delete the
// source"; a DeleteAck retires the pending tombstone baseline. Conflicts reported as local_deleted
// / remote_deleted / server_missing keep their data and are counted for the page end, instead of
// being dropped.
const root = path.resolve(import.meta.dirname, "..");

function transpile(relPath) {
  const sourcePath = path.join(root, relPath);
  return ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
}
function loadModule(relPath, requireStub) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(relPath), {
    require: requireStub, module, exports: module.exports, console,
    window: { setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {} },
    setTimeout, clearTimeout, queueMicrotask, Promise, Map, Set, JSON, TextEncoder, TextDecoder, Date,
  });
  return module.exports;
}
const noop = () => undefined;
const anyAsync = async () => undefined;
const helpers = {
  dump: noop, dumpError: noop, showSyncNotice: noop, generateUUID: () => "uuid",
  hashContent: (s) => `h:${s}`, hashContentAsync: async (s) => `h:${s}`,
  isPathExcluded: () => false, isFolderSyncPathExcluded: () => false, configIsPathExcluded: () => false,
  getConfigSyncCustomDirs: () => [], isInWhitelist: () => false, getSafeCtime: (s) => s.ctime ?? 1,
  normalizeServerTimestamp: (v) => v, isLargeBinarySyncRisk: () => false,
  describeBinarySyncLimit: () => "", hashFileAsync: async () => null, formatFileSize: () => "",
  yieldToMain: async () => undefined, getPluginDir: () => ".obsidian/plugins/fns",
  checkAndNotifyCaseConflict: () => false, computeMirrorDigest: (d) => `${d.length}:${d}`,
};
const baselineScope = loadModule("src/lib/storage/baseline_scope.ts", (id) => {
  if (id === "../utils/helpers") return helpers;
  throw new Error(`Unexpected require in baseline_scope: ${id}`);
});

class MockTFile { constructor(p, stat = { size: 0, mtime: 1, ctime: 1 }) { this.path = p; this.stat = stat; } }
class MockTFolder { constructor(p) { this.path = p; } }
const noteOps = loadModule("src/lib/sync/operator_note.ts", (id) => {
  if (id === "obsidian") return { TFile: MockTFile, TFolder: MockTFolder, normalizePath: (p) => p, Platform: { isMobile: false } };
  if (id === "../utils/helpers") return helpers;
  if (id === "../storage/baseline_scope") return baselineScope;
  if (id === "./remote_path_guard") return { blockAliasedRemoteMutation: () => false };
  if (id === "./remote_delete_guard") return { firstKeepWithoutBaseline: () => false };
  if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } };
  if (id === "./sync_state") return { advanceLiveSyncTime: noop };
  if (id === "../../i18n/lang") return { $: (k) => k };
  throw new Error(`Unexpected require in operator_note: ${id}`);
});

class FakeBaselineManager {
  constructor() { this.hashes = new Map(); this.revisions = new Map(); this.confirmed = new Set(); this.pending = new Map(); this.removed = []; }
  getPathHash(p) { return this.hashes.get(p) ?? null; }
  getValidHash() { return null; }
  getVerifiedPathHash(p) { return this.hashes.get(p) ?? null; }
  getBaselineRevision(p) { return this.revisions.get(p) ?? null; }
  getConfirmedBaseline(p) { if (!this.confirmed.has(p)) return null; const h = this.getPathHash(p); const r = this.revisions.get(p); return h && r ? { hash: h, revision: r } : null; }
  isBaselineConfirmed(p) { return this.confirmed.has(p) && this.revisions.has(p); }
  setConfirmedBaseline(p, hash, revision) { this.hashes.set(p, hash); this.revisions.set(p, revision); this.confirmed.add(p); }
  recordPendingDeleteBaseline(p) {
    if (this.pending.has(p)) return this.pending.get(p);
    const known = this.confirmed.has(p) && this.revisions.get(p);
    const rec = known ? { hash: this.hashes.get(p) ?? "", hashMissing: false, revision: this.revisions.get(p) ?? "" } : { hash: "", hashMissing: true, revision: "" };
    this.pending.set(p, rec);
    return rec;
  }
  getPendingDeleteBaseline(p) { return this.pending.get(p) ?? null; }
  clearPendingDeleteBaseline(p) { this.pending.delete(p); }
  removeFileHash(p) { this.removed.push(p); this.hashes.delete(p); this.revisions.delete(p); this.confirmed.delete(p); }
}
function makeNotePlugin({ files = new Map(), manager = new FakeBaselineManager() } = {}) {
  const sent = [];
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    app: {
      vault: {
        getFileByPath: (p) => files.get(p) ?? null,
        read: async (f) => files.get(f.path)?.content ?? "",
        adapter: { exists: anyAsync, read: anyAsync, write: anyAsync, remove: anyAsync, mkdir: anyAsync },
      },
    },
    lockManager: { withLock: async (_k, fn) => fn() },
    websocket: { SendMessage: async (action, data, _guard, onBuffered) => { sent.push([action, data]); onBuffered?.(); } },
    syncState: { conflictedPaths: new Set(), newConflictedPathsThisRound: new Set(), newUnalignedPathsThisRound: new Set(), pendingNotePushPageIndex: new Map(), isSyncBaselineModeEnabled: () => true },
    fileHashManager: manager,
    lastSyncMtime: new Map(), lastSyncPathDeleted: new Set(), lastSyncPathRenamed: new Set(),
    pendingNoteModifies: new Map(), pendingNoteDeleteAcks: new Set(),
    localStorageManager: { getMetadata: () => 0, setMetadata: noop, savePending: noop },
    concurrencyLimiter: { waitForSlot: async () => true, releaseSlot: noop },
    addIgnoredFile: noop, removeIgnoredFile: noop, isIgnoredFile: () => false,
    recordSyncCompleted: noop,
  };
  plugin.isSyncBaselineModeEnabled = () => true;
  return { plugin, sent, manager };
}

// ── Part 1: offline delete carries the pre-delete baseline; Ack retires it ──
{
  const manager = new FakeBaselineManager();
  manager.setConfirmedBaseline("notes/gone.md", "h:OLD", "rev-7");
  const { plugin, sent } = makeNotePlugin({ manager });
  await noteOps.noteDeleteByPath("notes/gone.md", plugin);
  const del = sent.find(([action]) => action === "NoteDelete");
  assert.ok(del, "NoteDelete is sent");
  assert.equal(del[1].baseHash, "h:OLD", "delete carries the hash confirmed before deletion");
  assert.equal(del[1].baseRevision, "rev-7", "delete carries the matching revision");
  assert.equal(del[1].baseHashMissing, false);
  assert.deepEqual(manager.getPendingDeleteBaseline("notes/gone.md"), { hash: "h:OLD", hashMissing: false, revision: "rev-7" });

  noteOps.receiveNoteDeleteAck({ path: "notes/gone.md", lastTime: 99 }, plugin);
  assert.equal(manager.getPendingDeleteBaseline("notes/gone.md"), null, "Ack clears the tombstone baseline");
  assert.deepEqual(manager.removed, ["notes/gone.md"], "Ack retires the path's hashes");
}

// ── Part 2: baseline-mode rename = upload target, then conditional delete of source ──
{
  const manager = new FakeBaselineManager();
  manager.setConfirmedBaseline("notes/old.md", "h:OLD", "rev-3");
  const file = new MockTFile("notes/new.md", { size: 11, mtime: 20, ctime: 2 });
  const { plugin, sent } = makeNotePlugin({ files: new Map([["notes/new.md", { file, content: "TARGET BODY" }]]), manager });
  plugin.fileHashManager = manager;

  await noteOps.noteRename(file, "notes/old.md", plugin, true);

  assert.deepEqual(sent.map(([action]) => action), ["NoteModify", "NoteDelete"], "target is created before the source is conditionally deleted");
  assert.equal(sent[0][1].path, "notes/new.md");
  assert.equal(sent[0][1].contentHash, "h:TARGET BODY");
  assert.equal(sent[1][1].path, "notes/old.md");
  assert.equal(sent[1][1].baseHash, "h:OLD", "source delete uses the source baseline, not the target hash");
  assert.equal(sent[1][1].baseRevision, "rev-3");
}

// ── Part 3: conflict reasons keep their data and count toward the page end ──
const operatorNoteStub = noteOps;
const backupFiles = new Map();
const metaFiles = new Map();
const stubNoteBackups = {
  ...operatorNoteStub,
  conflictBackupPaths: (_plugin, p) => ({
    dir: ".plugin/conflict-notes", safeName: p, pathHash: `p${p.length}`,
    baseBackupPath: `.base:${p}`, remoteBackupPath: `.remote:${p}`, metaPath: `.meta:${p}`, localBackupPath: `.local:${p}`,
  }),
  readConflictMeta: async (_p, p) => (metaFiles.has(p) ? JSON.parse(metaFiles.get(p)) : null),
  writeConflictMeta: async (_p, p, meta) => { metaFiles.set(p, JSON.stringify(meta)); },
  removeConflictBackups: async (_p, p) => { backupFiles.delete(`.base:${p}`); backupFiles.delete(`.remote:${p}`); metaFiles.delete(p); },
};
const conflictStore = loadModule("src/lib/sync/conflict_store.ts", (id) => {
  if (id === "obsidian") return { normalizePath: (p) => p };
  if (id === "../utils/helpers") return helpers;
  if (id === "../utils/types") return {};
  if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: noop }) } };
  if (id === "./operator_note") return stubNoteBackups;
  if (id === "../../i18n/lang") return { $: (k) => k };
  if (id === "../../main") return {};
  throw new Error(`Unexpected require in conflict_store: ${id}`);
});
const operator = loadModule("src/lib/sync/operator.ts", (id) => {
  if (id === "obsidian") return { TFile: MockTFile, TFolder: MockTFolder, normalizePath: (p) => p };
  if (id === "../utils/helpers") return helpers;
  if (id === "./operator_note") return stubNoteBackups;
  if (id === "./operator_config") return new Proxy({}, { get: () => anyAsync });
  if (id === "./operator_file") return new Proxy({}, { get: () => anyAsync });
  if (id === "./operator_folder") return new Proxy({}, { get: () => anyAsync });
  if (id === "../utils/types") return {};
  if (id === "../storage/file_cloud_preview") return { FileCloudPreview: class {} };
  if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: noop }) } };
  if (id === "./websocket_action") return new Proxy({}, { get: (_t, key) => String(key) });
  if (id === "../../i18n/lang") return { $: (k) => k };
  if (id === "./sync_progress_tracker") return { SyncType: { note: "note", file: "file", setting: "setting", folder: "folder" } };
  if (id === "../../views/confirm-modal") return { ConfirmModal: class {} };
  if (id === "../storage/baseline_scope") return baselineScope;
  if (id === "./conflict_store") return conflictStore;
  if (id === "../../main") return {};
  throw new Error(`Unexpected require in operator: ${id}`);
});

{
  const adapter = {
    exists: async (p) => backupFiles.has(p),
    read: async (p) => backupFiles.get(p) ?? "",
    write: async (p, d) => { backupFiles.set(p, d); },
    remove: async (p) => { backupFiles.delete(p); },
    mkdir: async () => undefined,
    list: async () => ({ files: [], folders: [] }),
  };
  const completed = [];
  const plugin = {
    settings: { vault: "v" }, app: { vault: { adapter } },
    syncState: { conflictedPaths: new Set(), newConflictedPathsThisRound: new Set(), conflictCountsThisRound: new Map() },
    localStorageManager: { savePending: noop, setConflictedPaths: noop },
    statusBarManager: { updateConflictBadge: noop },
    pendingNoteModifies: new Map(), pendingUploadHashes: new Map(), pendingConfigModifies: new Map(),
    recordSyncCompleted: (type, pageIndex) => completed.push([type, pageIndex]),
  };

  // local_deleted: remote changed while the local copy is gone — remote body must be preserved
  await operator.receiveSyncConflict({
    kind: "note", path: "notes/local-gone.md", pathHash: "p19", reason: "local_deleted",
    serverHash: "h:remote", serverRevision: "rev-9", serverDeleted: false,
    baseHash: "h:base9", baseMissing: false, baseContent: "BASE9", serverContent: "REMOTE9", pageIndex: 2,
  }, plugin);
  assert.equal(backupFiles.get(".remote:notes/local-gone.md"), "REMOTE9", "remote body is preserved for local_deleted");
  assert.equal(backupFiles.get(".base:notes/local-gone.md"), "BASE9");
  assert.deepEqual(completed.at(-1), ["note", 2], "local_deleted advances its own page");

  // remote_deleted: the server tombstone is a conflict, not a silent local delete
  await operator.receiveSyncConflict({
    kind: "note", path: "notes/remote-gone.md", pathHash: "p20", reason: "remote_deleted",
    serverHash: "", serverRevision: "rev-10", serverDeleted: true,
    baseHash: "h:base10", baseMissing: false, baseContent: "BASE10", serverContent: "", pageIndex: 3,
  }, plugin);
  assert.equal(backupFiles.has(".remote:notes/remote-gone.md"), false, "no fabricated remote body for a tombstone");
  assert.equal(JSON.parse(metaFiles.get("notes/remote-gone.md")).serverDeleted, true, "tombstone flag survives for the resolver");
  assert.deepEqual(completed.at(-1), ["note", 3]);

  // server_missing: first attach without any ancestor still produces a resolvable entry
  await operator.receiveSyncConflict({
    kind: "note", path: "notes/server-missing.md", pathHash: "p22", reason: "server_missing",
    serverHash: "", serverRevision: "", serverDeleted: false,
    baseHash: "", baseMissing: true, baseContent: "", serverContent: "", pageIndex: 4,
  }, plugin);
  assert.ok(plugin.syncState.conflictedPaths.has("notes/server-missing.md"));
  assert.equal(plugin.syncState.conflictCountsThisRound.get("note"), 3, "all three reasons counted for the round summary");
  assert.deepEqual(completed.at(-1), ["note", 4], "pages keep advancing so the round can finish");
  assert.equal(completed.length, 3);
}

console.log("baseline-delete-recreate.test.mjs: delete baseline, create-then-delete rename and conflict reasons preserved passed");
