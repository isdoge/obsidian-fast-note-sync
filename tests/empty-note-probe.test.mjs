import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// #205: a never-synced empty local note (e.g. Obsidian's auto-created daily note) must not
// overwrite the server copy. Both upload entries (live noteModify and scan-driven
// receiveNoteUpload) hold the upload and probe with NoteRePush instead:
// - server has the note  -> NoteSyncModify overwrites the local empty file
// - server doesn't      -> NoteSyncDelete, whose #277 keep-branch re-uploads the empty file
// An empty note WITH a sync baseline (user deliberately cleared it) still uploads directly.
const root = path.resolve(import.meta.dirname, "..");
class TFile { constructor(p) { this.path = p; this.stat = { size: 0, mtime: 5, ctime: 1 }; } }
const logs = [];
const helpers = new Proxy({
  isPathExcluded: () => false,
  checkAndNotifyCaseConflict: () => false,
  hashContent: s => `h${s.length}`,
  hashContentAsync: async s => `h${s.length}`,
}, { get: (target, name) => target[name] ?? (() => undefined) });
function load(name) {
  const source = fs.readFileSync(path.join(root, `src/lib/sync/${name}.ts`), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Map, Set, Date,
    window: { setTimeout: () => 1, clearTimeout() {} },
    require(id) {
      if (id.includes("baseline_scope")) return { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) };
    if (id.includes("conflict_store")) return { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" };
          if (id === "obsidian") return { TFile, normalizePath: p => p, Platform: { isMobile: false } };
      if (id === "../utils/helpers") return helpers;
      if (id === "./remote_path_guard") return { blockAliasedRemoteMutation: () => false };
      if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: (...a) => logs.push(a) }) } };
      if (id === "./sync_state") return { advanceLiveSyncTime: (plugin, field, lastTime) => { if (lastTime && lastTime > Number(plugin.localStorageManager.getMetadata(field))) plugin.localStorageManager.setMetadata(field, lastTime); } };
      return {};
    },
  });
  return module.exports;
}
const note = load("operator_note");

function fixture({ content = "", base = null, conflicted = false } = {}, { sendMode = "ok" } = {}) {
  const file = new TFile("diary/2026-11-18.md"), sent = [], completed = [], trashed = [], written = [];
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    app: {
      vault: {
        getFileByPath: p => (p === file.path ? file : null),
        read: async () => content,
        modify: async (f, data) => written.push([f.path, data]),
        create: async (p, data) => written.push([p, data]),
        createFolder: async () => {},
        getFolderByPath: () => ({}),
      },
      fileManager: { trashFile: async f => trashed.push(f.path) },
    },
    lockManager: { withLock: async (_, fn) => fn() },
    websocket: {
      SendMessage: async (action, data, _before, after) => {
        sent.push([action, data.path]);
        // 模拟“消息真正交给连接”：第三个回调只在真正发出时被调用
        // Simulate "handed to the connection": the 4th-arg callback only fires on a real send
        if (sendMode === "ok") after?.();
        if (sendMode === "reject") throw new Error("connection not open");
      },
    },
    syncState: { conflictedPaths: new Set(conflicted ? [file.path] : []), pendingNotePushPageIndex: new Map() },
    fileHashManager: {
      getPathHash: () => base,
      getValidHash: () => null,
      setFileHash(p, hash) { this.getPathHash = () => hash; },
      removeFileHash() {},
    },
    lastSyncMtime: new Map(), lastSyncPathDeleted: new Set(),
    pendingNoteModifies: new Map(), pendingNoteDeleteAcks: new Set(),
    localStorageManager: { getMetadata: () => 0, setMetadata() {}, savePending() {} },
    concurrencyLimiter: { waitForSlot: async () => true, releaseSlot() {} },
    isIgnoredFile: () => false, addIgnoredFile() {}, removeIgnoredFile() {},
    noteSyncTasks: { failed: 0 }, recordSyncCompleted: (...a) => completed.push(a),
  };
  return { file, plugin, sent, completed, trashed, written };
}

// --- live path (noteModify) ---
// never-synced empty note: upload held, probe sent instead
{
  const f = fixture();
  await note.noteModify(f.file, f.plugin, true);
  assert.deepEqual(f.sent, [["NoteRePush", f.file.path]], "live: probe instead of upload");
  // repeated modify events while probing must not spam a second probe
  await note.noteModify(f.file, f.plugin, true);
  assert.equal(f.sent.length, 1, "live: probe is deduplicated while in flight");
}
// empty note WITH a baseline (user cleared a synced note): uploads directly
{
  const f = fixture({ base: "h5" });
  await note.noteModify(f.file, f.plugin, true);
  assert.deepEqual(f.sent, [["NoteModify", f.file.path]], "live: baseline present, empty note uploads");
}
// non-empty never-synced note: uploads directly
{
  const f = fixture({ content: "hello" });
  await note.noteModify(f.file, f.plugin, true);
  assert.deepEqual(f.sent, [["NoteModify", f.file.path]], "live: non-empty note uploads");
}

// --- scan path (receiveNoteUpload / NeedPush) ---
// never-synced empty note: NeedPush answered with a probe, page item still completed
{
  const f = fixture();
  await note.receiveNoteUpload({ path: f.file.path, pageIndex: 3 }, f.plugin);
  assert.deepEqual(f.sent, [["NoteRePush", f.file.path]], "scan: probe instead of upload");
  assert.deepEqual(f.completed, [["note", 3]], "scan: held NeedPush still completes its page item");
}
// empty note WITH a baseline: NeedPush answered with a normal upload
{
  const f = fixture({ base: "h5" });
  await note.receiveNoteUpload({ path: f.file.path, pageIndex: 3 }, f.plugin);
  assert.deepEqual(f.sent, [["NoteModify", f.file.path]], "scan: baseline present, empty note uploads");
}

// --- probe verdict: server HAS the note -> NoteSyncModify overwrites the local empty file ---
{
  const f = fixture();
  await note.noteModify(f.file, f.plugin, true);
  assert.equal(f.sent.length, 1, "probe sent");
  await note.receiveNoteSyncModify({
    path: f.file.path, content: "server diary", contentHash: "hs",
    ctime: 1, mtime: 9, lastTime: 0, pageIndex: 0,
  }, f.plugin);
  assert.deepEqual(f.written, [[f.file.path, "server diary"]], "verdict modify: server content written locally");
  assert.equal(f.plugin.fileHashManager.getPathHash(), "hs", "verdict modify: baseline established");
  // baseline now exists: a later empty modify is a deliberate clear and uploads normally
  f.sent.length = 0;
  await note.noteModify(f.file, f.plugin, true);
  assert.deepEqual(f.sent, [["NoteModify", f.file.path]], "after server overwrite, empty modify uploads (baseline exists)");
}

// --- probe verdict: server DOES NOT have the note -> NoteSyncDelete keeps the local empty
// --- file and re-uploads it (must not be trashed) ---
{
  const f = fixture();
  await note.noteModify(f.file, f.plugin, true);
  assert.equal(f.sent[0][0], "NoteRePush", "probe sent");
  await note.receiveNoteSyncDelete({ path: f.file.path, pageIndex: 0 }, f.plugin);
  assert.deepEqual(f.trashed, [], "verdict delete: local empty file is NOT trashed");
  assert.equal(f.plugin.noteSyncTasks.failed, 0, "verdict delete: not counted as failure");
  // the #277 keep-branch re-upload must send the empty file directly (no probe loop)
  await new Promise(r => setImmediate(r));
  assert.deepEqual(f.sent.slice(1), [["NoteModify", f.file.path]], "verdict delete: empty file re-uploaded directly");
  assert.equal(f.sent.filter(s => s[0] === "NoteRePush").length, 1, "no repeated probe loop");
}

// --- disconnect clears in-flight probe state; the next modify re-probes ---
{
  const f = fixture();
  await note.noteModify(f.file, f.plugin, true);
  assert.equal(f.sent.length, 1, "probe sent");
  note.clearEmptyNoteProbes(f.plugin);
  f.sent.length = 0;
  await note.noteModify(f.file, f.plugin, true);
  assert.deepEqual(f.sent, [["NoteRePush", f.file.path]], "after disconnect-clear, modify re-probes");
}

// --- a probe whose message never actually left (connection closed / dropped) must not stay
// --- "in flight" forever; the next scan probes again. The upload is still held either way. ---
{
  const f = fixture({}, { sendMode: "drop" });
  assert.equal(note.probeEmptyNoteInsteadOfUpload(f.plugin, f.file.path, "", null), true, "dropped: upload still held");
  await new Promise(r => setImmediate(r));
  assert.equal(note.probeEmptyNoteInsteadOfUpload(f.plugin, f.file.path, "", null), true, "dropped: still held on retry");
  assert.equal(f.sent.length, 2, "dropped: the unsent probe is released and re-sent");
}

// --- a probe that was really sent is not repeated within the TTL ---
{
  const f = fixture();
  assert.equal(note.probeEmptyNoteInsteadOfUpload(f.plugin, f.file.path, "", null), true);
  await new Promise(r => setImmediate(r));
  assert.equal(note.probeEmptyNoteInsteadOfUpload(f.plugin, f.file.path, "", null), true, "in-flight: upload held");
  assert.equal(f.sent.length, 1, "in-flight: no duplicate probe within the TTL");
}

// --- a probe with no verdict past the 60s TTL is retried ---
{
  const f = fixture();
  assert.equal(note.probeEmptyNoteInsteadOfUpload(f.plugin, f.file.path, "", null), true);
  await new Promise(r => setImmediate(r));
  const realNow = Date.now;
  const base = realNow();
  try {
    Date.now = () => base + 61_000;
    assert.equal(note.probeEmptyNoteInsteadOfUpload(f.plugin, f.file.path, "", null), true, "expired: upload still held");
  } finally {
    Date.now = realNow;
  }
  assert.equal(f.sent.length, 2, "expired: the probe is re-sent after the TTL");
}

// --- a rejected send releases the registration ---
{
  const f = fixture({}, { sendMode: "reject" });
  assert.equal(note.probeEmptyNoteInsteadOfUpload(f.plugin, f.file.path, "", null), true, "rejected: upload still held");
  await new Promise(r => setImmediate(r));
  assert.equal(note.probeEmptyNoteInsteadOfUpload(f.plugin, f.file.path, "", null), true, "rejected: still held on retry");
  assert.equal(f.sent.length, 2, "rejected: the next scan re-sends");
}

// --- releaseEmptyNoteProbe (plain server error) allows an immediate re-probe ---
{
  const f = fixture();
  assert.equal(note.probeEmptyNoteInsteadOfUpload(f.plugin, f.file.path, "", null), true);
  await new Promise(r => setImmediate(r));
  note.releaseEmptyNoteProbe(f.plugin, f.file.path);
  assert.equal(note.probeEmptyNoteInsteadOfUpload(f.plugin, f.file.path, "", null), true, "released: upload still held");
  assert.equal(f.sent.length, 2, "released: the next scan re-sends");
}

assert(logs.some(l => l[1] === "NoteEmptyProbe"), "probe is recorded in the sync log");
console.log("empty note probe tests passed");
