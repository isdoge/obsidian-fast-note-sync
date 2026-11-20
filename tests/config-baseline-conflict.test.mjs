import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Stage E / #217: a setting conflict (plain .obsidian/*.json or a _localStorage/ virtual config) is
// stored as a unified conflict instead of being silently overwritten; uploads for the path pause,
// the remote body and a real (possibly empty) base are kept for the resolver, and choosing local
// performs a conditional submit with isConflictResolved + the serverRevision the user saw.
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
    setTimeout, clearTimeout, queueMicrotask, Promise, Map, Set, JSON, TextEncoder, TextDecoder, Date,
    ...extraGlobals,
  });
  return module.exports;
}
const noop = () => undefined;
const helpers = {
  dump: noop, dumpError: noop, showSyncNotice: noop,
  hashContent: (s) => `h:${s}`, hashContentAsync: async (s) => `h:${s}`,
  isPathExcluded: () => false, isPathInConfigSyncDirs: () => true, configIsPathExcluded: () => false,
  isInWhitelist: () => false, getSafeCtime: (s) => s.ctime ?? 1, normalizeServerTimestamp: (v) => v,
  isLargeBinarySyncRisk: () => false, checkAndNotifyCaseConflict: () => false,
  hashFileAsync: async () => "h:disk", hashArrayBuffer: async () => "h:disk",
  computeMirrorDigest: (data) => `${data.length}:${data}`,
};
const baselineScope = loadModule("src/lib/storage/baseline_scope.ts", (id) => {
  if (id === "../utils/helpers") return helpers;
  throw new Error(`Unexpected require in baseline_scope: ${id}`);
});

// ── in-memory conflict-notes store used by conflict_store via operator_note ──
const backupFiles = new Map();
const metaFiles = new Map();
const conflictBackupPaths = (_plugin, p) => {
  const hash = `p${p.length}`;
  return {
    dir: ".plugin/conflict-notes",
    safeName: p,
    pathHash: hash,
    baseBackupPath: `.base:${p}`,
    remoteBackupPath: `.remote:${p}`,
    metaPath: `.meta:${p}`,
    localBackupPath: `.local:${p}`,
  };
};
const operatorNoteStub = {
  conflictBackupPaths,
  readConflictMeta: async (_p, p) => (metaFiles.has(p) ? JSON.parse(metaFiles.get(p)) : null),
  writeConflictMeta: async (_p, p, meta) => { metaFiles.set(p, JSON.stringify(meta)); },
  removeConflictBackups: async (_p, p) => { backupFiles.delete(`.base:${p}`); backupFiles.delete(`.remote:${p}`); metaFiles.delete(p); },
  noteDeleteByPath: async () => undefined,
  noteModify: async () => undefined,
};

const adapter = {
  exists: async (p) => backupFiles.has(p),
  read: async (p) => backupFiles.get(p) ?? "",
  write: async (p, data) => { backupFiles.set(p, data); },
  remove: async (p) => { backupFiles.delete(p); },
  mkdir: async () => undefined,
  list: async () => ({ files: [], folders: [] }),
  rmdir: async () => undefined,
};
const makePlugin = () => ({
  settings: { vault: "v", configSyncEnabled: true, readonlySyncEnabled: false },
  app: { vault: { adapter, getAbstractFileByPath: () => null, getFileByPath: () => null } },
  syncState: {
    conflictedPaths: new Set(),
    newConflictedPathsThisRound: new Set(),
    conflictCountsThisRound: new Map(),
    pendingConfigPushPageIndex: new Map(),
  },
  localStorageManager: { setConflictedPaths: noop, savePending: noop, getMetadata: () => 0, syncPathPrefix: "_localStorage/" },
  statusBarManager: { updateConflictBadge: noop },
  pendingNoteModifies: new Map(), pendingUploadHashes: new Map(), pendingConfigModifies: new Map([["x.json", "h:local"]]),
  configHashManager: null,
});

const store = loadModule("src/lib/sync/conflict_store.ts", (id) => {
  if (id === "obsidian") return { normalizePath: (p) => p };
  if (id === "../utils/helpers") return helpers;
  if (id === "../utils/types") return {};
  if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: noop }) } };
  if (id === "../utils/config_codec") return { decodeConfigContent: (s) => ({ kind: "text", text: s }) };
  if (id === "./operator_file") return { clearUploadTrackingForConflict: noop };
  if (id === "./operator_note") return operatorNoteStub;
  if (id === "../../i18n/lang") return { $: (k) => k };
  if (id === "../../main") return {};
  throw new Error(`Unexpected require in conflict_store: ${id}`);
});

{
  const plugin = makePlugin();
  const stored = await store.storeSyncConflict(plugin, {
    kind: "setting",
    path: "x.json",
    pathHash: "p6",
    reason: "both_modified",
    serverHash: "h:remote",
    serverRevision: "rev-2",
    serverDeleted: false,
    baseHash: "h:base",
    baseMissing: false,
    baseContent: "BASE",
    serverContent: "REMOTE",
  });
  assert.equal(stored, true);
  assert.ok(plugin.syncState.conflictedPaths.has("x.json"), "conflict path is recorded");
  assert.equal(plugin.pendingConfigModifies.has("x.json"), false, "automatic retransmission is paused");
  assert.equal(plugin.syncState.conflictCountsThisRound.get("setting"), 1, "counted as a setting conflict");

  const meta = JSON.parse(metaFiles.get("x.json"));
  assert.equal(meta.kind, "setting");
  assert.equal(meta.reason, "both_modified");
  assert.equal(meta.serverRevision, "rev-2");
  assert.equal(backupFiles.get(".remote:x.json"), "REMOTE", "remote body stashed for the resolver");
  assert.equal(backupFiles.get(".base:x.json"), "BASE", "real base kept");

  // A real empty base is a valid ancestor; a missing base never fabricates one.
  await store.storeSyncConflict(plugin, {
    kind: "setting", path: "empty.json", pathHash: "p8", reason: "both_modified",
    serverHash: "0", serverRevision: "r0", baseHash: "0", baseMissing: false, baseContent: "", serverContent: "",
  });
  assert.equal(backupFiles.get(".base:empty.json"), "", "empty base is stored as an empty file");
  assert.equal(backupFiles.get(".remote:empty.json"), "", "empty remote content is a legal conflict value");
  assert.equal(JSON.parse(metaFiles.get("empty.json")).baseMissing, false);

  await store.storeSyncConflict(plugin, {
    kind: "setting", path: "missing.json", pathHash: "p9", reason: "no_baseline",
    serverHash: "h:r", serverRevision: "r1", baseHash: "", baseMissing: true, baseContent: "NOT-A-BASE", serverContent: "R",
  });
  assert.equal(backupFiles.has(".base:missing.json"), false, "missing base never fakes an ancestor");
  assert.equal(JSON.parse(metaFiles.get("missing.json")).baseMissing, true);
}

// ── local resolution is a conditional submit with the seen serverRevision ───
const configOps = loadModule("src/lib/sync/operator_config.ts", (id) => {
  if (id === "obsidian") return { normalizePath: (p) => p };
  if (id === "../utils/helpers") return helpers;
  if (id === "../storage/baseline_scope") return baselineScope;
  if (id === "../utils/config_codec") return { decodeConfigContent: (s) => ({ kind: "text", text: s }), encodeConfigContent: () => "" };
  if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } };
  if (id === "./sync_state") return { advanceLiveSyncTime: noop };
  if (id === "../utils/types") return {};
  if (id === "../../i18n/lang") return { $: (k) => k };
  if (id === "../../main") return {};
  throw new Error(`Unexpected require in operator_config: ${id}`);
});

{
  const sent = [];
  const manager = {
    hashes: new Map([["x.json", "h:local"]]), revisions: new Map([["x.json", "rev-2"]]), confirmed: new Set(["x.json"]),
    getPathHash(p) { return this.hashes.get(p) ?? null; },
    getVerifiedPathHash(p) { return this.hashes.get(p) ?? null; },
    getBaselineRevision(p) { return this.revisions.get(p) ?? null; },
    getConfirmedBaseline(p, local) { const h = this.getVerifiedPathHash(p, local); const r = this.revisions.get(p); return h && r ? { hash: h, revision: r } : null; },
    isBaselineConfirmed(p) { return this.confirmed.has(p) && this.revisions.has(p); },
  };
  const adapter2 = {
    exists: async () => true,
    stat: async () => ({ mtime: 5, ctime: 1, size: 4 }),
    readBinary: async () => new TextEncoder().encode("{ }").buffer,
    writeBinary: async () => undefined,
    write: async () => undefined,
    mkdir: async () => undefined,
  };
  const plugin = {
    settings: { configSyncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    app: { vault: { configDir: ".obsidian", adapter: adapter2 } },
    isSyncBaselineModeEnabled: () => true,
    ignoredConfigFiles: new Set(), addIgnoredConfigFile: noop, removeIgnoredConfigFile: noop,
    pendingConfigModifies: new Map(), pendingConfigDeleteAcks: new Set(), lastSyncMtime: new Map(),
    localStorageManager: { syncPathPrefix: "_localStorage/", savePending: noop },
    configHashManager: manager,
    concurrencyLimiter: { waitForSlot: async () => true },
    websocket: { SendMessage: (action, data) => sent.push([action, data]) },
    syncState: { pendingConfigPushPageIndex: new Map(), isSyncBaselineModeEnabled: () => true },
    configManager: null, configSyncTasks: { failed: 0 }, recordSyncCompleted: noop,
  };
  await configOps.configModify("x.json", plugin, true, undefined, true, { isConflictResolved: true, baseRevision: "rev-2" });
  const [, payload] = sent.find(([action]) => action === "SettingModify");
  assert.equal(payload.baseHash, "h:local");
  assert.equal(payload.baseRevision, "rev-2");
  assert.equal(payload.isConflictResolved, true, "local resolution marks the user's choice");
}

console.log("config-baseline-conflict.test.mjs: setting conflicts persisted, uploads paused, empty base and revision-preserving resolve passed");
