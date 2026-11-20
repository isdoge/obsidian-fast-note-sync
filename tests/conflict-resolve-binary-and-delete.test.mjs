import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// P0-03 / P0-04 / P0-05 / P1-05 regression tests for the unified conflict pipeline:
// - an un-inlined remote body (serverContent === "" while serverHash names real content) never
//   writes an empty .remote copy and never clears the user's local file/config;
// - binary settings (fns-bin-v1 envelope) are stashed and restored byte-exactly;
// - "keep local" for a locally-deleted note/file/setting sends the delete with the confirmed
//   remote baseline (serverHash + serverRevision), not the stale baseHash;
// - resolveFolder routes local_deleted correctly in both directions;
// - a 530 / SyncConflict freezes in-flight uploads, timers and pending delete acks.
const root = path.resolve(import.meta.dirname, "..");

const noop = () => undefined;

function loadModule(relPath, requireStub, extraGlobals = {}) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    require: requireStub, module, exports: module.exports, console, TextDecoder, TextEncoder,
    Map, Set, Uint8Array, ArrayBuffer, Date,
    window: { setTimeout: () => 1, clearTimeout() {}, localStorage: { getItem: () => null, setItem() {} } },
    setTimeout, clearTimeout,
    ...extraGlobals,
  });
  return module.exports;
}

class TFile {
  constructor(p, stat = { size: 5, mtime: 100, ctime: 1 }) { this.path = p; this.stat = stat; }
}
class TFolder {
  constructor(p) { this.path = p; this.children = []; }
}

const helpers = new Proxy({
  isPathExcluded: () => false,
  hashContent: (s) => `p${s.length}`,
  hashContentAsync: async (s) => `h:${s}`,
  hashFileAsync: async (_app, p) => `file:${p}`,
  hashArrayBuffer: async () => "arr",
  getPluginDir: () => ".obsidian/plugins/fns",
  checkAndNotifyCaseConflict: () => false,
  getSafeCtime: (stat) => stat?.ctime ?? 0,
  normalizeServerTimestamp: (v) => v,
  dump: noop, dumpError: noop,
}, { get: (t, n) => t[n] ?? noop });

const codec = loadModule("src/lib/utils/config_codec.ts", (id) => {
  if (id === "obsidian") return {};
  throw new Error(`Unexpected require in config_codec: ${id}`);
});

function makeBackupPaths(plugin, p) {
  const dir = ".obsidian/plugins/fns/conflict-notes";
  const safe = p.replace(/[/\\]/g, "_");
  return {
    dir,
    safeName: safe,
    pathHash: `p${p.length}`,
    baseBackupPath: `${dir}/${safe}.base`,
    remoteBackupPath: `${dir}/${safe}.remote`,
    metaPath: `${dir}/${safe}.meta.json`,
    localBackupPath: `${dir}/${safe}.local-backup`,
  };
}

const noteStub = {
  conflictBackupPaths: makeBackupPaths,
  readConflictMeta: async (plugin, p) => (plugin.meta.has(p) ? JSON.parse(plugin.meta.get(p)) : null),
  writeConflictMeta: async (plugin, p, meta) => { plugin.meta.set(p, JSON.stringify(meta)); },
  removeConflictBackups: async () => undefined,
  noteDeleteByPath: async (p, plugin, _guard, baseline) => { plugin.deletes.push(["NoteDelete", p, baseline]); },
  noteModify: async (file, plugin) => { plugin.modifies.push(file.path); },
  CONFLICT_REASON_UNALIGNED: "unaligned_no_baseline",
};
const fileStub = {
  fileDeleteByPath: async (p, plugin, _guard, baseline) => { plugin.deletes.push(["FileDelete", p, baseline]); },
  fileModify: async (file, plugin) => { plugin.modifies.push(file.path); },
};
const folderStub = {
  folderModify: async (folder, plugin) => { plugin.folderModifies.push(folder.path); },
  folderDeleteByPath: async (p, plugin, _guard, baseline) => { plugin.deletes.push(["FolderDelete", p, baseline]); },
};
const configStub = {
  configModify: async (p, plugin) => { plugin.configModifies.push(p); },
};

const store = loadModule("src/lib/sync/conflict_store.ts", (id) => {
  if (id === "obsidian") return { normalizePath: (p) => p };
  if (id === "../utils/helpers") return helpers;
  if (id === "../utils/config_codec") return codec;
  if (id === "../utils/types") return {};
  if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: noop }) } };
  if (id === "./operator_file") return { clearUploadTrackingForConflict: (p) => plugin.__clearedUploads.push(p) };
  if (id === "./operator_note") return noteStub;
  if (id === "../../i18n/lang") return { $: (k) => k };
  if (id === "../../main") return {};
  throw new Error(`Unexpected require in conflict_store: ${id}`);
});

let plugin;
const resolve = loadModule("src/lib/sync/conflict_resolve.ts", (id) => {
  if (id === "obsidian") return { normalizePath: (p) => p, TFile, TFolder };
  if (id === "../utils/helpers") return helpers;
  if (id === "./conflict_store") return store;
  if (id === "./operator_note") return noteStub;
  if (id === "./operator_file") return fileStub;
  if (id === "./operator_folder") return folderStub;
  if (id === "./operator_config") return configStub;
  if (id === "../../main") return {};
  throw new Error(`Unexpected require in conflict_resolve: ${id}`);
});

const plain = (v) => JSON.parse(JSON.stringify(v));

function makePlugin(overrides = {}) {
  const files = new Map();
  const created = [];
  const written = [];
  const sent = [];
  const trashed = [];
  const deletes = [];
  const modifies = [];
  const folderModifies = [];
  const configModifies = [];
  const confirmed = [];
  const folders = new Map();
  const p = {
    settings: { vault: "v", syncEnabled: true, configSyncEnabled: true },
    app: {
      vault: {
        getFileByPath: (p) => files.get(p) ?? null,
        getAbstractFileByPath: (p) => files.get(p) ?? folders.get(p) ?? null,
        read: async (f) => f.__content ?? "",
        create: async (path, data) => { created.push([path, data]); files.set(path, Object.assign(new TFile(path), { __content: data })); },
        modify: async (f, data) => { f.__content = data; },
        createFolder: async (path) => { folders.set(path, new TFolder(path)); },
        adapter: {
          exists: async (p) => files.has(p),
          read: async (p) => files.get(p)?.__content ?? "",
          write: async (p, data) => { written.push([p, data]); files.set(p, Object.assign(new TFile(p), { __content: data })); },
          readBinary: async (p) => files.get(p)?.__bytes ?? new ArrayBuffer(0),
          writeBinary: async (p, data) => { written.push([p, new Uint8Array(data)]); files.set(p, Object.assign(new TFile(p), { __bytes: data })); },
          stat: async () => ({ mtime: 111, size: 3, ctime: 1 }),
          remove: async (p) => { files.delete(p); },
          mkdir: async () => undefined,
        },
      },
      fileManager: { trashFile: async (f) => { trashed.push(f.path); } },
    },
    lockManager: { withLock: async (_k, fn) => fn() },
    websocket: { SendMessage: async (action, data) => { sent.push([action, data]); } },
    syncState: {
      conflictedPaths: new Set(), newConflictedPathsThisRound: new Set(), conflictCountsThisRound: new Map(),
      pendingNotePushPageIndex: new Map(), pendingFilePushPageIndex: new Map(), pendingConfigPushPageIndex: new Map(),
    },
    pendingNoteModifies: new Map(), pendingUploadHashes: new Map(), pendingConfigModifies: new Map(),
    pendingNoteDeleteAcks: new Set(), pendingFileDeleteAcks: new Set(), pendingConfigDeleteAcks: new Set(),
    concurrencyLimiter: { waitForSlot: async () => true, releaseSlot: (p) => released.push(p) },
    localStorageManager: {
      syncPathPrefix: "_localStorage/",
      pathToKey: (p) => p.slice("_localStorage/".length),
      getItemValue: (k) => p.__ls.get(k) ?? null,
      savePending: noop, setConflictedPaths: noop, getMetadata: () => 0,
    },
    statusBarManager: { updateConflictBadge: noop },
    fileHashManager: { removeFileHash: noop, setConfirmedBaseline: (...a) => confirmed.push(["file", ...a]) },
    configHashManager: { removeFileHash: noop, setConfirmedBaseline: (...a) => confirmed.push(["setting", ...a]), recordPendingDeleteBaseline: noop },
    folderSnapshotManager: {
      removeFolder: (p) => removedFolders.push(p),
      setFolderMtime: (p, m) => folderSnapshots.push([p, m]),
      setConfirmedRevision: (p, r) => confirmed.push(["folder", p, r]),
    },
    lastSyncMtime: new Map(),
    meta: new Map(),
    __ls: new Map(),
    __clearedUploads: [],
    api: { getNoteContent: async () => null },
    ...overrides,
  };
  Object.assign(p, {
    files, created, written, sent, trashed, deletes, modifies, folderModifies, configModifies, confirmed, folders,
  });
  plugin = p;
  return p;
}
const released = [];
const removedFolders = [];
const folderSnapshots = [];

const storeMeta = (p, path, meta) => {
  p.meta.set(path, JSON.stringify(meta));
  p.syncState.conflictedPaths.add(path);
};

// 1. P0-03: un-inlined remote body (serverContent "") with a real serverHash.
//    storeSyncConflict must not write an empty .remote, must mark hasServerContent=false, and the
//    resolver must refuse to clear the local note when the remote body cannot be fetched.
{
  const p = makePlugin();
  const file = Object.assign(new TFile("notes/a.md"), { __content: "local body" });
  p.files.set("notes/a.md", file);
  const stored = await store.storeSyncConflict(p, {
    kind: "note", path: "notes/a.md", reason: "both_modified",
    serverHash: "h:remote body", serverRevision: "rev-1", serverDeleted: false,
    baseHash: "", baseMissing: true, serverContent: "",
  });
  assert.equal(stored, true);
  const meta = JSON.parse(p.meta.get("notes/a.md"));
  assert.equal(meta.hasServerContent, false, "an un-inlined remote body is not reported as stashed");
  assert.equal(meta.localHashAtDetection, "h:local body", "the detection hash is recorded for the re-check");
  const remoteWrites = p.written.filter(([wp]) => wp.endsWith(".remote"));
  assert.deepEqual(remoteWrites, [], "no empty .remote file is written for an un-inlined body");

  const result = await resolve.resolveConflictEntry(p, "notes/a.md", "remote");
  assert.deepEqual(plain(result), { path: "notes/a.md", ok: false, reason: "missing_remote" }, "unavailable remote body is refused");
  assert.equal(p.files.get("notes/a.md").__content, "local body", "the local note is never cleared");
}

// 2. P0-03: when the HTTP endpoint can supply the body and its hash matches, the remote is applied.
{
  const p = makePlugin();
  const file = Object.assign(new TFile("notes/b.md"), { __content: "local body" });
  p.files.set("notes/b.md", file);
  p.api = { getNoteContent: async (path) => (path === "notes/b.md" ? { content: "remote body", contentHash: "h:remote body" } : null) };
  storeMeta(p, "notes/b.md", {
    kind: "note", reason: "both_modified", serverHash: "h:remote body", serverRevision: "rev-1",
    serverDeleted: false, baseMissing: true, hasServerContent: false, localHashAtDetection: "h:local body",
  });
  const result = await resolve.resolveConflictEntry(p, "notes/b.md", "remote");
  assert.equal(result.ok, true);
  assert.equal(p.files.get("notes/b.md").__content, "remote body", "the fetched remote body is applied");
}

// 3. P0-03: a fetched body whose hash no longer matches the detection hash is refused.
{
  const p = makePlugin();
  const file = Object.assign(new TFile("notes/c.md"), { __content: "local body" });
  p.files.set("notes/c.md", file);
  p.api = { getNoteContent: async () => ({ content: "changed remotely", contentHash: "h:changed remotely" }) };
  storeMeta(p, "notes/c.md", {
    kind: "note", reason: "both_modified", serverHash: "h:remote body", serverRevision: "rev-1",
    serverDeleted: false, baseMissing: true, hasServerContent: false, localHashAtDetection: "h:local body",
  });
  const result = await resolve.resolveConflictEntry(p, "notes/c.md", "remote");
  assert.equal(result.ok, false, "a changed remote body is not applied over the local note");
  assert.equal(p.files.get("notes/c.md").__content, "local body");
}

// 4. P0-05: a binary setting conflict stashes the raw bytes and restores them byte-exactly.
{
  const p = makePlugin();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]);
  const envelope = codec.encodeConfigContent(png);
  assert.ok(envelope.startsWith("fns-bin-v1:b64:"), "fixture really is a binary envelope");
  const local = Object.assign(new TFile(".obsidian/themes/x/cover.png"), { __bytes: new Uint8Array([1, 2, 3]).buffer });
  p.files.set(".obsidian/themes/x/cover.png", local);
  await store.storeSyncConflict(p, {
    kind: "setting", path: ".obsidian/themes/x/cover.png", reason: "both_modified",
    serverHash: "file:.obsidian/themes/x/cover.png", serverRevision: "rev-9", serverDeleted: false,
    baseHash: "", baseMissing: true, serverContent: envelope,
  });
  const meta = JSON.parse(p.meta.get(".obsidian/themes/x/cover.png"));
  assert.equal(meta.isBinary, true, "binary settings are marked in the metadata");
  const remoteWrite = p.written.find(([wp]) => wp.endsWith(".remote"));
  assert.ok(remoteWrite, "the remote binary is stashed");
  assert.deepEqual(Array.from(remoteWrite[1]), Array.from(png), "the .remote copy holds the exact raw bytes");

  const result = await resolve.resolveConflictEntry(p, ".obsidian/themes/x/cover.png", "remote");
  assert.equal(result.ok, true);
  const applied = p.files.get(".obsidian/themes/x/cover.png");
  assert.deepEqual(Array.from(new Uint8Array(applied.__bytes)), Array.from(png), "the local file is restored byte-exactly");
}

// 5. P0-04: local_deleted note + "keep local" deletes with the confirmed remote baseline.
{
  const p = makePlugin();
  storeMeta(p, "notes/gone.md", {
    kind: "note", reason: "local_deleted", serverHash: "h:remote", serverRevision: "rev-7",
    serverDeleted: false, baseHash: "h:stale-base", baseMissing: false, hasServerContent: true,
  });
  const result = await resolve.resolveConflictEntry(p, "notes/gone.md", "local");
  assert.equal(result.ok, true);
  assert.deepEqual(plain(p.deletes), [["NoteDelete", "notes/gone.md", { hash: "h:remote", hashMissing: false, revision: "rev-7" }]],
    "the delete carries the confirmed remote hash + revision, not the stale baseHash");
}

// 6. P0-04: local_deleted file + "keep local" uses the same confirmed baseline.
{
  const p = makePlugin();
  storeMeta(p, "files/gone.png", {
    kind: "file", reason: "local_deleted", serverHash: "h:remote-file", serverRevision: "rev-3",
    serverDeleted: false, baseHash: "h:stale", baseMissing: false, hasServerContent: false,
  });
  const result = await resolve.resolveConflictEntry(p, "files/gone.png", "local");
  assert.equal(result.ok, true);
  assert.deepEqual(plain(p.deletes), [["FileDelete", "files/gone.png", { hash: "h:remote-file", hashMissing: false, revision: "rev-3" }]]);
}

// 7. P0-04: local_deleted setting + "keep local" sends SettingDelete with the confirmed baseline.
{
  const p = makePlugin();
  storeMeta(p, ".obsidian/app.json", {
    kind: "setting", reason: "local_deleted", serverHash: "h:cfg", serverRevision: "rev-5",
    serverDeleted: false, baseHash: "h:stale", baseMissing: false, hasServerContent: true,
  });
  const result = await resolve.resolveConflictEntry(p, ".obsidian/app.json", "local");
  assert.equal(result.ok, true);
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0][0], "SettingDelete");
  assert.equal(p.sent[0][1].baseHash, "h:cfg");
  assert.equal(p.sent[0][1].baseRevision, "rev-5");
}

// 8. P0-04: local_deleted folder + "keep local" deletes the remote folder (not creating it).
{
  const p = makePlugin();
  storeMeta(p, "Blog/gone", {
    kind: "folder", reason: "local_deleted", serverRevision: "rev-2",
    serverDeleted: false, baseHash: "", baseMissing: true,
  });
  const result = await resolve.resolveConflictEntry(p, "Blog/gone", "local");
  assert.equal(result.ok, true);
  assert.equal(p.folders.has("Blog/gone"), false, "keep-local does not recreate the folder");
  assert.deepEqual(plain(p.deletes), [["FolderDelete", "Blog/gone", { hash: "", hashMissing: true, revision: "rev-2" }]]);
  assert.deepEqual(plain(removedFolders), ["Blog/gone"], "the local snapshot is dropped");
}

// 9. P0-04: local_deleted folder + "adopt remote" recreates it locally and records the snapshot.
{
  removedFolders.length = 0; folderSnapshots.length = 0;
  const p = makePlugin();
  storeMeta(p, "Blog/back", {
    kind: "folder", reason: "local_deleted", serverRevision: "rev-4",
    serverDeleted: false, baseHash: "", baseMissing: true,
  });
  const result = await resolve.resolveConflictEntry(p, "Blog/back", "remote");
  assert.equal(result.ok, true);
  assert.ok(p.folders.has("Blog/back"), "adopting remote recreates the local folder");
  assert.equal(folderSnapshots.length, 1, "a folder snapshot is recorded");
  assert.deepEqual(plain(p.confirmed).filter(([k]) => k === "folder"), [["folder", "Blog/back", "rev-4"]]);
}

// 10. P1-05: storing a conflict freezes the path — in-flight upload, page attribution, delete acks
//     and the concurrency slot are all cleared.
{
  const p = makePlugin();
  p.pendingNoteModifies.set("notes/x.md", "h:x");
  p.pendingUploadHashes.set("notes/x.md", "h:x");
  p.pendingConfigModifies.set("notes/x.md", "h:x");
  p.pendingNoteDeleteAcks.add("notes/x.md");
  p.pendingFileDeleteAcks.add("notes/x.md");
  p.pendingConfigDeleteAcks.add("notes/x.md");
  p.syncState.pendingNotePushPageIndex.set("notes/x.md", 2);
  p.syncState.pendingFilePushPageIndex.set("notes/x.md", 3);
  p.syncState.pendingConfigPushPageIndex.set("notes/x.md", 4);
  await store.storeSyncConflict(p, {
    kind: "file", path: "notes/x.md", reason: "both_modified", serverHash: "h:remote",
    serverRevision: "rev-1", serverDeleted: false, baseHash: "", baseMissing: true, serverContent: "",
  });
  assert.equal(p.pendingNoteModifies.size, 0);
  assert.equal(p.pendingUploadHashes.size, 0);
  assert.equal(p.pendingConfigModifies.size, 0);
  assert.equal(p.pendingNoteDeleteAcks.size, 0);
  assert.equal(p.pendingFileDeleteAcks.size, 0);
  assert.equal(p.pendingConfigDeleteAcks.size, 0);
  assert.equal(p.syncState.pendingNotePushPageIndex.size, 0);
  assert.equal(p.syncState.pendingFilePushPageIndex.size, 0);
  assert.equal(p.syncState.pendingConfigPushPageIndex.size, 0);
  assert.ok(p.__clearedUploads.includes("notes/x.md"), "the attachment upload tracking and its ack timer are cleared");
  assert.ok(released.includes("notes/x.md"), "the concurrency slot is released");
}

console.log("PASS: empty remote bodies, binary settings, confirmed-baseline deletes, folder routing and 530 freezing");
