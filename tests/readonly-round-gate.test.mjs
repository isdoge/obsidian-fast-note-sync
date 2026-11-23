// Round-bound receive gates (server NeedPush uploads + remote-delete local-edit checks) must OR
// the round's entry read-only snapshot with the live setting (fail-closed):
//   snapshot read-only, live writable  -> block
//   snapshot writable,   live read-only -> block
//   both writable                       -> normal upload
// Real handlers are loaded from source; only Obsidian, storage and network boundaries are stubbed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const noop = () => undefined;

function load(relPath, helpers, extra = {}) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Map, Set, WeakMap, WeakSet, Date, Promise,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
    window: { setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop },
    WebSocket: { OPEN: 1 },
    require: (id) => {
      if (id === "obsidian") return { normalizePath: (x) => x, TFile: class TFile {}, TFolder: class TFolder {}, Platform: { isMobile: false } };
      if (id.includes("helpers")) return helpers;
      if (id.includes("sync_log_manager")) return { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } };
      if (id.includes("i18n")) return { $: (key) => key };
      if (id.includes("baseline_scope")) return {
        buildBaselineFields: () => ({}), buildDeleteBaselineFields: () => ({}),
        baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope",
        parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }),
        serializeScopedState: (state) => JSON.stringify(state),
      };
      if (id.includes("config_codec")) return {
        encodeConfigContent: (buf) => new TextDecoder().decode(buf),
        decodeConfigContent: (s) => ({ kind: "text", text: s }),
      };
      if (id.includes("cloud_preview")) return { FileCloudPreview: { isRestrictedType: () => true } };
      if (id in extra) return extra[id];
      return {};
    },
  }, { filename: sourcePath });
  return module.exports;
}

function proxied(defaults) {
  return new Proxy({ ...defaults }, { get: (target, key) => target[key] ?? noop });
}

const scenarios = [
  { name: "snapshot read-only, live writable", snapshot: true, live: false, blocked: true },
  { name: "snapshot writable, live read-only", snapshot: false, live: true, blocked: true },
  { name: "both writable", snapshot: false, live: false, blocked: false },
  { name: "both read-only", snapshot: true, live: true, blocked: true },
];

// ── server NeedPush: note upload (operator_note.receiveNoteUpload) ─────────────
{
  for (const s of scenarios) {
    const note = load("src/lib/sync/operator_note.ts", proxied({
      hashContent: (x) => `p:${x}`, hashContentAsync: async () => "note-hash",
      getSafeCtime: (stat) => stat.ctime, isPathExcluded: () => false,
      normalizeServerTimestamp: (v) => v, getPluginDir: () => "",
    }), { "./sync_state": { advanceLiveSyncTime: noop } });
    const file = { path: "notes/a.md", stat: { mtime: 200, ctime: 1, size: 10 } };
    const sent = [], completed = [];
    const plugin = {
      syncRoundReadonly: s.snapshot,
      settings: { syncEnabled: true, readonlySyncEnabled: s.live, vault: "v", isShowNotice: false },
      app: { vault: { getFileByPath: () => file, read: async () => "content" } },
      fileHashManager: { getPathHash: () => "base", getValidHash: () => null, getVerifiedPathHash: () => "base" },
      localStorageManager: { getMetadata: () => 10, savePending: noop },
      pendingNoteModifies: new Map(),
      syncState: { pendingNotePushPageIndex: new Map(), conflictedPaths: new Set() },
      addIgnoredFile: noop, removeIgnoredFile: noop,
      concurrencyLimiter: { waitForSlot: async () => true },
      recordSyncCompleted: (type, page) => completed.push([type, page]),
      websocket: { SendMessage: async (action) => sent.push(action) },
      noteSyncTasks: { failed: 0 },
      isSyncBaselineModeEnabled: () => false,
    };
    await note.receiveNoteUpload({ path: file.path, pageIndex: 2 }, plugin);
    if (s.blocked) {
      assert.deepEqual(sent, [], `note upload blocked (${s.name})`);
      assert.deepEqual(completed, [["note", 2]], `note page still settled (${s.name})`);
      assert.equal(plugin.pendingNoteModifies.size, 0, `no pending baseline (${s.name})`);
    } else {
      assert.deepEqual(sent, ["NoteModify"], `note upload proceeds (${s.name})`);
      assert.equal(plugin.pendingNoteModifies.get(file.path), "note-hash", `pending hash recorded (${s.name})`);
    }
  }
}

// ── server NeedPush: file upload (operator_file.receiveFileUpload) ────────────
{
  for (const s of scenarios) {
    const fileOps = load("src/lib/sync/operator_file.ts", proxied({
      hashContent: (x) => `p:${x}`, hashFileAsync: async () => "file-hash",
      getSafeCtime: (stat) => stat.ctime, isPathExcluded: () => false,
      isLargeBinarySyncRisk: () => false, describeBinarySyncLimit: () => "100MB",
      normalizeServerTimestamp: (v) => v, getPluginDir: () => "",
    }), { "./sync_state": { advanceLiveSyncTime: noop } });
    const file = { path: "img/a.png", stat: { size: 4, mtime: 100, ctime: 1 } };
    const completed = [];
    const plugin = {
      syncRoundReadonly: s.snapshot,
      settings: { syncEnabled: true, readonlySyncEnabled: s.live, vault: "v" },
      app: {
        vault: { getFileByPath: () => file, getName: () => "v", readBinary: async () => new ArrayBuffer(4) },
        loadLocalStorage: noop, saveLocalStorage: noop,
      },
      syncState: { pendingFilePushPageIndex: new Map(), completedFileUploadSessions: new Set(), activeSyncContext: "ctx" },
      pendingUploadHashes: new Map(),
      localStorageManager: { savePending: noop },
      fileHashManager: { setFileHashes: noop },
      // no free slot: the accepted upload stops right after the gate, so this test stays synchronous
      concurrencyLimiter: { waitForSlot: async () => false, releaseSlot: noop },
      recordSyncCompleted: (type, page) => completed.push([type, page]),
      fileSyncTasks: { failed: 0 },
      totalChunksToUpload: 0,
      websocket: { SendMessage: async () => "sent" },
    };
    await fileOps.receiveFileUpload(
      { path: file.path, pathHash: "p:img/a.png", sessionId: "s1", pageIndex: 4, chunkSize: 2 }, plugin);
    await new Promise(setImmediate);
    if (s.blocked) {
      assert.deepEqual(completed, [["file", 4]], `file upload blocked (${s.name})`);
      assert.equal(plugin.syncState.pendingFilePushPageIndex.size, 0, `no page recorded (${s.name})`);
      assert.equal(plugin.pendingUploadHashes.size, 0, `no pending upload hash (${s.name})`);
    } else {
      assert.deepEqual(completed, [], `file upload proceeds (${s.name})`);
      assert.equal(plugin.syncState.pendingFilePushPageIndex.has(file.path), true, `page recorded (${s.name})`);
    }
  }
}

// ── server NeedPush: config upload (operator_config.receiveConfigUpload) ──────
{
  for (const s of scenarios) {
    const configOps = load("src/lib/sync/operator_config.ts", proxied({
      hashContent: (x) => `p:${x}`, hashFileAsync: async () => "config-hash",
      configIsPathExcluded: () => false, isPathInConfigSyncDirs: () => true,
      getSafeCtime: (stat) => stat.ctime, isLargeBinarySyncRisk: () => false,
      normalizeServerTimestamp: (v) => v,
    }), { "./sync_state": { advanceLiveSyncTime: noop } });
    const sent = [], completed = [];
    const plugin = {
      syncRoundReadonly: s.snapshot,
      settings: { configSyncEnabled: true, readonlySyncEnabled: s.live, vault: "v" },
      app: {
        vault: {
          adapter: {
            exists: async () => true,
            stat: async () => ({ mtime: 5, ctime: 1, size: 2 }),
            readBinary: async () => new TextEncoder().encode("{}").buffer,
          },
        },
      },
      localStorageManager: { syncPathPrefix: "__ls__/", savePending: noop },
      pendingConfigModifies: new Map(), pendingConfigDeleteAcks: new Set(),
      configHashManager: { getPathHash: () => null }, lastSyncMtime: new Map(),
      syncState: { pendingConfigPushPageIndex: new Map(), conflictedPaths: new Set() },
      addIgnoredConfigFile: noop, removeIgnoredConfigFile: noop,
      concurrencyLimiter: { waitForSlot: async () => true },
      recordSyncCompleted: (type, page) => completed.push([type, page]),
      websocket: { SendMessage: async (action) => sent.push(action) },
      configSyncTasks: { failed: 0 },
    };
    await configOps.receiveConfigUpload({ path: ".obsidian/app.json", pageIndex: 6 }, plugin);
    if (s.blocked) {
      assert.deepEqual(sent, [], `config upload blocked (${s.name})`);
      assert.deepEqual(completed, [["setting", 6]], `config page still settled (${s.name})`);
      assert.equal(plugin.pendingConfigModifies.size, 0, `no pending config baseline (${s.name})`);
    } else {
      assert.deepEqual(sent, ["SettingModify"], `config upload proceeds (${s.name})`);
      assert.equal(plugin.pendingConfigModifies.get(".obsidian/app.json"), "config-hash", `pending hash recorded (${s.name})`);
    }
  }
}

console.log("read-only round gate tests passed");
