import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// P1-06: `_localStorage/` virtual settings take part in the sync-baseline protocol.
// - getStorageConfigs() carries {baseHash, baseRevision} once the server confirmed a revision,
//   and baseHashMissing otherwise (never the current value posing as a baseline);
// - receiveConfigUpload answers a virtual NeedPush with the current localStorage value;
// - receiveConfigSyncMtime confirms the baseline for a virtual path without touching the adapter.
const root = path.resolve(import.meta.dirname, "..");
const noop = () => undefined;

function loadModule(relPath, requireStub, globals = {}) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    require: requireStub, module, exports: module.exports, console, Map, Set, Date, Promise, Array,
    TextDecoder, TextEncoder, Uint8Array, ArrayBuffer,
    window: { setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {} } },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: noop,
    ...globals,
  });
  return module.exports;
}

const helpers = new Proxy({
  hashContent: (s) => `p${s.length}`,
  hashContentAsync: async (s) => `h:${s}`,
  hashFileAsync: async () => "f",
  hashArrayBuffer: async () => "arr",
  dump: noop, dumpError: noop,
  isPathInConfigSyncDirs: (p) => p.startsWith("_localStorage/") || p.startsWith(".obsidian/"),
  configIsPathExcluded: () => false,
  normalizeServerTimestamp: (v) => v,
  checkAndNotifyCaseConflict: () => false,
  getSafeCtime: (s) => s?.ctime ?? 0,
  isLargeBinarySyncRisk: () => false,
  LocalStateFileMirror: class { constructor() {} async read() { return null; } scheduleWrite() {} },
  computeMirrorDigest: (s) => `digest:${s.length}`,
}, { get: (t, k) => t[k] ?? noop });

const { LocalStorageManager } = loadModule("src/lib/storage/local_storage_manager.ts", (id) => {
  if (id === "../utils/helpers") return helpers;
  if (id === "../sync/operator_config") return { configModify: async (...a) => { globalThis.__configModifyCalls?.push(a); } };
  if (id === "../../main") return {};
  throw new Error(`Unexpected require in local_storage_manager: ${id}`);
});

const operatorConfig = loadModule("src/lib/sync/operator_config.ts", (id) => {
  if (id === "obsidian") return { normalizePath: (p) => p, App: class {} };
  if (id === "../utils/helpers") return helpers;
  if (id === "../utils/config_codec") return { encodeConfigContent: (b) => String(b), decodeConfigContent: (s) => ({ kind: "text", text: s }) };
  if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } };
  if (id === "./sync_state") return { advanceLiveSyncTime: (plugin, field, lastTime) => { if (lastTime) plugin.advanced.push([field, lastTime]); } };
  if (id === "../utils/types") return {};
  if (id === "../../i18n/lang") return { $: (k) => k };
  if (id === "../storage/baseline_scope") return {
    buildBaselineFields: () => ({}), buildDeleteBaselineFields: () => ({}),
    baselineFieldsFromDeleteRecord: () => ({}),
  };
  if (id === "../../main") return {};
  if (id === "../utils/sync_diagnostics") return {};
  throw new Error(`Unexpected require in operator_config: ${id}`);
});

// ── getStorageConfigs baseline fields ────────────────────────────────────────
{
  const plugin = {
    settings: { pdfSyncEnabled: true },
    isSyncBaselineModeEnabled: () => true,
    configHashManager: {
      getConfirmedBaseline: (p, contentHash) => (p.endsWith("pdfjs.history") && contentHash === "p9" ? { hash: "p9", revision: "rev-1" } : null),
    },
  };
  const manager = new LocalStorageManager(plugin);
  manager.read = (key) => (key === "pdfjs.history" ? "confirmed" : null);
  const configs = await manager.getStorageConfigs();
  const entry = configs.find((c) => c.path === "_localStorage/pdfjs.history");
  assert.ok(entry, "the virtual config is listed");
  assert.equal(entry.baseHash, "p9");
  assert.equal(entry.baseRevision, "rev-1");
  assert.equal(entry.baseHashMissing, false);

  // Unconfirmed entry: explicit missing baseline, not the current value
  plugin.configHashManager.getConfirmedBaseline = () => null;
  manager.lastMtimes.clear();
  const unconfirmed = (await manager.getStorageConfigs()).find((c) => c.path === "_localStorage/pdfjs.history");
  assert.equal(unconfirmed.baseHashMissing, true);
  assert.equal(unconfirmed.baseHash, undefined, "the current value is never passed off as a baseline");
}

// ── receiveConfigUpload answers a virtual NeedPush ───────────────────────────
{
  const sent = [], completed = [], advanced = [];
  const plugin = {
    settings: { configSyncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    localStorageManager: {
      syncPathPrefix: "_localStorage/",
      pathToKey: (p) => p.slice("_localStorage/".length),
      getItemValue: (k) => (k === "pdfjs.history" ? "state" : null),
      savePending: noop, getMetadata: () => 0,
    },
    app: { vault: { adapter: { exists: async () => false } } },
    pendingConfigModifies: new Map(), pendingConfigDeleteAcks: new Set(), syncState: { pendingConfigPushPageIndex: new Map() },
    concurrencyLimiter: { waitForSlot: async () => true },
    websocket: { SendMessage: async (action, data) => { sent.push([action, data]); } },
    configSyncTasks: { failed: 0 }, recordSyncCompleted: (t, p) => completed.push([t, p]),
    configHashManager: { isReady: () => true, getPathHash: () => null, setFileHash: noop },
    lastSyncMtime: new Map(), configManager: null,
    ignoredConfigFiles: new Set(), addIgnoredConfigFile(p) { this.ignoredConfigFiles.add(p); }, removeIgnoredConfigFile(p) { this.ignoredConfigFiles.delete(p); },
    advanced,
  };
  await operatorConfig.receiveConfigUpload({ path: "_localStorage/pdfjs.history", pageIndex: 3 }, plugin);
  assert.equal(sent.length, 1, "a virtual NeedPush is answered");
  assert.equal(sent[0][0], "SettingModify");
  assert.equal(sent[0][1].content, "state", "the current localStorage value is uploaded");
  assert.equal(plugin.syncState.pendingConfigPushPageIndex.get("_localStorage/pdfjs.history"), 3, "the page is attributed for the ack");
}

// ── receiveConfigSyncMtime confirms the virtual baseline without adapter.exists ──
{
  const confirmed = [], advanced = [], completed = [];
  let adapterTouched = false;
  const plugin = {
    settings: { configSyncEnabled: true, vault: "v" },
    localStorageManager: {
      syncPathPrefix: "_localStorage/",
      pathToKey: (p) => p.slice("_localStorage/".length),
      getItemValue: (k) => (k === "pdfjs.history" ? "state" : null),
    },
    app: { vault: { adapter: { exists: async () => { adapterTouched = true; return false; } } } },
    configHashManager: { setConfirmedBaseline: (...a) => confirmed.push(a), setFileHash: (...a) => confirmed.push(a) },
    ignoredConfigFiles: new Set(), addIgnoredConfigFile(p) { this.ignoredConfigFiles.add(p); }, removeIgnoredConfigFile(p) { this.ignoredConfigFiles.delete(p); },
    configSyncTasks: { failed: 0 }, recordSyncCompleted: (t, p) => completed.push([t, p]),
    advanced,
  };
  await operatorConfig.receiveConfigSyncMtime(
    { path: "_localStorage/pdfjs.history", contentHash: "h:state", revision: "rev-2", mtime: 5, ctime: 1, lastTime: 9, pageIndex: 1 },
    plugin,
  );
  assert.equal(adapterTouched, false, "virtual paths never touch the disk adapter");
  assert.equal(confirmed.length, 1, "the virtual baseline is confirmed");
  assert.equal(confirmed[0][0], "_localStorage/pdfjs.history");
  assert.equal(confirmed[0][1], "h:state");
  assert.equal(confirmed[0][2], "rev-2");
  assert.deepEqual(completed, [["setting", 1]]);
  assert.deepEqual(advanced, [["lastConfigSyncTime", 9]]);
}

console.log("PASS: virtual _localStorage/ configs carry baseline fields, answer NeedPush and confirm mtime");
