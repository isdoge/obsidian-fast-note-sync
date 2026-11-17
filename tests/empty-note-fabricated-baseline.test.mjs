import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// #205 (follow-up): the first-install baseline migration (hashMap -> syncHashMap) fabricates a
// sync baseline for never-synced files. Fabricating one for an EMPTY local note (Obsidian's
// auto-created daily note on a new device joining an existing vault) defeats the empty-note
// probe: the first sync would upload the empty file and overwrite the server copy. The
// migration must skip size-0 files; non-empty files keep getting a baseline (upgrade users).
const root = path.resolve(import.meta.dirname, "..");

function transpile(relPath) {
  const sourcePath = path.join(root, relPath);
  const source = fs.readFileSync(sourcePath, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
}

function loadModule(relPath, requireStub, extraGlobals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(relPath), {
    require: requireStub, module, exports: module.exports, console,
    window: { setTimeout: () => 1, clearTimeout() {} }, setTimeout, clearTimeout,
    ...extraGlobals,
  });
  return module.exports;
}

const helpersRequireStub = (id) => {
  switch (id) {
    case "obsidian":
      return {
        Notice: class { setMessage() {} hide() {} },
        normalizePath: (p) => p,
        TFolder: class {}, Platform: { isMobile: false }, App: class {},
      };
    case "../../i18n/lang":
      return { $: (key) => key };
    case "../../main":
      return {};
    case "../sync/sync_log_manager":
      return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: () => undefined }) } };
    case "../helpers_obsidian_bypass":
      return { nativeFetch: () => undefined, vaultDelete: () => undefined, dump: () => undefined, dumpError: () => undefined, setLogEnabled: () => undefined, logLevel: () => undefined };
    default:
      throw new Error(`Unexpected require in helpers: ${id}`);
  }
};
const helpers = loadModule("src/lib/utils/helpers.ts", helpersRequireStub, {
  activeDocument: undefined,
  crypto: { getRandomValues: (a) => a },
});
const { FileHashManager } = loadModule("src/lib/storage/file_hash_manager.ts", (id) => {
  if (id === "../utils/helpers") return helpers;
  if (id === "../../i18n/lang") return { $: (k) => k };
  if (id === "../../main") return {};
  throw new Error(`Unexpected require in file_hash_manager: ${id}`);
});

// New install: no saved state at all. Local vault already has files (the daily-note case):
// an empty today.md and a non-empty real.md. initialize() must build the local cache and
// migrate a baseline ONLY for the non-empty file.
{
  const ls = new Map();
  const files = new Map();
  const vaultFiles = [
    { path: "diary/today.md", extension: "md", stat: { ctime: 1, mtime: 1, size: 0 } },
    { path: "diary/real.md", extension: "md", stat: { ctime: 1, mtime: 1, size: 9 } },
  ];
  const plugin = {
    manifest: { id: "fast-note-sync", dir: ".obsidian/plugins/fast-note-sync" },
    settings: {},
    app: {
      loadLocalStorage: (k) => (ls.has(k) ? ls.get(k) : null),
      saveLocalStorage: (k, v) => ls.set(k, String(v)),
      vault: {
        configDir: ".obsidian",
        getName: () => "V",
        getFiles: () => vaultFiles,
        adapter: {
          exists: async (p) => files.has(p),
          read: async (p) => {
            if (!files.has(p)) throw new Error("ENOENT: " + p);
            return files.get(p);
          },
          write: async (p, d) => files.set(p, d),
        },
        read: async (f) => (f.path === "diary/today.md" ? "" : "real note"),
      },
    },
  };
  const mgr = new FileHashManager(plugin);
  await mgr.initialize();
  mgr.flush();
  assert.equal(mgr.getPathHash("diary/real.md") !== null, true, "non-empty note gets a fabricated baseline (upgrade/new users unchanged)");
  assert.equal(mgr.getPathHash("diary/today.md"), null, "empty note gets NO fabricated baseline (#205)");
}

// Upgrade user: hashMap pre-populated (old version data), no syncHashMap. Non-empty entries
// migrate; an empty entry does not.
{
  const ls = new Map(), files = new Map();
  ls.set("fns-fileHashMap", JSON.stringify({
    "a/old.md": { hash: "h1", mtime: 1, size: 5 },
    "a/blank.md": { hash: "h0", mtime: 1, size: 0 },
  }));
  const plugin = {
    manifest: { id: "fast-note-sync", dir: ".obsidian/plugins/fast-note-sync" },
    settings: {},
    app: {
      loadLocalStorage: (k) => (ls.has(k) ? ls.get(k) : null),
      saveLocalStorage: (k, v) => ls.set(k, String(v)),
      vault: {
        configDir: ".obsidian", getName: () => "V", getFiles: () => [],
        adapter: { exists: async () => false, read: async () => "", write: async () => {} },
      },
    },
  };
  const mgr = new FileHashManager(plugin);
  await mgr.initialize();
  assert.equal(mgr.getPathHash("a/old.md"), "h1", "upgrade: non-empty entry migrated");
  assert.equal(mgr.getPathHash("a/blank.md"), null, "upgrade: empty entry not migrated");
}

// End-to-end with the probe: fresh install, empty daily note (no baseline after migration),
// server HAS the note -> NeedPush is intercepted by the probe -> NoteRePush -> NoteSyncModify
// overwrites the local empty file; and the NoteSyncModify must NOT create a conflict copy.
{
  class TFile { constructor(p) { this.path = p; this.stat = { size: 0, mtime: 5, ctime: 1 }; } }
  const ops = loadModule("src/lib/sync/operator_note.ts", (id) => {
    if (id === "obsidian") return { TFile, normalizePath: (p) => p, Platform: { isMobile: false } };
    if (id === "../utils/helpers") return new Proxy({ isPathExcluded: () => false, hashContent: (s) => `h${s.length}`, hashContentAsync: async (s) => `h${s.length}`, getPluginDir: () => "" }, { get: (t, n) => t[n] ?? (() => false) });
    if (id === "./remote_path_guard") return { blockAliasedRemoteMutation: () => false };
    if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: () => undefined }) } };
    return {};
  });
  const file = new TFile("diary/today.md");
  const sent = [], written = [], adapterWrites = [];
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    app: {
      vault: {
        getFileByPath: (p) => (p === file.path ? file : null),
        read: async () => "",
        modify: async (f, data) => written.push([f.path, data]),
        createFolder: async () => {},
        getFolderByPath: () => ({}),
        adapter: { exists: async () => false, mkdir: async () => {}, write: async (p, d) => adapterWrites.push([p, d]) },
      },
      fileManager: { trashFile: async () => {} },
    },
    lockManager: { withLock: async (_, fn) => fn() },
    websocket: { SendMessage: async (action, data) => sent.push([action, data.path]) },
    syncState: { conflictedPaths: new Set(), newConflictedPathsThisRound: new Set(), pendingNotePushPageIndex: new Map() },
    fileHashManager: { getPathHash: () => null, getValidHash: () => null, setFileHash() {}, removeFileHash() {} },
    lastSyncMtime: new Map(), lastSyncPathDeleted: new Set(),
    pendingNoteModifies: new Map(), pendingNoteDeleteAcks: new Set(),
    localStorageManager: { getMetadata: () => 0, setMetadata() {}, savePending() {}, setConflictedPaths() {} },
    concurrencyLimiter: { waitForSlot: async () => true, releaseSlot() {} },
    statusBarManager: { updateConflictBadge() {} },
    isIgnoredFile: () => false, addIgnoredFile() {}, removeIgnoredFile() {},
    noteSyncTasks: { failed: 0 }, recordSyncCompleted() {},
  };

  // first sync: server has a NEWER copy of the same path -> server sends NeedPush
  await ops.receiveNoteUpload({ path: file.path, pageIndex: 0 }, plugin);
  assert.deepEqual(sent, [["NoteRePush", file.path]], "NeedPush for never-synced empty note answered with a probe, not an upload");

  // probe verdict: server HAS the note -> NoteSyncModify must overwrite the empty file directly,
  // with no conflict backup files and no conflictedPaths entry
  await ops.receiveNoteSyncModify({ path: file.path, content: "server diary", contentHash: "hs", ctime: 1, mtime: 9, lastTime: 0, pageIndex: 0 }, plugin);
  assert.deepEqual(written, [[file.path, "server diary"]], "server content overwrites the empty local file");
  assert.equal(plugin.syncState.conflictedPaths.size, 0, "no conflict raised");
  assert.equal(adapterWrites.length, 0, "no conflict backup files written");
}

// End-to-end: fresh install, empty daily note, server does NOT have it -> probe verdict is
// NoteSyncDelete -> local kept, empty file re-uploaded successfully (create case).
{
  class TFile { constructor(p) { this.path = p; this.stat = { size: 0, mtime: 5, ctime: 1 }; } }
  const ops = loadModule("src/lib/sync/operator_note.ts", (id) => {
    if (id === "obsidian") return { TFile, normalizePath: (p) => p, Platform: { isMobile: false } };
    if (id === "../utils/helpers") return new Proxy({ isPathExcluded: () => false, hashContent: (s) => `h${s.length}`, hashContentAsync: async (s) => `h${s.length}`, getPluginDir: () => "" }, { get: (t, n) => t[n] ?? (() => false) });
    if (id === "./remote_path_guard") return { blockAliasedRemoteMutation: () => false };
    if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: () => undefined }) } };
    return {};
  });
  const file = new TFile("diary/today.md");
  const sent = [], trashed = [];
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    app: {
      vault: { getFileByPath: (p) => (p === file.path ? file : null), read: async () => "", createFolder: async () => {}, getFolderByPath: () => ({}) },
      fileManager: { trashFile: async (f) => trashed.push(f.path) },
    },
    lockManager: { withLock: async (_, fn) => fn() },
    websocket: { SendMessage: async (action, data) => sent.push([action, data.path]) },
    syncState: { conflictedPaths: new Set(), pendingNotePushPageIndex: new Map() },
    fileHashManager: { getPathHash: () => null, getValidHash: () => null, setFileHash() {}, removeFileHash() {} },
    lastSyncMtime: new Map(), lastSyncPathDeleted: new Set(),
    pendingNoteModifies: new Map(), pendingNoteDeleteAcks: new Set(),
    localStorageManager: { getMetadata: () => 0, setMetadata() {}, savePending() {} },
    concurrencyLimiter: { waitForSlot: async () => true, releaseSlot() {} },
    isIgnoredFile: () => false, addIgnoredFile() {}, removeIgnoredFile() {},
    noteSyncTasks: { failed: 0 }, recordSyncCompleted() {},
  };
  await ops.receiveNoteUpload({ path: file.path, pageIndex: 0 }, plugin);
  await ops.receiveNoteSyncDelete({ path: file.path, pageIndex: 0 }, plugin);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(trashed, [], "local empty note not trashed");
  assert.deepEqual(sent, [["NoteRePush", file.path], ["NoteModify", file.path]], "probe then direct empty-file upload");
}

console.log("empty note fabricated-baseline tests passed");
