import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Stage E §5.2 / §6: connecting to a baseline-capable server (negotiated >= 1) lets the first attach
// establish a trusted {hash, revision} through *SyncMtime only when the local content still equals
// the message hash; a different local body goes to conflict alignment instead of being overwritten.
// Connecting to a legacy server (negotiated 0) keeps the compatibility path: no revision is stored.
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
const helpers = {
  dump: noop, dumpError: noop, showSyncNotice: noop,
  isPathExcluded: () => false, getSafeCtime: (s) => s.ctime ?? 1, normalizeServerTimestamp: (v) => v,
  hashContent: (s) => `h:${s}`, hashContentAsync: async (s) => `h:${s}`,
  checkAndNotifyCaseConflict: () => false, computeMirrorDigest: (d) => `${d.length}:${d}`,
  getPluginDir: () => ".obsidian/plugins/fns",
  debounce: (fn) => { let t = null; return () => { if (t) clearTimeout(t); fn(); }; },
  LocalStateFileMirror: class { async read() { return null; } scheduleWrite() {} flush() {} },
};
const baselineScope = loadModule("src/lib/storage/baseline_scope.ts", (id) => {
  if (id === "../utils/helpers") return helpers;
  throw new Error(`Unexpected require in baseline_scope: ${id}`);
});

class MockTFile {
  constructor(p, stat = { size: 0, mtime: 1, ctime: 1 }) { this.path = p; this.stat = stat; }
}
const noteOps = loadModule("src/lib/sync/operator_note.ts", (id) => {
  if (id === "obsidian") return { TFile: MockTFile, TFolder: class {}, normalizePath: (p) => p, Platform: { isMobile: false } };
  if (id === "../utils/helpers") return helpers;
  if (id === "../storage/baseline_scope") return baselineScope;
  if (id === "./remote_path_guard") return { blockAliasedRemoteMutation: () => false };
  if (id === "./remote_delete_guard") return { firstKeepWithoutBaseline: () => false };
  if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } };
  if (id === "./sync_state") return { advanceLiveSyncTime: noop };
  if (id === "../../i18n/lang") return { $: (k) => k };
  throw new Error(`Unexpected require in operator_note: ${id}`);
});

const storage = new Map();
const settings = { api: "https://server.example", vault: "vault-a", apiToken: "token" };
function makeHashManager() {
  const plugin = {
    settings,
    app: {
      saveLocalStorage: (k, v) => storage.set(k, v),
      loadLocalStorage: (k) => storage.get(k) ?? null,
      vault: { getName: () => "local", getFiles: () => [], configDir: ".obsidian" },
    },
  };
  const { FileHashManager } = loadModule("src/lib/storage/file_hash_manager.ts", (id) => {
    if (id === "../utils/helpers") return helpers;
    if (id === "./baseline_scope") return baselineScope;
    if (id === "../../i18n/lang") return { $: (k) => k };
    if (id === "../../main") return {};
    throw new Error(`Unexpected require in file_hash_manager: ${id}`);
  });
  return new FileHashManager(plugin);
}

const backupFiles = new Map();
const conflictMeta = new Map();
const adapter = {
  exists: async (p) => backupFiles.has(p),
  read: async (p) => backupFiles.get(p) ?? "",
  write: async (p, d) => { backupFiles.set(p, d); },
  remove: async (p) => { backupFiles.delete(p); },
  mkdir: async () => undefined,
  list: async () => ({ files: [], folders: [] }),
};
function makePlugin({ manager, baselineMode, files }) {
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    app: {
      vault: {
        adapter,
        getFileByPath: (p) => files.get(p)?.file ?? null,
        read: async (f) => files.get(f.path)?.content ?? "",
        modify: async (f, content) => { if (files.has(f.path)) files.get(f.path).content = content; },
      },
    },
    lockManager: { withLock: async (_k, fn) => fn() },
    websocket: { SendMessage: async () => undefined },
    syncState: {
      conflictedPaths: new Set(), newConflictedPathsThisRound: new Set(), newUnalignedPathsThisRound: new Set(),
      pendingNotePushPageIndex: new Map(), conflictCountsThisRound: new Map(),
      isSyncBaselineModeEnabled: () => baselineMode,
    },
    fileHashManager: manager,
    lastSyncMtime: new Map(), lastSyncPathDeleted: new Set(),
    pendingNoteModifies: new Map(), pendingNoteDeleteAcks: new Set(),
    localStorageManager: { getMetadata: () => 0, setMetadata: noop, savePending: noop, setConflictedPaths: noop },
    statusBarManager: { updateConflictBadge: noop },
    concurrencyLimiter: { waitForSlot: async () => true, releaseSlot: noop },
    addIgnoredFile: noop, removeIgnoredFile: noop, isIgnoredFile: () => false,
    noteSyncTasks: { failed: 0 }, recordSyncCompleted: noop,
  };
  plugin.isSyncBaselineModeEnabled = () => baselineMode;
  return plugin;
}

// ── Part 1: new server, first attach with the same content → trusted {hash, revision} ──
{
  const manager = makeHashManager();
  const file = new MockTFile("notes/first.md", { size: 4, mtime: 11, ctime: 1 });
  const files = new Map([["notes/first.md", { file, content: "SAME" }]]);
  const plugin = makePlugin({ manager, baselineMode: true, files });
  plugin.pendingNoteModifies.set("notes/first.md", "h:SAME");

  await noteOps.receiveNoteSyncMtime({
    path: "notes/first.md", contentHash: "h:SAME", revision: "rev-first",
    mtime: 1700000000000, ctime: 1600000000000, pageIndex: 0,
  }, plugin);

  const attached = manager.getConfirmedBaseline("notes/first.md");
  assert.equal(attached?.hash, "h:SAME", "SyncMtime establishes the trusted hash");
  assert.equal(attached?.revision, "rev-first", "SyncMtime establishes the trusted revision");
  assert.equal(manager.getBaselineRevision("notes/first.md"), "rev-first");
  assert.equal(plugin.pendingNoteModifies.has("notes/first.md"), false, "confirmed attach clears pending");
  assert.equal(plugin.lastSyncMtime.get("notes/first.md"), 1700000000000);
}

// ── Part 2: new server, first attach with a different body → alignment, never overwrite ──
{
  const manager = makeHashManager();
  const file = new MockTFile("notes/diverged.md", { size: 5, mtime: 12, ctime: 2 });
  const files = new Map([["notes/diverged.md", { file, content: "LOCAL" }]]);
  const plugin = makePlugin({ manager, baselineMode: true, files });

  await noteOps.receiveNoteSyncModify({
    path: "notes/diverged.md", content: "REMOTE", contentHash: "h:REMOTE",
    revision: "rev-remote", mtime: 1700000000000, ctime: 1600000000000, pageIndex: 0,
  }, plugin);

  assert.equal(files.get("notes/diverged.md").content, "LOCAL", "local body is preserved on first attach");
  assert.ok(plugin.syncState.conflictedPaths.has("notes/diverged.md"), "path enters conflict alignment");
  const hash = await helpers.hashContentAsync("notes/diverged.md");
  assert.equal(manager.getBaselineRevision("notes/diverged.md"), null, `no baseline token without a verified base (${hash})`);
  const { remoteBackupPath } = noteOps.conflictBackupPaths(plugin, "notes/diverged.md");
  assert.equal(backupFiles.get(remoteBackupPath), "REMOTE", "the remote body is stashed internally for alignment");
}

// ── Part 3: legacy server (negotiated 0) keeps the compatibility path ──
{
  const manager = makeHashManager();
  const file = new MockTFile("notes/legacy.md", { size: 4, mtime: 13, ctime: 3 });
  const files = new Map([["notes/legacy.md", { file, content: "SAME" }]]);
  const plugin = makePlugin({ manager, baselineMode: false, files });
  plugin.pendingNoteModifies.set("notes/legacy.md", "h:SAME");
  const sent = [];
  plugin.websocket.SendMessage = async (action, data) => sent.push([action, data]);

  await noteOps.receiveNoteSyncMtime({
    path: "notes/legacy.md", contentHash: "h:SAME", mtime: 1700000000001, ctime: 1600000000001, pageIndex: 0,
  }, plugin);
  assert.equal(manager.getBaselineRevision("notes/legacy.md"), null, "legacy server never yields a revision");
  assert.equal(manager.getConfirmedBaseline("notes/legacy.md"), null, "no trusted baseline without a revision");
  assert.equal(manager.getPathHash("notes/legacy.md"), "h:SAME", "hash bookkeeping still works");

  // Compatibility-mode uploads keep the old field shape: baseHash only, no revision, no resolution flag
  const edited = new MockTFile("notes/legacy.md", { size: 8, mtime: 14, ctime: 3 });
  files.get("notes/legacy.md").file = edited;
  files.get("notes/legacy.md").content = "EDITED!!";
  await noteOps.noteModify(edited, plugin, true);
  const modify = sent.find(([action]) => action === "NoteModify");
  assert.ok(modify, "compat upload is sent");
  assert.equal(modify[1].baseHash, "h:SAME");
  assert.equal("baseRevision" in modify[1], false, "compat upload carries no revision field");
  assert.equal("isConflictResolved" in modify[1], false);
}

console.log("baseline-first-attach.test.mjs: SyncMtime attach, content-diverged alignment and legacy compatibility passed");
