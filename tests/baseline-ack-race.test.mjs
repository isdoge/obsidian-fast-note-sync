import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Stage E §5.2: an upload Ack only confirms the snapshot that was sent. If the user kept editing
// during the upload, the late Ack must store {sentHash, revision} as the confirmed baseline but
// never mark the newer disk bytes as synced, and it must schedule a follow-up upload carrying the
// just-confirmed baseline. Revision tokens are bound to the remote target: switching api/vault
// discards them instead of sending vault A's token to vault B.
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
    window: { setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {} },
    setTimeout, clearTimeout, queueMicrotask, Promise, Map, Set, JSON,
    ...extraGlobals,
  });
  return module.exports;
}

const noop = () => undefined;
function makeHelpers() {
  return {
    dump: noop, dumpError: noop, showSyncNotice: noop,
    isPathExcluded: () => false, getPluginDir: () => ".obsidian/plugins/fns",
    hashContent: (s) => `p:${s}`, hashContentAsync: async (s) => `h:${s}`,
    getSafeCtime: (stat) => stat.ctime, normalizeServerTimestamp: (v) => v,
    checkAndNotifyCaseConflict: () => false,
    computeMirrorDigest: (data) => `${data.length}:${data.length * 31 + data.charCodeAt(0)}:${data}`,
    debounce: (fn) => { let t = null; return () => { if (t) clearTimeout(t); fn(); }; },
    LocalStateFileMirror: class { async read() { return null; } scheduleWrite() {} flush() {} },
  };
}

const helpers = makeHelpers();
const logs = [];
const baselineScope = loadModule("src/lib/storage/baseline_scope.ts", (id) => {
  if (id === "../utils/helpers") return helpers;
  throw new Error(`Unexpected require in baseline_scope: ${id}`);
});

class FakeFileHashManager {
  constructor() { this.hashes = new Map(); this.revisions = new Map(); this.confirmed = new Set(); this.pending = new Map(); this.calls = []; }
  getPathHash(p) { return this.hashes.get(p) ?? null; }
  getVerifiedPathHash(p, local) { const stored = this.hashes.get(p); return stored === undefined ? null : (this.confirmed.has(p) || local === stored ? stored : null); }
  getBaselineRevision(p) { return this.revisions.get(p) ?? null; }
  getConfirmedBaseline(p, local) { if (!this.confirmed.has(p)) return null; const hash = this.getVerifiedPathHash(p, local); const revision = this.revisions.get(p); return hash && revision ? { hash, revision } : null; }
  isBaselineConfirmed(p) { return this.confirmed.has(p) && this.revisions.has(p); }
  getValidHash() { return null; }
  setConfirmedBaseline(p, hash, revision, mtime = 0, size = 0, cacheContent = true) {
    this.calls.push(["confirm", p, hash, revision, cacheContent]);
    // 缓存表是否更新由 cacheContent 决定；基线表始终记录服务端确认的哈希
    this.hashes.set(p, hash);
    this.revisions.set(p, revision);
    this.confirmed.add(p);
  }
  setFileHash(p, hash, mtime, size, cacheContent = true, revision) {
    this.calls.push(["set", p, hash, revision]);
    if (cacheContent) this.hashes.set(p, hash);
    if (revision) this.revisions.set(p, revision);
    this.confirmed.add(p);
  }
  recordPendingDeleteBaseline(p) {
    const revision = this.confirmed.has(p) ? (this.revisions.get(p) ?? "") : "";
    const rec = { hash: this.confirmed.has(p) ? (this.hashes.get(p) ?? "") : "", hashMissing: revision === "", revision };
    this.pending.set(p, rec);
    return rec;
  }
  getPendingDeleteBaseline(p) { return this.pending.get(p) ?? null; }
  clearPendingDeleteBaseline(p) { this.pending.delete(p); }
  removeFileHash(p) { this.hashes.delete(p); this.revisions.delete(p); this.confirmed.delete(p); }
}

class MockTFile { constructor(p, stat = { size: 0, mtime: 1, ctime: 1 }) { this.path = p; this.stat = stat; } }
const ops = loadModule("src/lib/sync/operator_note.ts", (id) => {
  if (id === "obsidian") return { TFile: MockTFile, TFolder: class {}, normalizePath: (p) => p, Platform: { isMobile: false } };
  if (id === "../utils/helpers") return helpers;
  if (id === "../storage/baseline_scope") return baselineScope;
  if (id === "./remote_path_guard") return { blockAliasedRemoteMutation: () => false };
  if (id === "./remote_delete_guard") return { firstKeepWithoutBaseline: () => false };
  if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: (...a) => logs.push(a) }) } };
  if (id === "./sync_state") return { advanceLiveSyncTime: () => undefined };
  if (id === "../../i18n/lang") return { $: (k) => k };
  throw new Error(`Unexpected require in operator_note: ${id}`);
});

// ── Part 1: late Ack after a mid-upload edit ─────────────────────────────────
{
  const content = "NEW BODY";
  const sent = [];
  const modified = [];
  const file = new MockTFile("notes/race.md", { size: content.length, mtime: 9, ctime: 1 });
  const manager = new FakeFileHashManager();
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    app: {
      vault: {
        getFileByPath: (p) => (p === file.path ? file : null),
        read: async () => content,
        modify: async (_f, data) => { modified.push(data); },
      },
    },
    lockManager: { withLock: async (_k, fn) => fn() },
    websocket: { SendMessage: async (action, data) => { sent.push([action, data]); } },
    syncState: { conflictedPaths: new Set(), newConflictedPathsThisRound: new Set(), newUnalignedPathsThisRound: new Set(), pendingNotePushPageIndex: new Map(), isSyncBaselineModeEnabled: () => true },
    fileHashManager: manager,
    lastSyncMtime: new Map(), lastSyncPathDeleted: new Set(),
    pendingNoteModifies: new Map([["notes/race.md", "h:SENT"]]), pendingNoteDeleteAcks: new Set(),
    localStorageManager: { getMetadata: () => 0, setMetadata: noop, savePending: noop },
    concurrencyLimiter: { waitForSlot: async () => true, releaseSlot: noop },
    addIgnoredFile: noop, removeIgnoredFile: noop, isIgnoredFile: () => false,
    recordSyncCompleted: noop,
  };
  plugin.isSyncBaselineModeEnabled = () => true;

  await ops.receiveNoteModifyAck({ path: "notes/race.md", contentHash: "h:SENT", revision: "rev-1" }, plugin);

  const confirm = manager.calls.find(c => c[0] === "confirm");
  assert.deepEqual(confirm.slice(0, 5), ["confirm", "notes/race.md", "h:SENT", "rev-1", false],
    "late Ack confirms only the sent hash + revision and does not cache the newer disk bytes");
  assert.equal(manager.getConfirmedBaseline("notes/race.md", null)?.revision, "rev-1", "revision is retained");
  assert.equal(plugin.pendingNoteModifies.get("notes/race.md"), "h:NEW BODY", "newer edit stays pending");

  await new Promise(resolve => setTimeout(resolve, 10));
  const followUp = sent.find(([action]) => action === "NoteModify");
  assert.ok(followUp, "a follow-up upload is scheduled");
  assert.equal(followUp[1].contentHash, "h:NEW BODY", "follow-up uploads the new edit");
  assert.equal(followUp[1].baseHash, "h:SENT", "follow-up carries the just-confirmed hash");
  assert.equal(followUp[1].baseRevision, "rev-1", "follow-up carries the just-confirmed revision");
}

// ── Part 2: remote-target switch discards revision tokens ───────────────────
{
  const storage = new Map();
  const settings = { api: "https://a.example", vault: "vault-a", apiToken: "token" };
  const makePlugin = () => ({
    settings,
    app: {
      saveLocalStorage: (k, v) => storage.set(k, v),
      loadLocalStorage: (k) => storage.get(k) ?? null,
      vault: { getName: () => "local", getFiles: () => [], configDir: ".obsidian" },
    },
  });
  const { FileHashManager } = loadModule("src/lib/storage/file_hash_manager.ts", (id) => {
    if (id === "../utils/helpers") return helpers;
    if (id === "./baseline_scope") return baselineScope;
    if (id === "../../i18n/lang") return { $: (k) => k };
    if (id === "../../main") return {};
    throw new Error(`Unexpected require in file_hash_manager: ${id}`);
  });
  const first = new FileHashManager(makePlugin());
  first.setConfirmedBaseline("a.md", "hash-a", "rev-a", 10, 2);
  first.flush();
  assert.equal(first.getBaselineRevision("a.md"), "rev-a");

  settings.api = "https://b.example";
  assert.equal(first.getBaselineRevision("a.md"), null, "api switch discards the token immediately");
  assert.equal(first.getConfirmedBaseline("a.md", null), null, "confirmed provenance is gone after a target switch");
  assert.equal(first.getPathHash("a.md"), "hash-a", "hash stays for equality-only verification");
  first.flush();

  const second = new FileHashManager(makePlugin());
  await second.initialize();
  assert.equal(second.getBaselineRevision("a.md"), null, "persisted tokens of another target are never restored");
  assert.equal(second.getBaselineProvenance("a.md", "hash-a"), "persisted_verified", "legacy hash is only equality-verifiable");
}

console.log("baseline-ack-race.test.mjs: late-Ack snapshot confirmation, follow-up upload and remote-scope isolation passed");
