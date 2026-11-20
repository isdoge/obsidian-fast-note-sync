import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Stage B: a remote NoteSyncModify must never silently overwrite local content that has no
// trusted sync baseline (first attach of an existing vault, external tool writes, lost local
// state). Such notes are kept, the remote version is stashed inside the plugin folder with
// reason "unaligned_no_baseline" / baseMissing: true, uploads for the path are paused and the
// entry is queued for alignment. Equal content confirms the baseline without a conflict, and
// the #205 empty-note probe behaviour is preserved. Batch alignment supports local / remote /
// keep-both and re-checks for edits made while the entry was pending.
const root = path.resolve(import.meta.dirname, "..");

function transpile(relPath) {
  const sourcePath = path.join(root, relPath);
  return ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
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

class TFile {
  constructor(p, stat = { size: 5, mtime: 100, ctime: 1 }) { this.path = p; this.stat = stat; }
}

const noop = () => undefined;
const helpers = new Proxy({
  isPathExcluded: () => false,
  hashContent: (s) => `p${s.length}`,
  hashContentAsync: async (s) => `h:${s}`,
  getPluginDir: () => ".obsidian/plugins/fns",
  checkAndNotifyCaseConflict: () => false,
  getSafeCtime: (stat) => stat.ctime,
  normalizeServerTimestamp: (v) => v,
}, { get: (t, n) => t[n] ?? noop });

function loadOps() {
  return loadModule("src/lib/sync/operator_note.ts", (id) => {
    if (id === "obsidian") return { TFile, TFolder: class {}, normalizePath: (p) => p, Platform: { isMobile: false } };
    if (id === "../utils/helpers") return helpers;
    if (id === "./remote_path_guard") return { blockAliasedRemoteMutation: () => false };
    if (id === "./remote_delete_guard") return { firstKeepWithoutBaseline: () => false };
    if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: (...a) => logs.push(a) }) } };
    if (id === "./sync_state") return { advanceLiveSyncTime: () => undefined };
    if (id === "../../i18n/lang") return { $: (k) => k };
    if (id.includes("baseline_scope")) return { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) };
    if (id.includes("conflict_store")) return { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" };
    throw new Error(`Unexpected require in operator_note: ${id}`);
  });
}

const logs = [];
const ops = loadOps();
const conflictAlign = loadModule("src/lib/sync/conflict_align.ts", (id) => {
  if (id === "obsidian") return { normalizePath: (p) => p, TFile };
  if (id === "../utils/helpers") return helpers;
  if (id === "./operator_note") return ops;
  if (id === "../../main") return {};
  throw new Error(`Unexpected require in conflict_align: ${id}`);
});

function makePlugin({ localContent = "local body", baseline = null, verified = baseline, pending = null, files = new Map(), baselineMode = false, lastNoteSyncTime = 0, remoteState = null } = {}) {
  const written = [];
  const modified = [];
  const created = [];
  const sent = [];
  const setHashes = [];
  const localFile = new TFile("notes/target.md", { size: localContent.length, mtime: 500, ctime: 1 });
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    app: {
      vault: {
        getFileByPath: (p) => (p === localFile.path ? localFile : null),
        getAbstractFileByPath: (p) => (p === localFile.path ? localFile : null),
        read: async () => localContent,
        modify: async (f, data) => { modified.push([f.path, data]); },
        create: async (p, data) => { created.push([p, data]); },
        createFolder: async () => undefined,
        getFolderByPath: () => ({}),
        adapter: {
          exists: async (p) => files.has(p),
          read: async (p) => files.get(p),
          write: async (p, d) => { files.set(p, d); written.push([p, d]); },
          mkdir: async () => undefined,
          remove: async (p) => { files.delete(p); },
          list: async () => ({ files: Array.from(files.keys()), folders: [] }),
          rmdir: async () => undefined,
        },
      },
      fileManager: { trashFile: async () => undefined },
    },
    lockManager: { withLock: async (_k, fn) => fn() },
    websocket: { SendMessage: async (action, data) => { sent.push([action, data.path]); } },
    syncState: {
      conflictedPaths: new Set(),
      newConflictedPathsThisRound: new Set(),
      newUnalignedPathsThisRound: new Set(),
      pendingNotePushPageIndex: new Map(),
    },
    fileHashManager: {
      getPathHash: () => baseline,
      getVerifiedPathHash: () => verified,
      getValidHash: () => null,
      setFileHash: (...a) => setHashes.push(a),
      removeFileHash: noop,
    },
    lastSyncMtime: new Map(), lastSyncPathDeleted: new Set(),
    pendingNoteModifies: new Map(pending ?? []), pendingNoteDeleteAcks: new Set(),
    localStorageManager: {
      getMetadata: (k) => (k === "lastNoteSyncTime" ? lastNoteSyncTime : 0), setMetadata: noop, savePending: noop,
      setConflictedPaths: (s) => { plugin.savedConflicts = Array.from(s); },
      syncPathPrefix: "_localStorage/", pathToKey: (p) => p, getItemValue: () => null,
    },
    isSyncBaselineModeEnabled: () => baselineMode,
    api: { getRetryQueueState: async () => remoteState },
    concurrencyLimiter: { waitForSlot: async () => true, releaseSlot: noop },
    statusBarManager: { updateConflictBadge: noop },
    isIgnoredFile: () => false, addIgnoredFile: noop, removeIgnoredFile: noop,
    noteSyncTasks: { failed: 0 }, recordSyncCompleted: noop,
    savedConflicts: [],
  };
  return { plugin, localFile, written, modified, created, sent, setHashes, files };
}

// Results cross a vm realm boundary; compare plain JSON instead of prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

const remoteMessage = (content, hash = `h:${content}`) => ({
  path: "notes/target.md", content, contentHash: hash, ctime: 1, mtime: 900, lastTime: 0, pageIndex: 0,
});

// 1. Local non-empty content, no baseline at all: keep local, stash remote, pause uploads.
{
  const files = new Map();
  const { plugin, modified, sent, written, files: store } = makePlugin({ files });
  await ops.receiveNoteSyncModify(remoteMessage("remote body"), plugin);

  assert.deepEqual(modified, [], "local note is never overwritten without a trusted baseline");
  assert.equal(plugin.syncState.conflictedPaths.has("notes/target.md"), true, "path is queued in the conflict list");
  assert.equal(plugin.syncState.newUnalignedPathsThisRound.has("notes/target.md"), true, "path is queued for the aggregated alignment notice");
  assert.equal(plugin.savedConflicts.includes("notes/target.md"), true, "queue is persisted");

  const remoteWrite = written.find(([p]) => p.endsWith(".remote.md"));
  assert.ok(remoteWrite, "remote version is stashed in the plugin conflict-notes folder");
  assert.equal(remoteWrite[1], "remote body");
  const metaWrite = written.find(([p]) => p.endsWith(".meta.json"));
  assert.ok(metaWrite, "provenance metadata is written");
  const meta = JSON.parse(metaWrite[1]);
  assert.equal(meta.reason, "unaligned_no_baseline");
  assert.equal(meta.baseMissing, true, "baseMissing is recorded honestly, no fabricated ancestor");
  assert.equal(meta.localHashAtDetection, "h:local body", "detection hash is persisted (hash only) for the batch re-check");
  assert.equal(store.has(".obsidian/plugins/fns/conflict-notes/notes_target_p15.base.md"), false, "no fabricated base file");

  // Upload pause: noteModify must not push while the path is queued.
  await ops.noteModify(new TFile("notes/target.md"), plugin, true);
  assert.deepEqual(sent, [], "uploads are paused for a queued alignment entry");
}

// 2. Same content on both sides: no write, no conflict, baseline confirmed.
{
  const { plugin, modified, written, setHashes, sent } = makePlugin({ localContent: "same body" });
  await ops.receiveNoteSyncModify(remoteMessage("same body"), plugin);
  assert.deepEqual(modified, [], "equal content is not rewritten");
  assert.equal(plugin.syncState.conflictedPaths.size, 0, "equal content is not a conflict");
  assert.deepEqual(written, [], "no conflict backups for equal content");
  assert.equal(setHashes.length, 1, "the server push confirms a trusted baseline");
  assert.equal(setHashes[0][0], "notes/target.md");
  assert.equal(setHashes[0][1], "h:same body");
  assert.deepEqual(sent, []);
}

// 3. #205 preserved: 0-byte never-synced note still pulls the remote version.
{
  const { plugin, modified, written } = makePlugin({ localContent: "" });
  await ops.receiveNoteSyncModify(remoteMessage("server diary"), plugin);
  assert.deepEqual(modified, [["notes/target.md", "server diary"]], "empty placeholder note still receives the server version");
  assert.deepEqual(written, [], "no conflict copies for the empty placeholder");
  assert.equal(plugin.syncState.conflictedPaths.size, 0);
}

// 4. Legacy persisted baseline that the local content no longer matches is NOT trusted.
{
  const { plugin, modified, written } = makePlugin({ localContent: "edited offline", baseline: "h:old", verified: null });
  await ops.receiveNoteSyncModify(remoteMessage("remote change"), plugin);
  assert.deepEqual(modified, [], "an unverified legacy baseline cannot justify overwriting local content");
  assert.equal(plugin.syncState.conflictedPaths.has("notes/target.md"), true);
  const meta = JSON.parse(written.find(([p]) => p.endsWith(".meta.json"))[1]);
  assert.equal(meta.reason, "unaligned_no_baseline");
}

// 5. Verified baseline + local diverged: ordinary conflict, no fabricated base.
{
  const { plugin, modified, written } = makePlugin({ localContent: "local edit", baseline: "h:base", verified: "h:base" });
  plugin.lastSyncMtime.set("notes/target.md", 100);
  await ops.receiveNoteSyncModify(remoteMessage("remote edit"), plugin);
  assert.deepEqual(modified, [], "two-sided edit is not overwritten");
  assert.equal(plugin.syncState.conflictedPaths.has("notes/target.md"), true);
  const meta = JSON.parse(written.find(([p]) => p.endsWith(".meta.json"))[1]);
  assert.equal(meta.baseMissing, true, "missing real base is recorded instead of inventing one");
  assert.notEqual(meta.reason, "unaligned_no_baseline", "this is a normal conflict, not a missing-baseline attach");
  assert.equal(written.some(([p]) => p.endsWith(".base.md")), false, "no base file is fabricated from local content");
}

// 6. Batch alignment: local / remote / both, plus the new-edit re-check.
{
  const makeEntryPlugin = (localContent, detectionHash) => {
    const state = makePlugin({ localContent });
    const base = `.obsidian/plugins/fns/conflict-notes/notes_target_p${"notes/target.md".length}`;
    state.files.set(`${base}.remote.md`, "remote body");
    state.files.set(`${base}.meta.json`, JSON.stringify({
      reason: "unaligned_no_baseline", baseMissing: true,
      remoteHash: "h:remote body", localHashAtDetection: detectionHash,
    }));
    state.plugin.syncState.conflictedPaths.add("notes/target.md");
    state.plugin.localStorageManager.setConflictedPaths = noop;
    return state;
  };

  // 6a. Keep local: state cleared, backups removed, upload issued.
  {
    const s = makeEntryPlugin("local body", "h:local body");
    const results = await conflictAlign.alignConflictEntries(s.plugin, ["notes/target.md"], "local");
    assert.deepEqual(plain(results), [{ path: "notes/target.md", ok: true }]);
    assert.equal(s.plugin.syncState.conflictedPaths.size, 0, "resolved entry leaves the conflict list");
    assert.equal(s.files.size, 0, "internal backups are cleaned up");
    assert.deepEqual(s.sent, [["NoteModify", "notes/target.md"]], "local version is uploaded");
    assert.deepEqual(s.modified, [], "local file untouched");
  }

  // 6b. Remote wins: local backup kept inside the plugin folder, file overwritten, baseline set.
  {
    const s = makeEntryPlugin("local body", "h:local body");
    const results = await conflictAlign.alignConflictEntries(s.plugin, ["notes/target.md"], "remote");
    assert.deepEqual(plain(results), [{ path: "notes/target.md", ok: true }]);
    assert.deepEqual(s.modified, [["notes/target.md", "remote body"]], "remote content applied");
    assert.equal(s.files.get(".obsidian/plugins/fns/conflict-notes/notes_target_p15.local-backup.md"), "local body", "local backup is kept before overwriting");
    assert.equal(s.plugin.syncState.conflictedPaths.size, 0);
    assert.deepEqual(s.setHashes.map((a) => [a[0], a[1]]), [["notes/target.md", "h:remote body"]], "baseline confirmed for the applied content");
  }

  // 6c. Keep both: local note untouched, remote saved as a visible copy, local uploaded.
  {
    const s = makeEntryPlugin("local body", "h:local body");
    const results = await conflictAlign.alignConflictEntries(s.plugin, ["notes/target.md"], "both");
    assert.deepEqual(plain(results), [{ path: "notes/target.md", ok: true }]);
    assert.deepEqual(s.created, [["notes/target.remote.md", "remote body"]], "remote version saved beside the note");
    assert.deepEqual(s.modified, [], "local note untouched");
    assert.deepEqual(s.sent, [["NoteModify", "notes/target.md"]]);
  }

  // 6d. Edited while pending: batch action is skipped and the entry stays queued.
  {
    const s = makeEntryPlugin("edited while pending", "h:local body");
    const results = await conflictAlign.alignConflictEntries(s.plugin, ["notes/target.md"], "remote");
    assert.deepEqual(plain(results), [{ path: "notes/target.md", ok: false, reason: "new_edit" }]);
    assert.deepEqual(s.modified, [], "new edits are never overwritten by a batch action");
    assert.equal(s.plugin.syncState.conflictedPaths.has("notes/target.md"), true, "entry remains queued for manual review");
    assert.equal(s.files.has(".obsidian/plugins/fns/conflict-notes/notes_target_p15.local-backup.md"), false);
  }

  // 6e. A missing local file is reported, not recreated.
  {
    const s = makeEntryPlugin("local body", "h:local body");
    s.plugin.app.vault.getFileByPath = () => null;
    const results = await conflictAlign.alignConflictEntries(s.plugin, ["notes/target.md"], "local");
    assert.deepEqual(plain(results), [{ path: "notes/target.md", ok: false, reason: "missing_local" }]);
  }
}

// 7. Legacy mode, first attach (never synced) and a live same-path remote note with a DIFFERENT
// hash: the NeedPush is not answered with an upload, the path is queued for alignment so the
// remote note survives.
{
  const { plugin, sent, written } = makePlugin({
    localContent: "local body", baseline: null, verified: null,
    remoteState: { path: "notes/target.md", contentHash: "h:remote body" },
  });
  await ops.receiveNoteUpload({ path: "notes/target.md", pageIndex: 0 }, plugin);
  assert.deepEqual(sent, [], "legacy first attach: no upload when the remote differs");
  assert.equal(plugin.syncState.conflictedPaths.has("notes/target.md"), true, "queued for alignment");
  assert.equal(plugin.syncState.newUnalignedPathsThisRound.has("notes/target.md"), true);
  assert.equal(written.some(([p]) => p.endsWith(".remote.md")), false, "NeedPush carries no body, so no remote copy is written");
  const meta = JSON.parse(written.find(([p]) => p.endsWith(".meta.json"))[1]);
  assert.equal(meta.baseMissing, true);
  assert.equal(meta.reason, "unaligned_no_baseline");
}

// 8. P0-02: an offline-created note (never synced, no baseline) must upload when the server asks
// for it. Baseline mode: NoteSync already routed real remote differences to SyncConflict, so a
// 200 NoteSyncNeedPush is a genuine create — upload with explicit no-baseline fields.
{
  const { plugin, sent } = makePlugin({ localContent: "offline body", baseline: null, verified: null, baselineMode: true });
  await ops.receiveNoteUpload({ path: "notes/target.md", pageIndex: 2 }, plugin);
  assert.deepEqual(sent, [["NoteModify", "notes/target.md"]], "baseline mode uploads the offline-created note");
  const upload = sent.length && sent[0][0] === "NoteModify";
  assert.ok(upload, "the upload is a NoteModify");
}

// 9. Legacy mode, first attach but the server has NO such note: this is a genuine new note and
// must upload rather than be stranded in pending alignment.
{
  const { plugin, sent } = makePlugin({
    localContent: "new note", baseline: null, verified: null, remoteState: null,
  });
  await ops.receiveNoteUpload({ path: "notes/target.md", pageIndex: 0 }, plugin);
  assert.deepEqual(sent, [["NoteModify", "notes/target.md"]], "absent remote: legacy mode uploads the new note");
  assert.equal(plugin.syncState.conflictedPaths.has("notes/target.md"), false, "absent remote is not a conflict");
}

// 10. Legacy mode, normal incremental round (already synced once): an upload request for a note
// without a stored baseline is a normal create/restore and must upload.
{
  const { plugin, sent } = makePlugin({
    localContent: "restored note", baseline: null, verified: null, lastNoteSyncTime: 1700000000000,
    remoteState: { path: "notes/target.md", contentHash: "h:something else" },
  });
  await ops.receiveNoteUpload({ path: "notes/target.md", pageIndex: 0 }, plugin);
  assert.deepEqual(sent, [["NoteModify", "notes/target.md"]], "normal incremental rounds never block the upload");
}

// 11. Legacy mode, first attach, remote exists but content is identical: no conflict, upload is
// harmless and allowed.
{
  const { plugin, sent } = makePlugin({
    localContent: "same body", baseline: null, verified: null,
    remoteState: { path: "notes/target.md", contentHash: "h:same body" },
  });
  await ops.receiveNoteUpload({ path: "notes/target.md", pageIndex: 0 }, plugin);
  assert.deepEqual(sent, [["NoteModify", "notes/target.md"]], "identical remote content does not block the upload");
}

console.log("remote-modify-no-baseline.test.mjs: all scenarios passed");
