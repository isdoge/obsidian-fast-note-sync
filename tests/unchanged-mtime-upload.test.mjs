import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// #256: opening a canvas makes Obsidian rewrite it unchanged, refreshing only its mtime. That must not
// upload (the newer mtime would overwrite another device's newer server version); real edits and
// pending uploads still go out. The hash manager keeps the synced mtime for the scan to report.
const noop = () => {};
function load(file, require) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, Map, Set, window: { setTimeout: () => 1, clearTimeout: noop }, require });
  return module.exports;
}
class TFile { constructor(p) { this.path = p; this.stat = { size: 10, mtime: 200, ctime: 1 }; } }
let localHash = "base";
const ops = load("src/lib/sync/operator_file.ts", id => id === "obsidian" ? { TFile, normalizePath: p => p, Platform: { isMobile: false } }
  : id.includes("helpers") ? new Proxy({ isPathExcluded: () => false, isLargeBinarySyncRisk: () => false, hashFileAsync: async () => localHash,
      hashContent: () => "p", getSafeCtime: s => s.ctime }, { get: (t, k) => t[k] ?? noop })
  : id.includes("sync_log_manager") ? { SyncLogManager: { getInstance: () => ({ addLog: noop }) } } : id.includes("baseline_scope") ? { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) } : id.includes("conflict_store") ? { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" } : {});

async function modify({ hash, pending = false, force = false }) {
  localHash = hash;
  const sent = [];
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    lockManager: { withLock: async (_, fn) => fn() }, addIgnoredFile: noop, removeIgnoredFile: noop, isIgnoredFile: () => false,
    fileHashManager: { getPathHash: () => "base", getValidHash: () => null },
    lastSyncMtime: new Map(), pendingUploadHashes: new Map(pending ? [["board.canvas", "x"]] : []), pendingFileDeleteAcks: new Set(),
    localStorageManager: { savePending: noop }, concurrencyLimiter: { waitForSlot: async () => true },
    syncState: { activeSyncContext: null }, websocket: { SendMessage: async a => sent.push(a) },
  };
  await ops.fileModify(new TFile("board.canvas"), plugin, true, force);
  return sent.length;
}
assert.equal(await modify({ hash: "base" }), 0, "unchanged content with a new mtime does not upload");
assert.equal(await modify({ hash: "edited" }), 1, "real edits upload");
assert.equal(await modify({ hash: "base", pending: true }), 1, "a revert while an upload is pending still uploads");
assert.equal(await modify({ hash: "base", force: true }), 1, "forced checks still upload");

const storage = new Map();
const { FileHashManager } = load("src/lib/storage/file_hash_manager.ts", id => id.includes("helpers")
  ? { debounce: fn => fn, dump: noop, LocalStateFileMirror: class { scheduleWrite() {} flush() {} write() {} } } : id.includes("i18n") ? { $: k => k } : id.includes("baseline_scope") ? { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) } : id.includes("conflict_store") ? { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" } : {});
const m = new FileHashManager({ app: { saveLocalStorage: (k, v) => storage.set(k, v) } });
m.setFileHash("board.canvas", "base", 100, 10);
assert.equal(m.getSyncedMtime("board.canvas"), 100, "synced mtime available while the cache matches the baseline");
m.bulkSetFromScanned(new Map([["board.canvas", { hash: "edited", mtime: 300, size: 11 }]]));
assert.equal(m.getSyncedMtime("board.canvas"), undefined, "no synced mtime once the content changed");
assert.equal(m.getSyncedMtime("unknown.png"), undefined);
console.log("unchanged-content mtime refresh tests passed");
