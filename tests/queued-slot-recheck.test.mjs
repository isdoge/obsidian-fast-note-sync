import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Path-only legacy ACKs must never certify queued content. Exercise real operators and limiter.
const noop = () => {};
const dumps = [];
const timers = [];
const cleared = [];
const state = { hash: "h-new" };
const helpers = new Proxy({
  dump: (...a) => dumps.push(a.map(String)),
  isPathExcluded: () => false,
  isLargeBinarySyncRisk: () => false,
  hashFileAsync: async () => state.hash,
  hashContent: p => `ph:${p}`,
  getSafeCtime: s => s.ctime,
  logMemorySnapshot: noop,
  normalizeServerTimestamp: t => t,
}, { get: (t, k) => t[k] ?? noop });
class TFile { constructor(p) { this.path = p; this.stat = { size: 10, mtime: 200, ctime: 1 }; } }
function load(file, extra = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, Map, Set, JSON, Promise, Object, Array, Date, Math, TextEncoder, Uint8Array, ArrayBuffer, DataView,
    window: { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: h => { cleared.push(h); } },
    require: id => id === "obsidian" ? { TFile, normalizePath: p => p, Platform: { isMobile: false } }
      : id.includes("helpers") ? helpers
      : id.includes("sync_log_manager") ? { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } }
      : id.includes("sync_state") ? { advanceLiveSyncTime }
      : id.includes("baseline_scope") ? { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) } : id.includes("conflict_store") ? { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" } : extra[id] || {} });
  return module.exports;
}
const { ConcurrencyLimiter } = load("src/lib/sync/concurrency_limiter.ts");
const { advanceLiveSyncTime } = load("src/lib/sync/sync_state.ts");
const ops = load("src/lib/sync/operator_file.ts", {
  "../api/http_api_service": { HttpApiService: class {
    async getFileInfo() { return { contentHash: state.remoteHash }; }
  } },
});
const tick = () => new Promise(setImmediate);

function makePlugin({ max = 1 } = {}) {
  const sent = [];
  const baselines = new Map();
  const files = new Map();
  const meta = new Map();
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v", concurrencyControlEnabled: true, maxConcurrentUploads: max },
    lockManager: { withLock: async (_p, fn) => fn() },
    addIgnoredFile: noop, removeIgnoredFile: noop, isIgnoredFile: () => false,
    fileHashManager: {
      getPathHash: p => baselines.get(p) ?? null,
      getValidHash: () => null,
      setFileHash: (p, h) => baselines.set(p, h),
      setFileHashes: noop,
      removeFileHash: noop,
    },
    lastSyncMtime: new Map(),
    pendingUploadHashes: new Map(),
    pendingFileDeleteAcks: new Set(),
    localStorageManager: { savePending: noop, getMetadata: k => meta.get(k) ?? 0, setMetadata: (k, v) => meta.set(k, v) },
    syncState: { activeSyncContext: null, hasSyncedThisConnection: true, pendingFilePushPageIndex: new Map() },
    websocket: {
      SendMessage: async (action, data, _before, after) => { sent.push({ action, data }); after?.(); },
      SendBinary: async (_d, _p, _before, after) => { after?.(); return "sent"; },
    },
    recordSyncCompleted: noop,
    fileSyncTasks: { failed: 0 },
    totalChunksToUpload: 0, uploadedChunksCount: 0,
    app: { vault: { getFileByPath: p => files.get(p), readBinary: async () => new ArrayBuffer(0), getName: () => "v" }, loadLocalStorage: noop, saveLocalStorage: noop },
  };
  plugin.concurrencyLimiter = new ConcurrencyLimiter(plugin);
  return { plugin, sent, baselines, files };
}

// A late path-only ACK for A must not confirm B while B waits for a slot.
{
  const { plugin, sent, baselines, files } = makePlugin();
  const file = new TFile('queued.bin'); files.set(file.path, file);
  state.hash = 'A'; await ops.fileModify(file, plugin, true);
  plugin.concurrencyLimiter.releaseSlot(file.path); // timeout recovery returns A's slot
  await plugin.concurrencyLimiter.waitForSlot('busy');
  state.hash = 'B'; file.stat.mtime++;
  const modifyB = ops.fileModify(file, plugin, true);
  await tick(); await tick();
  ops.receiveFileUploadAck({ path: file.path }, plugin);
  assert.notEqual(baselines.get(file.path), 'B', 'A ACK cannot commit queued B');
  plugin.concurrencyLimiter.releaseSlot('busy'); await modifyB;
  assert.equal(sent.length, 2, 'B still sends its own check against every supported server');
  assert.equal(sent[1].data.contentHash, 'B');
}
// With no identifiable prior upload, a path-only ACK cannot cancel a queued check.
{
  const { plugin, sent, files } = makePlugin();
  const file = new TFile('unknown.bin'); files.set(file.path, file);
  state.hash = 'B'; await plugin.concurrencyLimiter.waitForSlot('busy');
  const modify = ops.fileModify(file, plugin, true); await tick();
  ops.receiveFileUploadAck({ path: file.path }, plugin);
  plugin.concurrencyLimiter.releaseSlot('busy'); await modify;
  assert.equal(sent.length, 1); assert.equal(sent[0].data.contentHash, 'B');
}
console.log('PASS: queued checks cannot be skipped by ambiguous or legacy path-only ACKs');

// Real 60-second recovery: an expired A upload must not let its late ACK certify B.
{
  const { plugin, sent, baselines, files } = makePlugin();
  const file = new TFile('timeout.bin'); files.set(file.path, file);
  plugin.websocket.isOpen = true;
  state.hash = 'A'; await ops.fileModify(file, plugin, true);
  const timeout = timers.at(-1);
  const busy = plugin.concurrencyLimiter.waitForSlot('busy');
  state.hash = 'B'; file.stat.mtime++;
  timeout(); await busy; await tick(); await tick();
  ops.receiveFileUploadAck({ path: file.path }, plugin);
  assert.notEqual(baselines.get(file.path), 'B');
  plugin.concurrencyLimiter.releaseSlot('busy'); await tick(); await tick();
  assert.equal(sent.at(-1).data.contentHash, 'B', 'recovery still sends B after the late path-only ACK');
  assert.equal(sent.length, 2);
  state.remoteHash = 'B';
  await ops.receiveFileUploadAck({ path: file.path }, plugin);
  assert.equal(baselines.get(file.path), 'B', 'HTTP metadata confirms recovered B without requiring a new ACK field');
  assert.equal(plugin.pendingUploadHashes.has(file.path), false);
}

// Same content confirmed by a paged upload while the check waits must skip the redundant check.
{
  const { plugin, sent, baselines, files } = makePlugin();
  const file = new TFile('confirmed-while-queued.bin'); files.set(file.path, file);
  state.hash = 'H'; state.remoteHash = 'H';
  await plugin.concurrencyLimiter.waitForSlot('busy');
  const modify = ops.fileModify(file, plugin, true);
  for (let i = 0; i < 20 && plugin.concurrencyLimiter.queue.length === 0; i++) await tick();
  assert.equal(plugin.concurrencyLimiter.queue.length, 1, 'check queues behind the busy slot');
  void ops.receiveFileUpload({ path: file.path, pathHash: `ph:${file.path}`, sessionId: 'S1', chunkSize: 1024 * 1024, pageIndex: 1 }, plugin);
  assert.equal(plugin.concurrencyLimiter.queue.length, 2, 'paged upload queues on the same path');
  plugin.concurrencyLimiter.releaseSlot('busy');
  const queuedTimers = timers.length;
  for (let i = 0; i < 50 && timers.length === queuedTimers; i++) await tick();
  assert.equal(timers.length, queuedTimers + 1, 'paged upload sent every chunk and armed its ack timer');
  await tick(); await tick();
  await ops.receiveFileUploadAck({ path: file.path, lastTime: 1 }, plugin);
  await modify;
  assert.equal(sent.filter(s => s.action === 'FileUploadCheck').length, 0, 'no redundant check for content already confirmed while queued');
  assert.equal(baselines.get(file.path), 'H');
  assert.equal(plugin.pendingUploadHashes.has(file.path), false);
  assert.equal(plugin.concurrencyLimiter.activeKeys.size, 0, 'queued check returns its slot when it skips');
}
