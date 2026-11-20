import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// #276: a path in conflictedPaths must not upload (local edits or server NeedPush) until the user
// resolves it, and its base/remote backups survive the start-of-sync cleanup.
const root = path.resolve(import.meta.dirname, "..");
class TFile { constructor(p) { this.path = p; this.extension = p.split(".").pop(); this.stat = { size: 1, mtime: 5, ctime: 1 }; } }
const logs = [];
const helpers = new Proxy({
  isPathExcluded: () => false,
  hashContent: s => `h${s.length}`,
  hashContentAsync: async s => `h${s.length}`,
  getPluginDir: () => ".obsidian/plugins/fns",
  generateUUID: () => "ctx",
}, { get: (target, name) => target[name] ?? (() => undefined) });
function load(name, extra = {}) {
  const source = fs.readFileSync(path.join(root, `src/lib/sync/${name}.ts`), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, window: { setTimeout: () => 1, clearTimeout() {} },
    require(id) {
      if (id.includes("baseline_scope")) return { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) };
    if (id.includes("conflict_store")) return { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" };
          if (id === "obsidian") return { TFile, TFolder: class {}, normalizePath: p => p, Platform: { isMobile: false } };
      if (id === "../utils/helpers") return helpers;
      if (id.includes("sync_log_manager")) return { SyncLogManager: { getInstance: () => ({ addLog: (...a) => logs.push(a), addOrUpdateLog() {} }) } };
      if (id.includes("i18n")) return { $: k => k };
      if (id in extra) return extra[id];
      return {};
    },
  });
  return module.exports;
}
const note = load("operator_note");

function fixture(conflicted) {
  const file = new TFile("a/x.md"), sent = [], completed = [];
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    app: { vault: { getFileByPath: p => (p === file.path ? file : null), read: async () => "local" } },
    lockManager: { withLock: async (_, fn) => fn() },
    websocket: { SendMessage: async (action, data) => sent.push([action, data.path]) },
    syncState: { conflictedPaths: new Set(conflicted ? [file.path] : []), pendingNotePushPageIndex: new Map() },
    fileHashManager: { getPathHash: () => "base", getValidHash: () => null },
    lastSyncMtime: new Map(), pendingNoteModifies: new Map(), pendingNoteDeleteAcks: new Set(),
    localStorageManager: { savePending() {} },
    concurrencyLimiter: { waitForSlot: async () => true },
    isIgnoredFile: () => false, addIgnoredFile() {}, removeIgnoredFile() {},
    recordSyncCompleted: (...a) => completed.push(a),
  };
  return { file, plugin, sent, completed };
}

for (const conflicted of [false, true]) {
  const f = fixture(conflicted);
  await note.noteModify(f.file, f.plugin, true);
  assert.deepEqual(f.sent, conflicted ? [] : [["NoteModify", "a/x.md"]], `local edit, conflicted=${conflicted}`);
  const g = fixture(conflicted);
  await note.receiveNoteUpload({ path: "a/x.md", pageIndex: 2 }, g.plugin);
  assert.deepEqual(g.sent, conflicted ? [] : [["NoteModify", "a/x.md"]], `server NeedPush, conflicted=${conflicted}`);
  assert.equal(g.completed.length, conflicted ? 1 : 0, "a paused NeedPush still completes its page");
}

// Start-of-sync cleanup keeps backups of paths still in conflict
{
  const operator = load("operator", { "./operator_note": note });
  const dir = ".obsidian/plugins/fns/conflict-notes";
  const keepStem = `${dir}/a_x_h6`; // "a/x.md" -> safeName "a_x", hashContent -> "h6"
  const files = [`${keepStem}.base.md`, `${keepStem}.remote.md`, `${dir}/old_h9.base.md`, `${dir}/old_h9.remote.md`];
  const removed = [];
  const plugin = {
    isSyncing: false, settings: {},
    app: { vault: { adapter: { exists: async () => true, list: async () => ({ files }), remove: async f => removed.push(f) } } },
    syncState: { conflictedPaths: new Set(["a/x.md"]), newConflictedPathsThisRound: new Set() },
    menuManager: { ribbonIconStatus: false }, websocket: { triggerReconnect() {} },
  };
  await operator.handleSync(plugin);
  assert.deepEqual(removed, [`${dir}/old_h9.base.md`, `${dir}/old_h9.remote.md`], "only resolved/stale backups are removed");
}
console.log("conflict upload pause tests passed");
