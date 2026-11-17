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
    module, exports: module.exports, console, Map, Set,
    window: { setTimeout: () => 1, clearTimeout() {} },
    require(id) {
      if (id === "obsidian") return { TFile, normalizePath: p => p, Platform: { isMobile: false } };
      if (id === "../utils/helpers") return helpers;
      if (id === "./remote_path_guard") return { blockAliasedRemoteMutation: () => false };
      if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: (...a) => logs.push(a) }) } };
      return {};
    },
  });
  return module.exports;
}
const note = load("operator_note");

function fixture({ content = "", base = null, conflicted = false } = {}) {
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
    websocket: { SendMessage: async (action, data) => sent.push([action, data.path]) },
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

assert(logs.some(l => l[1] === "NoteEmptyProbe"), "probe is recorded in the sync log");
console.log("empty note probe tests passed");
