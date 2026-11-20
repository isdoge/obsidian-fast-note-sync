import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// haierkeys/fast-note-sync-service#512: with cloud preview on, attachments are left out of the
// regular scan, so the post-sync check is the only path that uploads what was created or edited
// while the server was unreachable. The server answers /api/file/info for a missing attachment
// with HTTP 200 + code 0 ("record not found"); the check must treat that as "upload it", and must
// also upload a local copy that is newer than the version the server already has.
// The local copy may only be removed ("delete after upload") once the server holds this content,
// and the sync baseline is only recorded on FileUploadAck.
const root = path.resolve(import.meta.dirname, "..");
class TFile { constructor(p, mtime, size = 3) { this.path = p; this.extension = p.split(".").pop(); this.stat = { size, mtime, ctime: 1 }; } }
const noop = () => undefined;
const server = new Map(); // path -> response json, or an Error
const localHash = new Map();
const vaultDeleted = [];
const helpers = new Proxy({
  isPathExcluded: () => false,
  isLargeBinarySyncRisk: () => false,
  hashContent: s => `p:${s}`,
  hashFileAsync: async (_app, p) => localHash.get(p),
  getSafeCtime: stat => stat.ctime,
  normalizeServerTimestamp: ts => ts === undefined ? undefined : (ts > 0 && ts < 100_000_000_000 ? ts * 1000 : ts),
  addRandomParam: url => url,
  sleep: async () => undefined,
  vaultDelete: async (_vault, f) => { vaultDeleted.push(f.path); },
}, { get: (target, name) => target[name] ?? noop });
function load(rel, modules = {}) {
  const source = fs.readFileSync(path.join(root, rel), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Map, Set, WeakMap, URLSearchParams, TextEncoder,
    window: { setTimeout: () => 1, clearTimeout: noop },
    require(id) {
      if (id.includes("baseline_scope")) return { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) };
    if (id.includes("conflict_store")) return { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" };
          if (id in modules) return modules[id];
      if (id === "obsidian") return {
        TFile, normalizePath: p => p, Platform: { isMobile: false },
        requestUrl: async ({ url }) => {
          const answer = server.get(new URL(url).searchParams.get("path"));
          if (answer instanceof Error) throw answer;
          return { status: 200, json: answer };
        },
      };
      if (id === "../utils/helpers") return helpers;
      if (id === "../utils/types") return { CLIENT_TYPE: "test" };
      if (id === "./remote_path_guard") return { blockAliasedRemoteMutation: () => false };
      if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } };
      if (id === "./sync_state") return { advanceLiveSyncTime: (plugin, field, lastTime) => { if (lastTime && lastTime > Number(plugin.localStorageManager.getMetadata(field))) plugin.localStorageManager.setMetadata(field, lastTime); } };
      if (id === "../storage/file_cloud_preview") return { FileCloudPreview: { isRestrictedType: () => true } };
      if (id === "../../i18n/lang") return { $: key => key, getLocale: () => "en" };
      return {};
    },
  });
  return module.exports;
}
const ops = load("src/lib/sync/operator_file.ts", { "../api/http_api_service": load("src/lib/api/http_api_service.ts") });

const found = (p, mtime, contentHash, size = 3) => ({ code: 1, status: true, data: { path: p, pathHash: `p:${p}`, size, mtime, contentHash } });
const notFound = { code: 0, status: false, message: "Failed", details: "record not found" };

function fixture(files, baselines = {}) {
  const sent = [];
  const cache = new Map(), base = new Map(Object.entries(baselines));
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v", api: "http://server", networkLibrary: "requestUrl",
      cloudPreviewEnabled: true, cloudPreviewTypeRestricted: true, cloudPreviewAutoDeleteLocal: false },
    runApi: "http://server", manifest: { version: "0" }, getClientName: () => "test",
    app: { vault: { getFiles: () => files, getFileByPath: p => files.find(f => f.path === p) ?? null, getName: () => "v",
      readBinary: async () => new Uint8Array([1, 2, 3]).buffer }, loadLocalStorage: noop, saveLocalStorage: noop },
    lockManager: { withLock: async (_, fn) => fn() },
    websocket: { isOpen: true, SendMessage: async (action, data) => sent.push([action, data.path]),
      SendBinary: async (_frame, _prefix, before, after) => { if (before()) return "cancelled"; after(); return "sent"; } },
    fileHashManager: {
      getPathHash: p => base.get(p) ?? null,
      getValidHash: (p, mtime, size) => { const c = cache.get(p); return c && c.mtime === mtime && c.size === size ? c.hash : null; },
      setFileHash(p, hash, mtime = 0, size = 0) { cache.set(p, { hash, mtime, size }); base.set(p, hash); },
      setFileHashes(entries, getStat) { for (const [p, hash] of entries) cache.set(p, { hash, mtime: getStat?.(p)?.mtime ?? 0, size: getStat?.(p)?.size ?? 0 }); },
      removeFileHash(p) { cache.delete(p); base.delete(p); },
    },
    pendingUploadHashes: new Map(), pendingFileDeleteAcks: new Set(), lastSyncMtime: new Map(),
    localStorageManager: { getMetadata: () => 0, setMetadata: noop, savePending: noop },
    concurrencyLimiter: { waitForSlot: async () => true, releaseSlot: noop, touch: noop },
    syncState: { activeSyncContext: null, pendingFilePushPageIndex: new Map() },
    isIgnoredFile: () => false, addIgnoredFile: noop, removeIgnoredFile: noop,
    fileSyncTasks: { failed: 0 }, totalChunksToUpload: 0, uploadedChunksCount: 0, recordSyncCompleted: noop,
  };
  return { plugin, sent };
}
const flush = async () => { for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r)); };

// 1. Post-sync check after the server was unreachable
{
  const files = [
    new TFile("new.png", 2e12),          // created offline: the server has no record
    new TFile("edited.png", 2e12),       // edited offline: the server has the old version
    new TFile("remote-newer.png", 2e12), // another device uploaded a newer version
    new TFile("same.png", 2e12),         // unchanged
    new TFile("touched.png", 2e12),      // only the mtime moved, content equals the baseline (#256)
    new TFile("unreachable.png", 2e12),  // the info request failed
    new TFile("note.md", 2e12),
  ];
  for (const f of files) localHash.set(f.path, "new");
  localHash.set("touched.png", "old");
  server.set("new.png", notFound);
  server.set("edited.png", found("edited.png", 1e12, "old"));
  server.set("remote-newer.png", found("remote-newer.png", 3e12, "remote"));
  server.set("same.png", found("same.png", 2e12, "new"));
  server.set("touched.png", found("touched.png", 1e12, "old"));
  server.set("unreachable.png", new Error("net::ERR_CONNECTION_REFUSED"));
  const f = fixture(files, { "edited.png": "old", "remote-newer.png": "new", "same.png": "new", "touched.png": "old" });
  await ops.checkAndUploadAttachments(f.plugin);
  await flush();
  assert.deepEqual(f.sent, [["FileUploadCheck", "new.png"], ["FileUploadCheck", "edited.png"]],
    "attachments created or edited offline are uploaded; newer remote, unchanged, touched-only and unknown ones are not");
  ops.clearUploadQueue();
}

// 2. Upload: the baseline is recorded on the ack, not when the upload starts; "delete after upload"
// needs the server to hold this content, a record with the same size and mtime is not enough
for (const [serverHash, deleted] of [["other-content", []], ["new", ["shot.png"]]]) {
  vaultDeleted.length = 0;
  const file = new TFile("shot.png", 2e12);
  localHash.set("shot.png", "new");
  server.set("shot.png", found("shot.png", 2e12, serverHash));
  const f = fixture([file]);
  f.plugin.settings.cloudPreviewAutoDeleteLocal = true;
  await ops.receiveFileUpload({ path: "shot.png", pathHash: "p:shot.png", sessionId: "s".repeat(36), chunkSize: 1024 }, f.plugin);
  await flush();
  assert.deepEqual(vaultDeleted, deleted, `server content ${serverHash}: local copy ${deleted.length ? "removed" : "kept"}`);
  if (!deleted.length) {
    assert.equal(f.plugin.fileHashManager.getPathHash("shot.png"), null, "no baseline before the server acknowledged the upload");
    ops.receiveFileUploadAck({ path: "shot.png", pathHash: "p:shot.png" }, f.plugin);
    assert.equal(f.plugin.fileHashManager.getPathHash("shot.png"), "new", "the ack records the baseline");
  }
  ops.clearUploadQueue();
}
console.log("PASS: cloud preview uploads offline attachment changes after reconnect; baseline and local delete wait for the server");
